// TierPool Router — main.ts
// Satu server agregator model gratis dengan dua wajah klien (OpenAI Chat
// Completions dan Anthropic Messages) dan satu jalur upstream (gateway
// Chat Completions). Strategi khas entri ini:
//
//   * Pool bertier — model layak dibagi ke gelang rating (>=1300, 1200-1299,
//     sisanya). Gelang atas dihabiskan dulu; di dalam gelang, urutan rating
//     tertinggi dulu tetapi titik awalnya berputar round-robin per request.
//   * Cooldown per model — model yang ditolak gateway (429/5xx/jaringan)
//     diistirahatkan selama beberapa request berikutnya dan tidak didial
//     selama masa itu; urutan dial melompatinya dan turun gelang bila perlu.
//   * Jejak failover — setiap penolakan yang berhasil dipulihkan dilaporkan
//     lewat header x-makefun-upstream-failures pada respons final.
//
// Semua keputusan hanya fungsi dari brief, urutan request, dan jawaban
// gateway: tidak ada jam dinding dan tidak ada acak, jadi putaran ulang
// (replay) menghasilkan jejak yang sama.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  catalogFromPool,
  dialOrder,
  isDict,
  loadPool,
  type CatalogDoc,
  type Dict,
  type NeedFlags,
  type PoolModel,
} from './lib/catalog.ts';

// --------------------------------------------------------------- konfigurasi

const PROTO_VER = 1;
const POLL_MS = 100;
const BODY_CAP = 8 * 1024 * 1024;
const TRIES_PER_PROMPT = 8; // selaras batas 8 baris header jejak failover
const DIAL_TIMEOUT_MS = 25_000; // klien env menunggu 30 dtk; jangan menggantung
const DEFAULT_MAX_TOKENS = 1024;

const ENV_BASE = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const BRIEF_PATH = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GW_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GW_KEY = process.env.OPENAI_API_KEY ?? '';

// Brief dibaca sekali di awal; katalog dibangun sekali dan objek yang sama
// dipakai untuk --list maupun register, jadi keduanya identik byte per byte.
const { pool, problem: briefProblem } = loadPool(BRIEF_PATH);
const catalog: CatalogDoc = catalogFromPool(pool);
const catalogText = JSON.stringify(catalog);

function note(msg: string): void {
  process.stderr.write(`tierpool: ${msg}\n`);
}

// ------------------------------------------------------------- status routing
// requestSeq: nomor urut request penyelesaian yang sedang dilayani (0,1,2,...).
// restUntil: model -> nomor urut request pertama di mana model boleh didial
// lagi. Keduanya bilangan bulat dari urutan request, bukan jam — deterministik.

let requestSeq = 0;
const restUntil = new Map<string, number>();
const laneSpin = new Map<number, number>();
const failuresOfThisPrompt: Array<{ status: number; code: string; model: string | null }> = [];

function isResting(modelId: string, seq: number): boolean {
  return (restUntil.get(modelId) ?? -1) > seq;
}

/** Lama istirahat (dalam satuan request) sesudah satu penolakan, versi dasar. */
function restLength(status: number): number {
  if (status === 429) return 3; // limit: istirahat paling lama
  if (status === 0) return 2; // jaringan putus
  if (status >= 500) return 2;
  return 1;
}

function putToRest(modelId: string, status: number, seq: number): void {
  restUntil.set(modelId, seq + restLength(status) + 1);
  failuresOfThisPrompt.push({
    status,
    code: 'upstream_refused',
    model: modelId,
  });
}

function failuresHeader(): Record<string, string> {
  if (failuresOfThisPrompt.length === 0) return {};
  const rows = failuresOfThisPrompt.slice(0, 8).map((f) => ({ status: f.status, code: f.code, model: f.model }));
  return { 'x-makefun-upstream-failures': JSON.stringify(rows) };
}

// ------------------------------------------------------------ kebutuhan body

