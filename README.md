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

Benchmark on localhost mock (50ms first byte, 30ms inter-token, 20 iterations):

| | TTFB | inter-token |
|---|---|---|
| Anthropic SDK | 58ms | 31ms |
| fetch-direct + headers (this plugin) | 54ms | 32ms |

On a 14s corporate-proxy TTFB the difference is invisible — client-side wins cap at ~5ms regardless of network. The real fix for slow first bytes is an allowlist on `api.minimax.io` in your corporate proxy, not extension code.

## License

MIT
