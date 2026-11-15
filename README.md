[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/binasalama12/makefun-free-model-aggregator-02-w3/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/binasalama12/makefun-free-model-aggregator-02-w3/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

# TierPool Router

TierPool Router is a small, dependency-free Node 22 server that puts every
free model from a make.fun trial brief behind one endpoint. A client talks to
it as if it were OpenAI or Anthropic; the router picks a real free model for
each request, dials it through the trial gateway, and hands the answer back
in the wire the client used — JSON or server-sent events.

## Run

```sh
node main.ts --list   # print the catalog JSON and exit
node main.ts          # serve (needs the trial env vars below)
```

The server reads the brief from `MAKEFUN_PROMPT_FILE`, registers itself with
`POST $MAKEFUN_ENV_URL/register`, serves on a free port on `0.0.0.0` (never
8080), and polls `GET $MAKEFUN_ENV_URL/work` every 100 ms, exiting 0 as soon
as the env reports the trial is done. Model calls go to
`POST $OPENAI_BASE_URL/chat/completions` with the trial key from
`OPENAI_API_KEY`. Nothing else is configured; the catalog is built from the
brief, never hard-coded, and `--list` prints exactly the document that gets
registered.

## Routes

- `GET /v1/models` — OpenAI list shape for an `Authorization` header,
  Anthropic shape for `x-api-key`. Always exactly the brief's free ids.
- `POST /v1/chat/completions` — OpenAI wire, JSON or SSE.
- `POST /v1/messages` — Anthropic wire, JSON or SSE. The request is
  translated to Chat Completions for the gateway and the answer is
  translated back, including tool calls, usage, and stop reasons.

Every response's `model` field names the model that was actually dialled,
on every JSON answer and every streamed chunk.

## How routing works

Requests name `model: "auto"`. The router first filters the brief's free
models by what the request itself needs: a declared `tools` array requires a
tools-capable model, a JSON `response_format` requires a JSON-capable one,
and image content requires vision. The survivors are split into three rating
bands — band 0 at rating 1300 and above, band 1 from 1200 to 1299, band 2
below that — and bands are drained top-first. Inside a band, models are
ordered by rating, but the starting point rotates round-robin from request
to request, so load and rate limits spread across the band instead of
hammering its single best member.

## Failover and cooldowns

A gateway refusal (429, 5xx, or a network failure) is never the final word
while another capable model remains: the router walks down the tier order —
dropping to the next band when a band is exhausted — for up to eight
attempts per prompt. Each refused model is put to rest for a few following
requests (longest after a 429) and is skipped while it rests. The rest grows
with the model's consecutive-refusal streak — a 429 rests it for 3 requests,
a second straight refusal for 6, capped at 8 — and one success clears the
streak, so a model that recovers is welcomed back at the base rest. If every
capable model happens to be resting, the one that wakes soonest is tried
first rather than giving up. When a retry succeeds, the refusals it took
are reported on the final response in the `x-makefun-upstream-failures`
header, as a JSON array of `{"status", "code", "model"}` rows.

## Determinism

Routing, rotation, and cooldowns are driven only by the brief, the order
requests arrive in, and the gateway's answers. There is no wall clock and
no randomness anywhere in a decision, so a replayed trial walks the exact
same path as the live one.

## Layout

- `main.ts` — the server: routes, wire translation, tier dialling,
  failover, register, and the work poll.
- `lib/catalog.ts` — brief parsing, the catalog document, and the tier
  pool ordering.

MIT licensed; see `LICENSE`.
