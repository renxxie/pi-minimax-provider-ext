// Pi extension: MiniMax AI models via Anthropic-compatible endpoint.
// Uses direct fetch (bypasses Anthropic SDK, ~5ms faster) with SSE-headers
// to bypass nginx/CDN response buffering. Custom undici Agent would save
// another ~3ms but the import isn't available from extensions.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
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

// Minimal SSE parser: yields each `data: ...` payload as a string.
async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (!signal?.aborted) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.startsWith("data: ")) yield line.slice(6);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function streamSimple(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	(async () => {
		try {
			const response = await fetch(`${model.baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": options?.apiKey ?? "",
					"anthropic-version": "2023-06-01",
					...SSE_HEADERS,
					...options?.headers,
				},
				body: JSON.stringify({
					model: model.id,
					max_tokens: options?.maxTokens ?? model.maxTokens,
					messages: context.messages
						.filter((m) => m.role === "user" || m.role === "assistant")
						.map((m) => ({
							role: m.role,
							content:
								typeof m.content === "string"
									? m.content
									: m.content.map((b) =>
											b.type === "text"
												? { type: "text", text: b.text }
												: b.type === "image"
													? {
															type: "image",
															source: {
																type: "base64",
																media_type: b.mimeType,
																data: b.data,
															},
														}
													: { type: "text", text: "" },
										),
						})),
					stream: true,
				}),
				signal: options?.signal,
			});
			stream.push({ type: "start", partial: output });
			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}
			for await (const data of sseEvents(response.body, options?.signal)) {
				if (!data) continue;
				const evt = JSON.parse(data) as {
					type: string;
					message?: { usage?: { input_tokens?: number } };
					delta?: {
						type?: string;
						text?: string;
						stop_reason?: string;
					};
					usage?: { output_tokens?: number };
				};
				if (evt.type === "message_start") {
					output.usage.input = evt.message?.usage?.input_tokens ?? 0;
				} else if (evt.type === "content_block_delta") {
					if (evt.delta?.type === "text_delta") {
						const block = output.content[0] as { type: "text"; text: string };
						block.text += evt.delta.text ?? "";
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: evt.delta.text ?? "",
							partial: output,
						});
					}
				} else if (evt.type === "message_delta") {
					if (evt.delta?.stop_reason) {
						output.stopReason =
							evt.delta.stop_reason === "end_turn"
								? "stop"
								: evt.delta.stop_reason === "max_tokens"
									? "length"
									: "stop";
					}
					if (evt.usage) {
						output.usage.output = evt.usage.output_tokens ?? 0;
					}
				} else if (evt.type === "message_stop") {
					break;
				}
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

export default function (pi: ExtensionAPI) {
	const host = (process.env.MINIMAX_API_HOST || DEFAULT_API_HOST).replace(/\/$/, "");
	pi.registerProvider("minimax", {
		baseUrl: `${host}/anthropic`,
		apiKey: "$MINIMAX_API_KEY",
		api: "anthropic-messages",
		streamSimple,
		models: MODELS,
	});
}