/** Kebutuhan dari body OpenAI: tools terdeklarasi dan response_format JSON. */
function needFromOpenAI(body: Dict): NeedFlags {
  let vision = false;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isDict(msg) || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (isDict(part) && (part.type === 'image_url' || part.type === 'image')) vision = true;
      }
    }
  }
  const fmt = isDict(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: fmt === 'json_object' || fmt === 'json_schema',
  };
}

/** Kebutuhan dari body Anthropic: tools terdeklarasi dan blok gambar. */
function needFromAnthropic(body: Dict): NeedFlags {
  let vision = false;
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!isDict(msg) || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (isDict(block) && block.type === 'image') vision = true;
      }
    }
  }
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: false, // wire Anthropic tidak punya response_format
  };
}

// ------------------------------------------------------------------ gateway

function gatewayChatUrl(): string {
  if (!GW_BASE) return '';
  return GW_BASE.endsWith('/v1') ? `${GW_BASE}/chat/completions` : `${GW_BASE}/v1/chat/completions`;
}

/** Kode singkat dari body error gateway, untuk jejak failover. */
function codeFromErrorText(text: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isDict(parsed)) {
      if (isDict(parsed.error) && typeof parsed.error.code === 'string' && parsed.error.code) return parsed.error.code;
      if (typeof parsed.code === 'string' && parsed.code) return parsed.code;
      if (isDict(parsed.error) && typeof parsed.error.type === 'string' && parsed.error.type) return parsed.error.type;
    }
  } catch {
    // body bukan JSON: pakai kode generik di bawah
  }
  return `http_${status}`;
}

interface DialOutcome {
  ok: boolean;
  modelId: string;
  response: Response | null;
}

/**
 * Mencoba model-model dalam urutan tierpool sampai satu menjawab 2xx.
 * Mengembalikan respons sukses yang bodynya BELUM dibaca (pemanggil yang
 * memutuskan JSON vs SSE), atau outcome gagal bila semua kandidat habis.
 */
