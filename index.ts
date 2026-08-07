import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider, streamSimple } from "@earendil-works/pi-ai";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
} from "@earendil-works/pi-ai";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_API_HOST = "https://api.minimax.io";

const MODELS = [
	{
		id: "MiniMax-M3",
		name: "MiniMax M3",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 524288,
	},
	{
		id: "MiniMax-M2.7",
		name: "MiniMax M2.7",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
];

// ponytail: thin wrapper around the built-in Anthropic streamSimple. The SDK
// already does the heavy lifting; this only injects the four headers that
// actually move SSE latency on hostile networks (corporate proxies, captive
// portals, old CDNs) and that Anthropic's SDK doesn't set on its own:
//   - X-Accel-Buffering: no  -> ask nginx-style proxies to flush each chunk
//                               instead of batching. The single biggest cause
//                               of "first token feels slow" when a CDN/reverse
//                               proxy sits in front of an Anthropic-compatible
//                               endpoint.
//   - Cache-Control: no-cache -> no intermediate cache holding the stream open
//   - Pragma: no-cache         -> HTTP/1.0 cache directive for ancient proxies
//                               that ignore Cache-Control
//   - Accept: text/event-stream -> explicit streaming negotiation
// ponytail: use the bare `@earendil-works/pi-ai` import, not `/compat` — the
// /compat subpath was added in pi-ai 0.80+; pi 0.74.2 ships pi-ai 0.74.2 which
// doesn't have it and the loader fails to resolve it. `streamSimple` has been
// exported from the package root since 0.74.x and still is in 0.83+.
//
// ponytail: resolve the real Anthropic streamSimple at registration time, not
// via the generic `streamSimple()` dispatcher. pi 0.74.x's model-registry
// calls `registerApiProvider({ api: config.api, streamSimple: ourWrapper })`
// when an extension supplies `streamSimple` — that *overwrites* the built-in
// anthropic-messages entry in the api-registry. So calling the generic
// `streamSimple()` from inside our wrapper would loop back into us forever.
// Capturing the built-in before `registerProvider` runs sidesteps that on
// every pi version we support (0.74.x overwrites, 0.83+ never does).
//
// ponytail: when MINIMAX_DEBUG=1, log TTFB + response headers + chunk timing
// via onResponse so the user can see whether the bottleneck is proxy
// buffering, TLS handshake, or server-side. Set the var, send a message,
// check `~/.pi/agent/minimax-debug.log`. We write to a file because pi's TUI
// captures stdout, so console.log from extensions never reaches the user.
function makeFastStreamSimple(
	base: StreamFunction<"anthropic-messages", SimpleStreamOptions>,
	cwd: string,
) {
	const debug = !!process.env.MINIMAX_DEBUG;
	const logFile = debug ? join(cwd, ".pi", "agent", "minimax-debug.log") : "";
	if (debug) mkdirSync(join(cwd, ".pi", "agent"), { recursive: true });
	const log = (line: string) => {
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
		} catch {
			// never let debug logging break the stream
		}
	};
	return (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const startedAt = debug ? Date.now() : 0;
		if (debug) log(`request start model=${model.id} baseUrl=${model.baseUrl}`);
		return base(model, context, {
			...options,
			headers: {
				...options?.headers,
				Accept: "text/event-stream",
				"X-Accel-Buffering": "no",
				"Cache-Control": "no-cache",
				Pragma: "no-cache",
			},
			...(debug
				? {
						onResponse: async (response) => {
							const ttfb = Date.now() - startedAt;
							const enc = response.headers["content-encoding"] ?? "?";
							const ct = response.headers["content-type"] ?? "?";
							const te = response.headers["transfer-encoding"] ?? "?";
							log(
								`TTFB ${ttfb}ms status=${response.status} ` +
									`ct=${ct} ce=${enc} te=${te}`,
							);
						},
					}
				: {}),
		});
	};
}

export default function (pi: ExtensionAPI) {
	const host = (process.env.MINIMAX_API_HOST || DEFAULT_API_HOST).replace(/\/$/, "");

	// ponytail: snapshot the real Anthropic streamSimple before registering —
	// pi 0.74.x overwrites the api-registry entry when we register our own.
	const baseStreamSimple =
		getApiProvider("anthropic-messages")?.streamSimple ?? streamSimple;

	pi.registerProvider("minimax", {
		baseUrl: `${host}/anthropic`,
		apiKey: "$MINIMAX_API_KEY",
		api: "anthropic-messages",
		streamSimple: makeFastStreamSimple(
			baseStreamSimple as StreamFunction<"anthropic-messages", SimpleStreamOptions>,
			process.cwd(),
		),
		models: MODELS,
	});
}
