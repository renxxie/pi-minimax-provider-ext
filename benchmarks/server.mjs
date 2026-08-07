import { createServer } from "node:http";

const DELAY_MS = parseInt(process.env.MOCK_DELAY_MS ?? "50", 10);
const CHUNK_MS = parseInt(process.env.MOCK_CHUNK_INTERVAL_MS ?? "30", 10);
const TEXT = "Это ответ от mock-сервера для тестирования скорости стриминга токенов и общей задержки. ";
const CHUNKS = TEXT.split(""); // one event per character for fine-grained timing

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const key = req.headers["x-api-key"];
		if (!key || (!key.startsWith("test-") && key !== "fake-key")) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Transfer-Encoding": "chunked",
		});
		setTimeout(() => {
			res.write(
				'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
			);
			res.write(
				'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			);
			let i = 0;
			const sendNext = () => {
				if (i >= CHUNKS.length) {
					res.write(
						'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
					);
					res.write(
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":' + CHUNKS.length + '}}\n\n',
					);
					res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
					res.end();
					return;
				}
				res.write(
					`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${CHUNKS[i]}"}}\n\n`,
				);
				i++;
				setTimeout(sendNext, CHUNK_MS);
			};
			sendNext();
		}, DELAY_MS);
	});
});

server.listen(0, () => {
	const port = server.address().port;
	console.log(`MOCK_PORT=${port}`);
});
