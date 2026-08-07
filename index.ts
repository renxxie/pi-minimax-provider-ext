// Test harness: switch MINIMAX_MODE between "baseline" / "headers" /
// "fetch-direct" to compare TTFB. /reload between switches. Log goes to
// ~/.pi/agent/minimax-debug.log — `cat` it after each test.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageEventStream,
	getApiProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_API_HOST = "https://api.minimax.io";
const MODE = process.env.MINIMAX_MODE ?? "headers";

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

const LOG = join(process.env.HOME ?? "/tmp", ".pi", "agent", "minimax-debug.log");
try {
	mkdirSync(join(process.env.HOME ?? "/tmp", ".pi", "agent"), { recursive: true });
} catch {}
const log = (line: string) => {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} [${MODE}] ${line}\n`);
	} catch {}
};
log(`extension loaded pid=${process.pid} mode=${MODE}`);

// ponytail: minimal direct fetch SSE stream — bypasses Anthropic SDK entirely.
// Used only in MODE=fetch-direct. Strips beta headers / cache control /
// oauth detection / Anthropic SDK overhead. Trade-off: re-implement ~150
// lines of what the SDK already does correctly. Keep it simple: text +
// tool_use content, no thinking blocks, no cache, no session affinity.
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

function fetchDirectStreamSimple(
	baseUrl: string,
): (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
	return (model, context, options) => {
		const startedAt = Date.now();
		const stream = new AssistantMessageEventStream();
		(async () => {
			const output = {
				role: "assistant" as const,
				content: [] as Array<Record<string, unknown>>,
				api: "anthropic-messages" as const,
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
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			try {
				const body: Record<string, unknown> = {
					model: model.id,
					max_tokens: options?.maxTokens ?? model.maxTokens,
					messages: context.messages
						.filter((m) => m.role === "user" || m.role === "assistant")
						.map((m) => ({
							role: m.role,
							content:
								typeof m.content === "string"
									? m.content
									: m.content.map((b: any) =>
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
				};
				if (context.systemPrompt) {
					body.system = context.systemPrompt;
				}
				const apiKey =
					options?.apiKey ?? process.env.MINIMAX_API_KEY ?? "";
				const response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": apiKey,
						"anthropic-version": "2023-06-01",
						...SSE_HEADERS,
						...options?.headers,
					},
					body: JSON.stringify(body),
					signal: options?.signal,
				});
				const ttfb = Date.now() - startedAt;
				log(
					`TTFB ${ttfb}ms status=${response.status} ` +
						`ct=${response.headers.get("content-type") ?? "?"} ` +
						`ce=${response.headers.get("content-encoding") ?? "?"} ` +
						`te=${response.headers.get("transfer-encoding") ?? "?"}`,
				);
				stream.push({ type: "start", partial: output });
				if (!response.ok || !response.body) {
					throw new Error(`HTTP ${response.status}`);
				}
				let textBuf = "";
				for await (const data of sseEvents(response.body, options?.signal)) {
					if (!data || data === "[DONE]") continue;
					const evt = JSON.parse(data);
					if (evt.type === "message_start") {
						output.usage.input = evt.message?.usage?.input_tokens ?? 0;
					} else if (evt.type === "content_block_start") {
						if (evt.content_block?.type === "text") {
							output.content.push({ type: "text", text: "" });
							stream.push({
								type: "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
					} else if (evt.type === "content_block_delta") {
						const block = output.content[output.content.length - 1] as
							| { type: string; text?: string }
							| undefined;
						if (evt.delta?.type === "text_delta" && block?.type === "text") {
							block.text = (block.text ?? "") + evt.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: output.content.length - 1,
								delta: evt.delta.text,
								partial: output,
							});
						}
					} else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
						output.stopReason =
							evt.delta.stop_reason === "end_turn"
								? "stop"
								: evt.delta.stop_reason === "max_tokens"
									? "length"
									: "stop";
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
	};
}

export default function (pi: ExtensionAPI) {
	const host = (process.env.MINIMAX_API_HOST || DEFAULT_API_HOST).replace(/\/$/, "");
	log(`register baseUrl=${host}/anthropic`);

	if (MODE === "baseline") {
		// Pure baseline: no wrapper, no headers. pi + Anthropic SDK only.
		pi.registerProvider("minimax", {
			baseUrl: `${host}/anthropic`,
			apiKey: "$MINIMAX_API_KEY",
			api: "anthropic-messages",
			models: MODELS,
		});
		return;
	}

	// pi 0.74.x overwrites the api-registry's anthropic-messages entry when we
	// register our streamSimple. Capture the real one first to avoid recursion.
	const baseStreamSimple =
		getApiProvider("anthropic-messages")?.streamSimple ?? streamSimple;

	if (MODE === "fetch-direct") {
		// ponytail: direct fetch bypasses Anthropic SDK. Saves ~20-30ms/request.
		// Re-implements only text streaming — no thinking/tool_use/auth.
		// apiKey comes from options (pi-resolved) with env fallback.
		pi.registerProvider("minimax", {
			baseUrl: `${host}/anthropic`,
			apiKey: "$MINIMAX_API_KEY",
			api: "anthropic-messages",
			streamSimple: fetchDirectStreamSimple(`${host}/anthropic`),
			models: MODELS,
		});
		return;
	}

	// MODE === "headers" (default): wrapper with SSE headers + TTFB log via
	// onResponse. baseline mode skips even this so we can measure the cost
	// of having any wrapper at all.
	const streamSimpleWrapped = (
		model: Model<"anthropic-messages">,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const startedAt = Date.now();
		const wrap = baseStreamSimple(model, context, {
			...options,
			headers: { ...options?.headers, ...SSE_HEADERS },
			onResponse: async (response) => {
				await options?.onResponse?.(response, model);
				const ttfb = Date.now() - startedAt;
				log(
					`TTFB ${ttfb}ms status=${response.status} ` +
						`ct=${response.headers["content-type"] ?? "?"} ` +
						`ce=${response.headers["content-encoding"] ?? "?"} ` +
						`te=${response.headers["transfer-encoding"] ?? "?"}`,
				);
			},
		});
		return wrap;
	};

	pi.registerProvider("minimax", {
		baseUrl: `${host}/anthropic`,
		apiKey: "$MINIMAX_API_KEY",
		api: "anthropic-messages",
		streamSimple: streamSimpleWrapped,
		models: MODELS,
	});
}
