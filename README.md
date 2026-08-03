# pi-minimax-provider

Pi extension: MiniMax AI models (M3, M2.7, M2.5, M2.1, M2) via Anthropic-compatible endpoint.

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

| Model | Context | Output |
|-------|--------:|-------:|
| MiniMax-M3 | 1,000,000 | 524,288 |
| MiniMax-M2.7 | 204,800 | 65,536 |
| MiniMax-M2.7-highspeed | 204,800 | 65,536 |
| MiniMax-M2.5 | 204,800 | 65,536 |
| MiniMax-M2.5-highspeed | 204,800 | 65,536 |
| MiniMax-M2.1 | 204,800 | 65,536 |
| MiniMax-M2.1-highspeed | 204,800 | 65,536 |
| MiniMax-M2 | 204,800 | 65,536 |

Use: `/model MiniMax-M3`

## License

MIT
