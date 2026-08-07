import { Agent, fetch as undiciFetch } from "/opt/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js";
import {
	AssistantMessageEventStream,
} from "/opt/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js";

const SSE_HEADERS = {
	Accept: "text/event-stream",
	"X-Accel-Buffering": "no",
};

function makeFetch(agent) {
	return (url, init = {}) => undiciFetch(url, { ...init, dispatcher: agent });
}

function fetchWithAgent(baseUrl, agentOpts) {
	const agent = new Agent(agentOpts);
	const customFetch = makeFetch(agent);
	return (model, context, options) => {
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
		(async () => {
			try {
				const response = await customFetch(`${baseUrl}/v1/messages`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": options?.apiKey ?? "test-key",
						"anthropic-version": "2023-06-01",
						...SSE_HEADERS,
					},
					body: JSON.stringify({
						model: model.id,
						max_tokens: model.maxTokens,
						messages: [{ role: "user", content: "hi" }],
						stream: true,
					}),
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
							output.content[0].text += evt.delta.text;
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

const PORT = parseInt(process.env.MOCK_PORT ?? "0", 10);
const N = parseInt(process.env.N ?? "15", 10);
const baseUrl = `http://localhost:${PORT}/anthropic`;
const model = {
	id: "MiniMax-M3",
	api: "anthropic-messages",
	provider: "minimax",
	baseUrl,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 100000,
};
const ctx = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
const opts = { apiKey: "test-key" };

async function bench(label, fn) {
	const ttfb = [];
	const inter = [];
	const elapsed = [];
	for (let i = 0; i < N; i++) {
		const startedAt = Date.now();
		let first = 0;
		let prev = 0;
		const stream = fn(model, ctx, opts);
		for await (const e of stream) {
			if (e.type === "text_delta") {
				const now = Date.now() - startedAt;
				if (first === 0) first = now;
				else inter.push(now - prev);
				prev = now;
			}
			if (e.type === "done" || e.type === "error") break;
		}
		ttfb.push(first);
		elapsed.push(Date.now() - startedAt);
	}
	const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
	console.log(`${label.padEnd(35)} ttfb=${avg(ttfb)}ms inter=${inter.length ? avg(inter) : 0}ms elapsed=${avg(elapsed)}ms`);
}

console.log("=== undici.Agent variants ===");
await bench("default (4s keepalive)", fetchWithAgent(baseUrl, {}));
await bench("keepAliveTimeout 30s", fetchWithAgent(baseUrl, { keepAliveTimeout: 30_000 }));
await bench("keepAliveTimeout 60s", fetchWithAgent(baseUrl, { keepAliveTimeout: 60_000 }));
await bench("keepAliveMaxTimeout 5min", fetchWithAgent(baseUrl, { keepAliveMaxTimeout: 300_000 }));
await bench("HTTP/2 enabled", fetchWithAgent(baseUrl, { allowH2: true }));
await bench("HTTP/2 + keepalive 60s", fetchWithAgent(baseUrl, { allowH2: true, keepAliveTimeout: 60_000 }));
await bench("shorter headersTimeout (5s)", fetchWithAgent(baseUrl, { headersTimeout: 5_000 }));
await bench("no keepalive (force fresh)", fetchWithAgent(baseUrl, { keepAliveTimeout: 0 }));