async function dialWithFailover(
  need: NeedFlags,
  seq: number,
  makeBody: (modelId: string) => Dict,
  wantsStream: boolean,
): Promise<DialOutcome> {
  const ranked = dialOrder(pool, need, laneSpin);
  // Majukan putaran round-robin tiap gelang sekali untuk request ini.
  const bandsSeen = new Set(ranked.map((m) => (m.ratingMilli >= 1300 ? 0 : m.ratingMilli >= 1200 ? 1 : 2)));
  for (const b of bandsSeen) laneSpin.set(b, (laneSpin.get(b) ?? 0) + 1);

  const awake = ranked.filter((m) => !isResting(m.dialId, seq));
  // Bila semua layak sedang istirahat, pakai urutan penuh: yang paling cepat
  // bangun didial duluan (restUntil terkecil), selebihnya urutan tierpool.
  const queue = awake.length > 0
    ? awake
    : [...ranked].sort((a, b) => (restUntil.get(a.dialId) ?? -1) - (restUntil.get(b.dialId) ?? -1));

  let last: DialOutcome = { ok: false, modelId: '', response: null };
  let tries = 0;
  for (const candidate of queue) {
    if (tries >= TRIES_PER_PROMPT) break;
    tries++;
    let resp: Response;
    try {
      resp = await fetch(gatewayChatUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${GW_KEY}`,
          ...(wantsStream ? { accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(makeBody(candidate.dialId)),
        signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
      });
    } catch {
      // Jaringan/timeout: catat sebagai status 0 dan lanjut ke model berikut.
      restUntil.set(candidate.dialId, seq + restLength(0) + 1);
      failuresOfThisPrompt.push({ status: 0, code: 'network_error', model: candidate.dialId });
      last = { ok: false, modelId: candidate.dialId, response: null };
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      restUntil.set(candidate.dialId, seq + restLength(resp.status) + 1);
      failuresOfThisPrompt.push({ status: resp.status, code: codeFromErrorText(text, resp.status), model: candidate.dialId });
      last = { ok: false, modelId: candidate.dialId, response: null };
      continue;
    }
    restUntil.delete(candidate.dialId); // sukses: model segar lagi
    return { ok: true, modelId: candidate.dialId, response: resp };
  }
  return last;
}

// ------------------------------------------------------- terjemahan Anthropic
// Gateway hanya bicara Chat Completions, jadi request /v1/messages diterjemahkan
// ke body OpenAI dan jawabannya diterjemahkan balik, streaming maupun tidak.

function plainText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (isDict(b) && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = plainText(content);
    return t !== '' ? t : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** Body Messages -> body Chat Completions yang menyebut `modelId`. */
function toChatBody(src: Dict, modelId: string): Dict {
  const msgs: Dict[] = [];
  const sys = plainText(src.system);
  if (sys !== '') msgs.push({ role: 'system', content: sys });

  const list = Array.isArray(src.messages) ? src.messages : [];
  for (const raw of list) {
    if (!isDict(raw)) continue;
    const isAssistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      msgs.push({ role: isAssistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (isAssistant) {
      const calls: Dict[] = [];
      for (const block of content) {
        if (!isDict(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isDict(block.input) ? block.input : {}),
          },
        });
      }
      const txt = plainText(content);
      msgs.push({
        role: 'assistant',
        content: txt !== '' ? txt : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const parts: Dict[] = [];
    for (const block of content) {
      if (!isDict(block)) continue;
      if (block.type === 'tool_result') {
        msgs.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: resultText(block.content),
        });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isDict(block.source)) {
        const s = block.source;
        if (s.type === 'base64' && typeof s.data === 'string') {
          const media = typeof s.media_type === 'string' ? s.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${s.data}` } });
        } else if (s.type === 'url' && typeof s.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: s.url } });
        }
      }
    }
    if (parts.length > 0) msgs.push({ role: 'user', content: parts });
  }

  const out: Dict = {
    model: modelId,
    messages: msgs,
    max_tokens: typeof src.max_tokens === 'number' ? src.max_tokens : DEFAULT_MAX_TOKENS,
  };
  if (typeof src.temperature === 'number') out.temperature = src.temperature;
  if (typeof src.top_p === 'number') out.top_p = src.top_p;
  if (Array.isArray(src.stop_sequences) && src.stop_sequences.length > 0) out.stop = src.stop_sequences;
  if (Array.isArray(src.tools)) {
    const tools: Dict[] = [];
    for (const t of src.tools) {
      if (!isDict(t) || typeof t.name !== 'string') continue;
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters: isDict(t.input_schema) ? t.input_schema : { type: 'object', properties: {} },
        },
      });
    }
    if (tools.length > 0) out.tools = tools;
  }
  if (isDict(src.tool_choice)) {
    const tc = src.tool_choice;
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && typeof tc.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }
  if (src.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

function num0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function anthStop(finish: unknown): string {
  switch (finish) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function parseArgs(v: unknown): Dict {
  if (isDict(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const p: unknown = JSON.parse(v);
      if (isDict(p)) return p;
    } catch {
      // argumen bukan JSON: input kosong
    }
  }
  return {};
}

/** Jawaban Chat Completions (JSON) -> objek Messages. */
function toAnthropicBody(chat: Dict, modelId: string): Dict {
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  const first = isDict(choices[0]) ? choices[0] : {};
  const msg = isDict(first.message) ? first.message : {};
  const blocks: Dict[] = [];
  const txt = typeof msg.content === 'string' ? msg.content : plainText(msg.content);
  if (txt !== '') blocks.push({ type: 'text', text: txt });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const call of calls) {
    if (!isDict(call) || !isDict(call.function)) continue;
    blocks.push({
      type: 'tool_use',
      id: typeof call.id === 'string' && call.id !== '' ? call.id : 'toolu_tierpool',
      name: typeof call.function.name === 'string' ? call.function.name : '',
      input: parseArgs(call.function.arguments),
    });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  const usage = isDict(chat.usage) ? chat.usage : {};
  return {
    id: `msg_${typeof chat.id === 'string' && chat.id !== '' ? chat.id : 'tierpool'}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content: blocks,
    stop_reason: anthStop(first.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: num0(usage.prompt_tokens), output_tokens: num0(usage.completion_tokens) },
  };
}

// --------------------------------------------------------------------- SSE

/** Pecah stream byte upstream menjadi frame SSE utuh (pemisah baris kosong). */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let cut = buf.indexOf('\n\n');
      while (cut !== -1) {
        yield buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        cut = buf.indexOf('\n\n');
      }
    }
    buf += decoder.decode();
    if (buf.trim() !== '') yield buf;
  } finally {
    reader.releaseLock();
  }
}

function sseLine(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** Relay stream OpenAI apa adanya, hanya field model tiap chunk diganti id yang didial. */
async function relayOpenAIStream(body: ReadableStream<Uint8Array>, modelId: string, res: ServerResponse): Promise<void> {
  for await (const frame of sseFrames(body)) {
    const lines = frame.split('\n').map((line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return line;
      const payload = t.slice(5).trim();
      if (payload === '' || payload === '[DONE]') return line;
      try {
        const chunk: unknown = JSON.parse(payload);
        if (isDict(chunk)) return `data: ${JSON.stringify({ ...chunk, model: modelId })}`;
      } catch {
        // bukan JSON: teruskan apa adanya
      }
      return line;
    });
    res.write(`${lines.join('\n')}\n\n`);
  }
}

/** Ubah stream Chat Completions menjadi urutan event Messages. */
async function relayAnthropicStream(body: ReadableStream<Uint8Array>, modelId: string, res: ServerResponse): Promise<void> {
  let begun = false;
  let closed = false;
  let openText = -1;
  let nextBlock = 0;
  const toolBlocks = new Map<number, number>();
  let heldStop: string | null = null;
  let inTok = 0;
  let outTok = 0;

  const begin = (): void => {
    if (begun) return;
    begun = true;
    res.write(
      sseLine('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_tierpool_stream',
          type: 'message',
          role: 'assistant',
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inTok, output_tokens: 0 },
        },
      }),
    );
  };
  const sealBlocks = (): void => {
    if (openText !== -1) {
      res.write(sseLine('content_block_stop', { type: 'content_block_stop', index: openText }));
      openText = -1;
    }
    const idxs = [...toolBlocks.values()].sort((a, b) => a - b);
    for (const ix of idxs) res.write(sseLine('content_block_stop', { type: 'content_block_stop', index: ix }));
    toolBlocks.clear();
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    begin();
    sealBlocks();
    res.write(
      sseLine('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: heldStop ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: outTok },
      }),
    );
    res.write(sseLine('message_stop', { type: 'message_stop' }));
  };

  for await (const frame of sseFrames(body)) {
    for (const line of frame.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') {
        finish();
        continue;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isDict(chunk)) continue;
      if (isDict(chunk.usage)) {
        inTok = num0(chunk.usage.prompt_tokens);
        outTok = num0(chunk.usage.completion_tokens);
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isDict(choices[0]) ? choices[0] : null;
      if (choice === null) continue;
      begin();
      const delta = isDict(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (openText === -1) {
          openText = nextBlock++;
          res.write(
            sseLine('content_block_start', {
              type: 'content_block_start',
              index: openText,
              content_block: { type: 'text', text: '' },
            }),
          );
        }
        res.write(
          sseLine('content_block_delta', {
            type: 'content_block_delta',
            index: openText,
            delta: { type: 'text_delta', text: delta.content },
          }),
        );
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls) {
        if (!isDict(call)) continue;
        const upIx = typeof call.index === 'number' ? call.index : toolBlocks.size;
        let ix = toolBlocks.get(upIx);
        if (ix === undefined) {
          if (openText !== -1) {
            res.write(sseLine('content_block_stop', { type: 'content_block_stop', index: openText }));
            openText = -1;
          }
          ix = nextBlock++;
          toolBlocks.set(upIx, ix);
          const fn = isDict(call.function) ? call.function : {};
          res.write(
            sseLine('content_block_start', {
              type: 'content_block_start',
              index: ix,
              content_block: {
                type: 'tool_use',
                id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${ix}`,
                name: typeof fn.name === 'string' ? fn.name : '',
                input: {},
              },
            }),
          );
        }
        const fn = isDict(call.function) ? call.function : {};
        if (typeof fn.arguments === 'string' && fn.arguments !== '') {
          res.write(
            sseLine('content_block_delta', {
              type: 'content_block_delta',
              index: ix,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            }),
          );
        }
      }
      // stop_reason ditahan sampai chunk usage/[DONE]: message_delta membawanya.
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        heldStop = anthStop(choice.finish_reason);
      }
    }
  }
  finish();
}

