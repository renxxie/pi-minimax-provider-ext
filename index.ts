import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	ToolCall,
} from "@earendil-works/pi-ai";

const DEFAULT_API_HOST = "https://api.minimax.io";

const SSE_HEADERS = {
	Accept: "text/event-stream",
	"Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
	Pragma: "no-cache",
	"X-Accel-Buffering": "no",
	"Surrogate-Control": "no-store",
} as const;

const BASE_HEADERS = {
	"Content-Type": "application/json",
	"anthropic-version": "2023-06-01",
	...SSE_HEADERS,
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
];

async function* sseEvents(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<string> {
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

function toApiMessages(messages: Context["messages"]) {
	const toBlocks = (c: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>) =>
		typeof c === "string"
			? [{ type: "text", text: c }]
			: c.map((b) => b.type === "image"
				? { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
				: { type: "text", text: b.text ?? "" });
	const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			out.push({ role: "user", content: toBlocks(m.content) });
		} else if (m.role === "assistant") {
			const blocks: unknown[] = [];
			for (const b of m.content) {
				if (b.type === "text") blocks.push({ type: "text", text: b.text });
				else if (b.type === "thinking" && b.thinking) blocks.push({ type: "thinking", thinking: b.thinking, signature: b.thinkingSignature ?? "" });
				else if (b.type === "toolCall") blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} });
			}
			if (blocks.length) out.push({ role: "assistant", content: blocks });
		} else if (m.role === "toolResult") {
			out.push({ role: "user", content: [{
				type: "tool_result", tool_use_id: m.toolCallId, is_error: m.isError, content: toBlocks(m.content),
			}] });
		}
	}
	return out;
}

function streamSimple(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
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
			const body: Record<string, unknown> = {
				model: model.id,
				max_tokens: options?.maxTokens ?? model.maxTokens,
				messages: toApiMessages(context.messages),
				stream: true,
			};
			if (context.systemPrompt) body.system = context.systemPrompt;
			if (context.tools && context.tools.length > 0) {
				body.tools = context.tools.map((t) => ({
					name: t.name,
					description: t.description,
					input_schema: t.parameters,
				}));
			}
			body.thinking = { type: "enabled", budget_tokens: 0 };

			const response = await fetch(`${model.baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					...BASE_HEADERS,
					"x-api-key": options?.apiKey ?? "",
					...options?.headers,
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			stream.push({ type: "start", partial: output });
			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}
			for await (const data of sseEvents(response.body, options?.signal)) {
				if (!data) continue;
				const evt: any = JSON.parse(data);
				if (evt.type === "message_start") {
					const u = evt.message?.usage;
					if (u) {
						output.usage.input = u.input_tokens ?? 0;
						output.usage.cacheRead = u.cache_read_input_tokens ?? 0;
						output.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
					}
				} else if (evt.type === "content_block_start" && evt.index !== undefined && evt.content_block) {
					const cb = evt.content_block;
					let block: any;
					let startEvent: string;
					if (cb.type === "text") { block = { type: "text", text: "" }; startEvent = "text_start"; }
					else if (cb.type === "thinking") { block = { type: "thinking", thinking: "", thinkingSignature: cb.signature ?? "" }; startEvent = "thinking_start"; }
					else if (cb.type === "tool_use") { block = { type: "toolCall", id: cb.id ?? "", name: cb.name ?? "", arguments: cb.input ?? {}, partialJson: "" }; startEvent = "toolcall_start"; }
					if (block) {
						output.content.push(block);
						stream.push({ type: startEvent, contentIndex: evt.index, partial: output });
					}
				} else if (evt.type === "content_block_delta" && evt.index !== undefined) {
					const block: any = output.content[evt.index];
					if (!block) continue;
					const d = evt.delta;
					if (d?.type === "text_delta") {
						block.text += d.text;
						stream.push({ type: "text_delta", contentIndex: evt.index, delta: d.text, partial: output });
					} else if (d?.type === "thinking_delta") {
						block.thinking += d.thinking;
						stream.push({ type: "thinking_delta", contentIndex: evt.index, delta: d.thinking, partial: output });
					} else if (d?.type === "input_json_delta") {
						block.partialJson += d.partial_json;
						stream.push({ type: "toolcall_delta", contentIndex: evt.index, delta: d.partial_json, partial: output });
					} else if (d?.type === "signature_delta") {
						block.thinkingSignature += d.signature;
					}
				} else if (evt.type === "content_block_stop" && evt.index !== undefined) {
					const block: any = output.content[evt.index];
					if (!block) continue;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: evt.index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: evt.index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						try { block.arguments = JSON.parse(block.partialJson || "{}"); }
						catch { block.arguments = {}; }
						const toolCall: ToolCall = { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
						stream.push({ type: "toolcall_end", contentIndex: evt.index, toolCall, partial: output });
					}
				} else if (evt.type === "message_delta") {
					if (evt.delta?.stop_reason) {
						output.stopReason =
							evt.delta.stop_reason === "end_turn" ? "stop" :
							evt.delta.stop_reason === "max_tokens" ? "length" :
							evt.delta.stop_reason === "tool_use" ? "toolUse" :
							"stop";
					}
					if (evt.usage?.output_tokens != null) output.usage.output = evt.usage.output_tokens;
				} else if (evt.type === "message_stop") {
					break;
				}
			}
			output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
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
