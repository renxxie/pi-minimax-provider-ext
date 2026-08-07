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

## SSE

The streaming wrapper sends three headers that the Anthropic SDK doesn't set on its own:

- `Accept: text/event-stream` — explicit streaming negotiation
- `X-Accel-Buffering: no` — tells nginx-style proxies to flush each chunk instead of batching (the single biggest cause of "first token feels slow" when a CDN/reverse proxy sits in front of the upstream)
- `Cache-Control: no-cache` — no intermediate cache holding the stream open

## License

MIT
