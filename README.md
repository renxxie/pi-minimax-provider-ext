# pi-minimax-provider

Pi extension: MiniMax AI models via the Anthropic-compatible endpoint at `api.minimax.io`.

No build, no npm install needed. Drop into extensions folder.

## Install

```bash
git clone https://github.com/renxxie/pi-minimax-provider
cp -r pi-minimax-provider ~/.pi/agent/extensions/
```

Then in pi: `/reload`.

Or symlink for live updates:
```bash
ln -s "$(pwd)/pi-minimax-provider" ~/.pi/agent/extensions/minimax
```

## Auth

1. `/login minimax` → stored in `~/.pi/agent/auth.json`
2. `MINIMAX_API_KEY` env var

## Endpoint override

```bash
MINIMAX_API_HOST=https://proxy.example.com pi
```

## Models

| Model | Context | Output | Input |
|-------|--------:|-------:|-------|
| MiniMax-M3 | 1,000,000 | 524,288 | text + image |
| MiniMax-M2.7 | 204,800 | 65,536 | text |

Use: `/model MiniMax-M3`

## Streaming

Uses direct `fetch` (bypasses the Anthropic SDK, ~5ms faster first byte) with five SSE-friendly headers that the upstream might or might not honor depending on what's in front of `api.minimax.io`:

- `Accept: text/event-stream` — explicit streaming negotiation
- `Cache-Control: no-cache, no-store, must-revalidate, max-age=0` — no intermediate cache
- `Pragma: no-cache` — HTTP/1.0 cache directive for ancient proxies
- `X-Accel-Buffering: no` — tells nginx-style proxies to flush each chunk instead of batching
- `Surrogate-Control: no-store` — Fastly / Varnish / Squid bypass

## Benchmarks

### Setup

Mock Anthropic-compatible SSE server on `localhost:PORT`. Variables:

| Env | Meaning | Values tested |
|---|---|---|
| `MOCK_DELAY_MS` | Time before first byte | 50ms, 200ms |
| `MOCK_CHUNK_INTERVAL_MS` | Inter-token pacing | 10ms, 30ms |

20 iterations per variant, averaged. Node 22.22.2, single process.

Reproduce: see `benchmarks/` (server.mjs + bench.mjs, ~150 lines total).

### Experiment 1 — streamSimple wrapper

Five variants, each registering a different `streamSimple` for the `anthropic-messages` API:

| Variant | What it does | TTFB (50ms) | inter (30ms) | TTFB (200ms) | inter (10ms) |
|---|---|---:|---:|---:|---:|
| `headers` (Anthropic SDK) | SDK + 5 SSE headers | 58ms | 31ms | 208ms | 11ms |
| `fetch-direct` | Direct `fetch` + SSE headers | **54ms** | 32ms | **203ms** | 11ms |
| `fetch-optimized` | Above + pre-built body template | 54ms | 32ms | 203ms | 11ms |
| `fetch-prewarm` | Above + HEAD warmup on first call | 54ms | 32ms | 203ms | 11ms |
| `fetch-batched` | Above + 10ms chunk coalescing | 64ms | 31ms | 213ms | 16ms |

**Findings.** `fetch-direct` is ~4–5ms faster than the SDK on first byte. `fetch-optimized` and `fetch-prewarm` add nothing measurable — the SDK overhead is the only real cost. **`fetch-batched` is strictly worse**: batching text deltas costs the per-token latency budget (16ms vs 11ms) without buying anything visible to the user.

### Experiment 2 — undici Agent settings

Same test, varying only the agent constructor:

| Variant | TTFB (50ms) | inter (20ms) |
|---|---:|---:|
| `{}` (default, 4s keepalive) | 58ms | 21ms |
| `{ keepAliveTimeout: 30_000 }` | 55ms | 21ms |
| `{ keepAliveTimeout: 60_000 }` | 54ms | 21ms |
| `{ keepAliveMaxTimeout: 300_000 }` | 54ms | 21ms |
| `{ allowH2: true }` | 54ms | 21ms |
| `{ allowH2: true, keepAliveTimeout: 60_000 }` | 55ms | 22ms |
| `{ headersTimeout: 5_000 }` | 55ms | 22ms |
| `{ keepAliveTimeout: 0 }` | **failed** (0ms = immediate disconnect) |

**Findings.** Longer `keepAliveTimeout` saves ~3ms (less reconnect on quick follow-ups). HTTP/2 brings nothing for single SSE streams. `headersTimeout` shortening doesn't help. **No keepalive breaks entirely** — undici needs to reconnect on every call.

**Constraint.** Custom `Agent` cannot be used from extensions: `undici` is bundled inside `@earendil-works/pi-coding-agent/node_modules/undici`, not exposed via jiti aliases, and extensions don't get a node_modules search path that finds it. The savings exist in principle but the import isn't reachable.

### Combined best — `fetch-direct` + SSE headers

The shipped code combines only what's reachable from extension code. Net savings vs `headers` (Anthropic SDK) baseline:

| Network | Baseline | This plugin | Δ |
|---|---:|---:|---:|
| localhost, 50ms TTFB | 58ms | 54ms | **-4ms** |
| localhost, 200ms TTFB | 208ms | 203ms | **-5ms** |
| corporate proxy, 14s TTFB | ~14000ms | ~13995ms | -0.04% |

### Discussion

The user-facing latency has three components:

1. **Server processing** (M3 thinking, ~1–3s for a typical prompt) — not in our control
2. **Network round-trip** (DNS + TCP + TLS + first byte) — mostly not in our control
3. **Client parsing + event emission** — what we can affect

For (3), this plugin does roughly the minimum useful work: one `fetch`, one SSE parser, one event per chunk. The Anthropic SDK adds a client constructor, beta-header logic, JSON-schema validation, OAuth detection, retry policy, telemetry — none of which matters for a single request. Removing it gets ~5ms.

For (2) on a corporate network with TLS inspection, every request costs ~10s of proxy work. Headers that say "don't buffer" don't help — the proxy decrypts before those headers are visible. No client-side change moves this number.

### Conclusion

Client-side optimization is **exhausted** for this scenario. The remaining ~99.9% of latency is on the wire and inside the proxy. To actually feel faster on a corporate network, one of these has to happen:

1. **Allowlist** `api.minimax.io` in corporate SSL-inspection / proxy bypass list (ask IT)
2. **Hotspot / VPN** that bypasses the corporate proxy entirely
3. **Different region**: `MINIMAX_API_HOST=https://api.minimaxi.com` if you're closer to Mainland China

On a direct connection (no proxy), the savings from this plugin are visible — ~5ms shaved off every first byte, plus all nginx/CDN buffering bypass scenarios are covered by the headers.

## License

MIT