// --------------------------------------------------------------- HTTP server

async function readBodyJson(req: IncomingMessage): Promise<Dict | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > BODY_CAP) return null;
    chunks.push(b);
  }
  if (chunks.length === 0) return null;
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isDict(v) ? v : null;
  } catch {
    return null;
  }
}

function replyJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

function replyError(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  status: number,
  type: string,
  message: string,
  extra: Record<string, string> = {},
): void {
  if (wire === 'anthropic') {
    replyJson(res, status, { type: 'error', error: { type, message } }, extra);
  } else {
    replyJson(res, status, { error: { message, type, code: null } }, extra);
  }
}

// Stempel waktu tetap untuk daftar model: membaca jam akan membuat jawaban
// berbeda antar putaran dan merusak determinisme replay.
const LIST_CREATED = 1735689600;
const LIST_CREATED_AT = '2025-01-01T00:00:00Z';

function handleModels(req: IncomingMessage, res: ServerResponse): void {
  if (typeof req.headers['x-api-key'] === 'string') {
    replyJson(res, 200, {
      data: pool.map((m) => ({ type: 'model', id: m.dialId, display_name: m.label, created_at: LIST_CREATED_AT })),
      has_more: false,
    });
  } else {
    replyJson(res, 200, {
      object: 'list',
      data: pool.map((m) => ({ id: m.dialId, object: 'model', created: LIST_CREATED, owned_by: 'openrouter' })),
    });
  }
}

