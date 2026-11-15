// TierPool Router — catalog.ts
// Tugas modul ini sempit: membaca brief trial, menyaring model gratisnya, lalu
// menyusun dua hal dari daftar yang sama — dokumen katalog untuk --list/register
// dan kolam (pool) bertier untuk routing di main.ts. Tidak ada daftar model yang
// ditulis tangan di sini; semua baris datang dari brief, jadi katalog tidak bisa
// meleset dari isi brief trial mana pun.

import { readFileSync } from 'node:fs';

/** Bentuk longgar untuk objek JSON apa pun yang datang dari brief. */
export type Dict = Record<string, unknown>;

export const isDict = (v: unknown): v is Dict =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Satu model gratis persis seperti brief menuliskannya, sudah dinormalisasi. */
export interface PoolModel {
  dialId: string; // id yang dikirim ke gateway, mis. openrouter/<vendor>/<model>:free
  label: string; // nama tampil untuk GET /v1/models versi Anthropic
  ratingMilli: number; // rating rumah dalam mili-poin; makin besar makin bagus
  windowTokens: number | null; // context_length
  canTools: boolean | null;
  canVision: boolean | null;
  canJson: boolean | null;
}

/** Kebutuhan sebuah request, dibaca dari bodinya sendiri di main.ts. */
export interface NeedFlags {
  tools: boolean;
  vision: boolean;
  json: boolean;
}

/** Dokumen katalog: bentuknya dikunci oleh protokol trial. */
export interface CatalogDoc {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: 'openai';
    models: Array<{ id: string; free: boolean; context_length: number | null }>;
  }>;
}

const SCHEMA_TAG = 'free-model-aggregator-02/';
export const PUBLIC_BASE = 'https://openrouter.ai/api/v1';
export const KEY_ENV_NAME = 'OPENROUTER_API_KEY';

// ---------------------------------------------------------------------------
// Pemindai brief
// Brief adalah prosa yang menyelipkan dokumen JSON. Kami memindai teksnya dan
// mencoba mem-parse setiap objek tingkat atas; dokumen yang dicari dikenali
// dari anggota `schema`-nya, bukan dari posisi atau judul prosa di sekitarnya.
// ---------------------------------------------------------------------------

/** Indeks kurung tutup yang menyeimbangkan kurung buka di `open`, sadar string. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Semua objek JSON ber-`schema` di dalam teks brief, urut kemunculan. */
function schemaDocs(text: string): Dict[] {
  const found: Dict[] = [];
  let at = text.indexOf('{');
  while (at !== -1) {
    const end = matchingBrace(text, at);
    if (end === -1) break;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text.slice(at, end + 1));
    } catch {
      parsed = null;
    }
    if (isDict(parsed) && typeof parsed.schema === 'string' && parsed.schema.includes(SCHEMA_TAG)) {
      found.push(parsed);
      at = text.indexOf('{', end + 1);
    } else {
      at = text.indexOf('{', at + 1);
    }
  }
  return found;
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asBoolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Normalisasi satu baris model. Sebagian brief menulis id polos
 * (`vendor/model:free`) plus provider `openrouter`; gateway hanya mengenal
 * ejaan berawalan `openrouter/`, jadi awalan itu dipasang di sini bila belum ada.
 */
function normalizeRow(raw: unknown): PoolModel | null {
  if (!isDict(raw)) return null;
  if (raw.free === false) return null; // kolam ini khusus model gratis
  let dialId = asText(raw.id) || asText(raw.model);
  if (dialId === '') return null;
  const provider = asText(raw.provider) || 'openrouter';
  if (provider === 'openrouter' && !dialId.startsWith('openrouter/')) {
    dialId = `openrouter/${dialId}`;
  }
  return {
    dialId,
    label: asText(raw.display_name) || dialId,
    ratingMilli: asNumOrNull(raw.rating_milli) ?? 0,
    windowTokens: asNumOrNull(raw.context_length),
    canTools: asBoolOrNull(raw.tools),
    canVision: asBoolOrNull(raw.vision),
    canJson: asBoolOrNull(raw.json),
  };
}

