import {
	AssistantMessageEventStream,
	getApiProvider,
	streamSimple,
} from "/opt/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";

const SSE_HEADERS = {
	Accept: "text/event-stream",
	"Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
	Pragma: "no-cache",
	"X-Accel-Buffering": "no",
	"Surrogate-Control": "no-store",
};
const baseStreamSimple =
	getApiProvider("anthropic-messages")?.streamSimple ?? streamSimple;

// V1: headers wrapper (current default)
function headersWrapper(model, context, options) {
	const startedAt = Date.now();
	return baseStreamSimple(model, context, {
		...options,
		headers: { ...options?.headers, ...SSE_HEADERS },
		onResponse: async (response) => {
			await options?.onResponse?.(response, model);
		},
	});
}

// V2: fetch-direct (already tested baseline)
async function* sseEvents(body, signal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (!signal?.aborted) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl;
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

function fetchDirect(baseUrl) {
	return (model, context, options) => {
		const startedAt = Date.now();
		const stream = new AssistantMessageEventStream();
		(async () => {
			const output = {
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: "anthropic-messages",
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			try {
				const response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": options?.apiKey ?? "test-key",
						"anthropic-version": "2023-06-01",
						...SSE_HEADERS,
						...options?.headers,
					},
					body: JSON.stringify({
						model: model.id,
						max_tokens: model.maxTokens,
						messages: context.messages.filter(m => m.role === "user").map(m => ({
							role: m.role,
							content: typeof m.content === "string" ? m.content : m.content[0]?.text ?? "",
						})),
						stream: true,
					}),
					signal: options?.signal,
				});
				stream.push({ type: "start", partial: output });
				if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
				for await (const data of sseEvents(response.body, options?.signal)) {
					if (!data) continue;
					const evt = JSON.parse(data);
					if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
						const block = output.content[0];
						block.text += evt.delta.text;
						stream.push({ type: "text_delta", contentIndex: 0, delta: evt.delta.text, partial: output });
					} else if (evt.type === "message_stop") break;
				}
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				output.stopReason = "error";
				output.errorMessage = error.message;
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
			}
		})();
		return stream;
	};
}

// V3: fetch-optimized — minimal allocations, pre-built body template
function fetchOptimized(baseUrl) {
	return (model, context, options) => {
		const startedAt = Date.now();
		const stream = new AssistantMessageEventStream();
		const output = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const apiKey = options?.apiKey ?? "test-key";
		const headers = {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"X-Accel-Buffering": "no",
		};
		const messagesJson = JSON.stringify(
			context.messages.filter(m => m.role === "user").map(m => ({
				role: "user",
				content: typeof m.content === "string" ? m.content : (m.content[0]?.text ?? ""),
			})),
		);
		const body = `{"model":"${model.id}","max_tokens":${model.maxTokens},"messages":${messagesJson},"stream":true}`;
		(async () => {
			try {
				const response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers,
					body,
					signal: options?.signal,
				});
				stream.push({ type: "start", partial: output });
				if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				while (!options?.signal?.aborted) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let nl;
					while ((nl = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, nl);
						buf = buf.slice(nl + 1);
						if (!line.startsWith("data: ")) continue;
						const data = line.slice(6);
						if (!data) continue;
						const evt = JSON.parse(data);
						if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
							const block = output.content[0];
							block.text += evt.delta.text;
							stream.push({ type: "text_delta", contentIndex: 0, delta: evt.delta.text, partial: output });
						} else if (evt.type === "message_stop") break;
					}
				}
				reader.releaseLock();
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				output.stopReason = "error";
				output.errorMessage = error.message;
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
			}
		})();
		return stream;
	};
}

// V4: fetch-prewarm — fetch-optimized + HEAD warmup on first call
let warmedUp = false;
function fetchPrewarm(baseUrl) {
	return (model, context, options) => {
		const fn = fetchOptimized(baseUrl);
		if (!warmedUp) {
			warmedUp = true;
			// Pre-warm TLS: HEAD request establishes connection
			fetch(`${baseUrl}/v1/messages`, { method: "HEAD", headers: { "x-api-key": options?.apiKey ?? "test-key" } }).catch(() => {});
		}
		return fn(model, context, options);
	};
}