/** Pastikan body upstream selalu punya cap output; gateway menolak yang tidak. */
function withCap(body: Dict): Dict {
  if (typeof body.max_tokens === 'number' || typeof body.max_completion_tokens === 'number') return body;
  return { ...body, max_tokens: DEFAULT_MAX_TOKENS };
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBodyJson(req);
  if (body === null) {
    return replyError(res, 'openai', 400, 'invalid_request_error', 'body bukan satu objek JSON');
  }
  const seq = requestSeq++;
  failuresOfThisPrompt.length = 0;
  const wantStream = body.stream === true;
  const outcome = await dialWithFailover(
    needFromOpenAI(body),
    seq,
    (modelId) => {
      const b = withCap({ ...body, model: modelId });
      if (wantStream && !isDict(b.stream_options)) b.stream_options = { include_usage: true };
      return b;
    },
    wantStream,
  );
  if (!outcome.ok || outcome.response === null) {
    return replyError(res, 'openai', 502, 'upstream_error', 'semua model gratis layak menolak atau gagal', failuresHeader());
  }
  const upstream = outcome.response;
  if (wantStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...failuresHeader(),
    });
    try {
      if (upstream.body !== null) await relayOpenAIStream(upstream.body, outcome.modelId, res);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json().catch(() => null);
  if (!isDict(answer)) {
    return replyError(res, 'openai', 502, 'upstream_error', 'jawaban gateway bukan JSON', failuresHeader());
  }
  replyJson(res, 200, { ...answer, model: outcome.modelId }, failuresHeader());
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBodyJson(req);
  if (body === null) {
    return replyError(res, 'anthropic', 400, 'invalid_request_error', 'body bukan satu objek JSON');
  }
  const seq = requestSeq++;
  failuresOfThisPrompt.length = 0;
  const wantStream = body.stream === true;
  const outcome = await dialWithFailover(
    needFromAnthropic(body),
    seq,
    (modelId) => toChatBody(body, modelId),
    wantStream,
  );
  if (!outcome.ok || outcome.response === null) {
    return replyError(res, 'anthropic', 502, 'api_error', 'semua model gratis layak menolak atau gagal', failuresHeader());
  }
  const upstream = outcome.response;
  if (wantStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...failuresHeader(),
    });
    try {
      if (upstream.body !== null) await relayAnthropicStream(upstream.body, outcome.modelId, res);
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json().catch(() => null);
  if (!isDict(answer)) {
    return replyError(res, 'anthropic', 502, 'api_error', 'jawaban gateway bukan JSON', failuresHeader());
  }
  replyJson(res, 200, toAnthropicBody(answer, outcome.modelId), failuresHeader());
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://tierpool.local');
  if (req.method === 'GET' && url.pathname === '/v1/models') return handleModels(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/messages') return handleMessages(req, res);
  const wire = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
  return replyError(res, wire, 404, 'not_found', `tidak ada rute ${req.method ?? ''} ${url.pathname}`);
}

// ------------------------------------------------------------ register+poll

async function register(port: number): Promise<void> {
  const resp = await fetch(`${ENV_BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTO_VER, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`register ditolak HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const ack: unknown = await resp.json().catch(() => null);
  if (isDict(ack) && typeof ack.requests === 'number') {
    note(`terdaftar; trial memegang ${ack.requests} prompt`);
  }
}

function pollWork(close: () => void): void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const resp = await fetch(`${ENV_BASE}/work`, { signal: AbortSignal.timeout(2000) });
        if (resp.status === 200) {
          const work: unknown = await resp.json().catch(() => null);
          if (isDict(work) && work.done === true) {
            clearInterval(timer);
            close();
            process.exit(0);
          }
        }
      } catch {
        // env belum terjangkau: coba lagi di tick berikut
      } finally {
        busy = false;
      }
    })();
  }, POLL_MS);
}

