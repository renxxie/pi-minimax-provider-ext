import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

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
// already does the heavy lifting; this only injects the three headers that
// actually move SSE latency and that Anthropic's SDK doesn't set on its own:
//   - X-Accel-Buffering: no  -> ask nginx-style proxies to flush each chunk
//                               instead of batching. The single biggest cause
//                               of "first token feels slow" when a CDN/reverse
//                               proxy sits in front of an Anthropic-compatible
//                               endpoint.
//   - Accept: text/event-stream -> explicit streaming negotiation
//   - Cache-Control: no-cache    -> no intermediate cache holding the stream
const baseStreamSimple = anthropicMessagesApi().streamSimple;

function fastStreamSimple(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return baseStreamSimple(model, context, {
		...options,
		headers: {
			...options?.headers,
			Accept: "text/event-stream",
			"X-Accel-Buffering": "no",
			"Cache-Control": "no-cache",
		},
	});
}

export default function (pi: ExtensionAPI) {
	const host = (process.env.MINIMAX_API_HOST || DEFAULT_API_HOST).replace(/\/$/, "");

	pi.registerProvider("minimax", {
		baseUrl: `${host}/anthropic`,
		apiKey: "$MINIMAX_API_KEY",
		api: "anthropic-messages",
		streamSimple: fastStreamSimple,
		models: MODELS,
	});
}