/**
 * Baca brief di `path` dan kembalikan model gratisnya, urut brief.
 * Kegagalan baca menghasilkan daftar kosong (bukan lemparan): mode --list di
 * luar trial tetap harus mencetak katalog kosong dan keluar 0.
 */
export function loadPool(path: string): { pool: PoolModel[]; problem: string | null } {
  if (!path) return { pool: [], problem: 'MAKEFUN_PROMPT_FILE belum di-set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { pool: [], problem: `brief tidak terbaca: ${(err as Error).message}` };
  }
  for (const doc of schemaDocs(text)) {
    const rows = Array.isArray(doc.models) ? doc.models : Array.isArray(doc.ratings) ? doc.ratings : null;
    if (rows === null) continue;
    const pool: PoolModel[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const m = normalizeRow(row);
      if (m !== null && !seen.has(m.dialId)) {
        seen.add(m.dialId);
        pool.push(m);
      }
    }
    return { pool, problem: null };
  }
  return { pool: [], problem: 'dokumen model tidak ditemukan di brief' };
}

/** Dokumen katalog dari kolam: satu provider, tepat model gratis brief. */
export function catalogFromPool(pool: readonly PoolModel[]): CatalogDoc {
  if (pool.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: PUBLIC_BASE,
        key_env: KEY_ENV_NAME,
        wire: 'openai',
        models: pool.map((m) => ({ id: m.dialId, free: true, context_length: m.windowTokens })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tier pool
// Routing TierPool membagi model layak ke tiga gelang berdasarkan rating:
//   gelang 0 — elit, rating >= 1300
//   gelang 1 — kuat, rating 1200..1299
//   gelang 2 — sisanya
// Gelang atas selalu dicoba habis dulu sebelum turun gelang. Di dalam gelang,
// urutan dasar adalah rating tertinggi dulu; putaran round-robin menggeser
// titik awalnya per request agar beban (dan limit) tidak menumpuk di satu
// model yang sama terus-menerus.
// ---------------------------------------------------------------------------

export function bandOf(ratingMilli: number): 0 | 1 | 2 {
  if (ratingMilli >= 1300) return 0;
  if (ratingMilli >= 1200) return 1;
  return 2;
}

/** Apakah model sanggup melayani kebutuhan ini. Kemampuan tak diketahui = tidak sanggup. */
export function capable(m: PoolModel, need: NeedFlags): boolean {
  if (need.tools && m.canTools !== true) return false;
  if (need.vision && m.canVision !== true) return false;
  if (need.json && m.canJson !== true) return false;
  return true;
}

/**
 * Urutan dial untuk satu request: gelang 0, lalu 1, lalu 2; tiap gelang
 * dirotasi sebesar `spin[gelang]` (dinaikkan pemanggil sekali per request,
 * jadi deterministik — hanya fungsi dari urutan request yang sudah datang).
 */
export function dialOrder(
  pool: readonly PoolModel[],
  need: NeedFlags,
  spin: ReadonlyMap<number, number>,
): PoolModel[] {
  const byBand: PoolModel[][] = [[], [], []];
  for (const m of pool) {
    if (capable(m, need)) byBand[bandOf(m.ratingMilli)].push(m);
  }
  const ordered: PoolModel[] = [];
  for (let band = 0; band < 3; band++) {
    const lane = byBand[band];
    lane.sort((a, b) => b.ratingMilli - a.ratingMilli || (a.dialId < b.dialId ? -1 : 1));
    if (lane.length === 0) continue;
    const shift = (spin.get(band) ?? 0) % lane.length;
    for (let i = 0; i < lane.length; i++) ordered.push(lane[(shift + i) % lane.length]);
  }
  return ordered;
}