async function boot(): Promise<void> {
  if (briefProblem !== null) note(briefProblem);
  if (process.argv.includes('--list')) {
    // Dokumen yang sama persis dengan yang dikirim ke register.
    await new Promise<void>((resolve) => process.stdout.write(`${catalogText}\n`, () => resolve()));
    process.exit(0);
  }
  if (ENV_BASE === '') throw new Error('MAKEFUN_ENV_URL belum di-set');
  if (gatewayChatUrl() === '') throw new Error('OPENAI_BASE_URL belum di-set');

  const server = createServer((req, res) => {
    void route(req, res).catch((err: unknown) => {
      note((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        replyError(res, 'openai', 500, 'internal_error', 'server gagal menjawab');
      } else {
        res.end();
      }
    });
  });

  // Dengarkan di port bebas; 8080 milik env di satu layout, jadi bila OS
  // memberinya, tutup dan minta lagi.
  let port = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('server tidak mendapat port');
    port = addr.port;
    if (port !== 8080) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (attempt === 4) throw new Error('OS berulang kali memberi port 8080');
  }

  note(`mendengarkan 0.0.0.0:${port} dengan ${pool.length} model gratis`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollWork(() => server.close());
}

try {
  await boot();
} catch (err) {
  note((err as Error).stack ?? String(err));
  process.exit(1);
}
