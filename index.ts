import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	{
		id: "MiniMax-M2.7-highspeed",
		name: "MiniMax M2.7 (Highspeed)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.60, output: 2.40, cacheRead: 0.06, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
	{
		id: "MiniMax-M2.5",
		name: "MiniMax M2.5",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
	{
		id: "MiniMax-M2.5-highspeed",
		name: "MiniMax M2.5 (Highspeed)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.60, output: 2.40, cacheRead: 0.03, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
	{
		id: "MiniMax-M2.1",
		name: "MiniMax M2.1",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
	{
		id: "MiniMax-M2.1-highspeed",
		name: "MiniMax M2.1 (Highspeed)",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.60, output: 2.40, cacheRead: 0.03, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
	{
		id: "MiniMax-M2",
		name: "MiniMax M2",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0.30, output: 1.20, cacheRead: 0.03, cacheWrite: 0.375 },
		contextWindow: 204800,
		maxTokens: 65536,
	},
];

export default function (pi: ExtensionAPI) {
	const host = (process.env.MINIMAX_API_HOST || DEFAULT_API_HOST).replace(/\/$/, "");

	pi.registerProvider("minimax", {
		baseUrl: `${host}/anthropic`,
		apiKey: "$MINIMAX_API_KEY",
		api: "anthropic-messages",
		models: MODELS,
	});
}