// V5: fetch-batched — fetch-optimized + batch text_deltas (emit every ~10ms)
function fetchBatched(baseUrl) {
	return (model, context, options) => {
		const startedAt = Date.now();
		const stream = new AssistantMessageEventStream();
		const output = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const apiKey = options?.apiKey ?? "test-key";
		const headers = {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"X-Accel-Buffering": "no",
		};
		const messagesJson = JSON.stringify(
			context.messages.filter(m => m.role === "user").map(m => ({
				role: "user",
				content: typeof m.content === "string" ? m.content : (m.content[0]?.text ?? ""),
			})),
		);
		const body = `{"model":"${model.id}","max_tokens":${model.maxTokens},"messages":${messagesJson},"stream":true}`;
		(async () => {
			try {
				const response = await fetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers,
					body,
					signal: options?.signal,
				});
				stream.push({ type: "start", partial: output });
				if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				let pendingDelta = "";
				let flushTimer = null;
				const flush = () => {
					flushTimer = null;
					if (pendingDelta) {
						const block = output.content[0];
						block.text += pendingDelta;
						const delta = pendingDelta;
						pendingDelta = "";
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
					}
				};
				while (!options?.signal?.aborted) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let nl;
					while ((nl = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, nl);
						buf = buf.slice(nl + 1);
						if (!line.startsWith("data: ")) continue;
						const data = line.slice(6);
						if (!data) continue;
						const evt = JSON.parse(data);
						if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
							pendingDelta += evt.delta.text;
							if (!flushTimer) flushTimer = setTimeout(flush, 10);
						} else if (evt.type === "message_stop") {
							flush();
							reader.releaseLock();
							stream.push({ type: "done", reason: "stop", message: output });
							stream.end();
							return;
						}
					}
				}
				flush();
				reader.releaseLock();
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				output.stopReason = "error";
				output.errorMessage = error.message;
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
			}
		})();
		return stream;
	};
}

const PORT = parseInt(process.env.MOCK_PORT ?? "0", 10);
const N = parseInt(process.env.N ?? "20", 10);

const model = {
	id: "MiniMax-M3",
	api: "anthropic-messages",
	provider: "minimax",
	baseUrl: `http://localhost:${PORT}/anthropic`,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 100000,
};
const ctx = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
const opts = { apiKey: "test-key" };

async function bench(label, streamSimple) {
	const results = [];
	for (let i = 0; i < N; i++) {
		const startedAt = Date.now();
		let firstChunkAt = 0;
		const inter = [];
		let prev = 0;
		let chunks = 0;
		const stream = streamSimple(model, ctx, opts);
		for await (const e of stream) {
			if (e.type === "text_delta" || e.type === "thinking_delta") {
				const now = Date.now() - startedAt;
				if (firstChunkAt === 0) firstChunkAt = now;
				else inter.push(now - prev);
				prev = now;
				chunks++;
			}
			if (e.type === "done" || e.type === "error") break;
		}
		results.push({ ttfb: firstChunkAt, interAvg: inter.length ? Math.round(inter.reduce((a,b)=>a+b)/inter.length) : 0, chunks, elapsed: Date.now() - startedAt });
	}
	const avg = (k) => Math.round(results.reduce((a, r) => a + r[k], 0) / results.length);
	const min = (k) => Math.min(...results.map((r) => r[k]));
	console.log(`${label.padEnd(15)} ttfb_avg=${avg("ttfb")}ms ttfb_min=${min("ttfb")}ms inter=${avg("interAvg")}ms elapsed_avg=${avg("elapsed")}ms chunks=${results[0].chunks}`);
	return { ttfb_avg: avg("ttfb"), inter_avg: avg("interAvg"), elapsed_avg: avg("elapsed") };
}

await bench("headers", headersWrapper);
await bench("fetch-direct", fetchDirect(`http://localhost:${PORT}`));
await bench("fetch-optimized", fetchOptimized(`http://localhost:${PORT}`));
await bench("fetch-prewarm", fetchPrewarm(`http://localhost:${PORT}`));
await bench("fetch-batched", fetchBatched(`http://localhost:${PORT}`));
