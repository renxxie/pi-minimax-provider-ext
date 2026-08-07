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
// ponytail: log TTFB + response headers to ~/.pi/agent/minimax-debug.log on
// every request. pi's TUI captures stdout, so console.log from extensions
// never reaches the user. The log is tiny (one line per request) and lives
// outside the TUI, so it doesn't interfere with normal usage. Delete the
// file when you're done diagnosing.
const DEBUG_LOG = join(process.env.HOME ?? "/tmp", ".pi", "agent", "minimax-debug.log");
try {
	mkdirSync(join(process.env.HOME ?? "/tmp", ".pi", "agent"), { recursive: true });
	appendFileSync(
		DEBUG_LOG,
		`${new Date().toISOString()} extension loaded pid=${process.pid} cwd=${process.cwd()}\n`,
	);
} catch {
	// never let debug logging break the extension load
}
function logDebug(line: string): void {
	try {
		appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
	} catch {
		// never let debug logging break the stream
	}
}
function makeFastStreamSimple(
	base: StreamFunction<"anthropic-messages", SimpleStreamOptions>,
) {
	return (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const startedAt = Date.now();
		logDebug(
			`request start model=${model.id} baseUrl=${model.baseUrl} msg#=${context.messages.length}`,
		);
		return base(model, context, {
			...options,
			headers: {
				...options?.headers,
				Accept: "text/event-stream",
				"Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
				Pragma: "no-cache",
				"X-Accel-Buffering": "no",
				"Surrogate-Control": "no-store",
			},
			onResponse: async (response) => {
				await options?.onResponse?.(response, model);
				const ttfb = Date.now() - startedAt;
				const enc = response.headers["content-encoding"] ?? "?";
				const ct = response.headers["content-type"] ?? "?";
				const te = response.headers["transfer-encoding"] ?? "?";
				logDebug(
					`TTFB ${ttfb}ms status=${response.status} ` +
						`ct=${ct} ce=${enc} te=${te}`,
				);
			},
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
		),
		models: MODELS,
	});
}
