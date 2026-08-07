# Benchmarks

Reproduce the measurements from the README's **Benchmarks** section.

## Files

| File | What it does |
|---|---|
| `server.mjs` | Mock Anthropic-compatible SSE server. Streams `message_start` → chunked `content_block_delta` → `message_stop`. Configurable via env. |
| `bench.mjs` | 5 streamSimple variants × N iterations, measures TTFB and inter-token latency. |
| `bench-agent.mjs` | 8 undici.Agent variants × N iterations. |

## Run

Two terminals.

**Terminal 1 — server:**

```bash
cd benchmarks
MOCK_DELAY_MS=50 MOCK_CHUNK_INTERVAL_MS=20 node server.mjs
# → prints MOCK_PORT=<port>
```

**Terminal 2 — benchmark:**

```bash
cd benchmarks
MOCK_PORT=<port-from-server> N=20 node bench.mjs
# or
MOCK_PORT=<port-from-server> N=15 node bench-agent.mjs
```

## Env knobs

| Env | Default | Meaning |
|---|---|---|
| `MOCK_DELAY_MS` | 50 | Time before server writes first byte |
| `MOCK_CHUNK_INTERVAL_MS` | 30 | Delay between text_delta events |
| `N` | 20 / 15 | Iterations per variant |

The benchmarks hardcode the Anthropic-compatible protocol: `POST /v1/messages` with `x-api-key` header, SSE response with `message_start` / `content_block_delta` / `message_stop` events. The server accepts any `x-api-key` that starts with `test-` or equals `fake-key`.

## What the benchmarks measure

- **TTFB**: time from `streamSimple(...)` call to first `text_delta` event. Includes JSON body serialization, `fetch()`, DNS, TCP, TLS, server response headers, first SSE event.
- **inter**: average time between consecutive `text_delta` events. Captures per-chunk parsing + push overhead.
- **elapsed**: total time from call to `done` event.

The benchmarks run the variants **sequentially** in the same process, which means each variant warms up the connection pool itself — comparing cold-start vs warm-cache performance would need a separate run per variant in a fresh process.
