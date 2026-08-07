import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider, streamSimple } from "@earendil-works/pi-ai";
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const DEFAULT_API_HOST = "https://api.minimax.io";

const SSE_HEADERS = {
	Accept: "text/event-stream",
	"Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
	Pragma: "no-cache",
	"X-Accel-Buffering": "no",
	"Surrogate-Control": "no-store",
} as const;

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

export default function (pi: ExtensionAPI) {
	const host = (process.env.MINIMAX_API_HOST || DEFAULT_API_HOST).replace(/\/$/, "");

	// pi 0.74.x overwrites the api-registry's anthropic-messages entry when we
	// register our streamSimple. Capture the real one first to avoid infinite
	// recursion through the generic dispatcher.
	const baseStreamSimple =
		getApiProvider("anthropic-messages")?.streamSimple ?? streamSimple;

	const streamSimpleWrapped = (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream =>
		baseStreamSimple(model, context, {
			...options,
			headers: { ...options?.headers, ...SSE_HEADERS },
		});

	pi.registerProvider("minimax", {
		baseUrl: `${host}/anthropic`,
		apiKey: "$MINIMAX_API_KEY",
		api: "anthropic-messages",
		streamSimple: streamSimpleWrapped,
		models: MODELS,
	});
}
