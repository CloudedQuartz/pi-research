#!/usr/bin/env node
/**
 * Header-injecting proxy for OpenCode Go's OpenAI-compatible endpoint.
 *
 * opencode.ai/inference/go requires an `x-opencode-session` header on every
 * request (MissingSessionID error otherwise) and drsh has no custom-header
 * option. This forwards /v1/* to the OpenCode Go base URL, adds one session id
 * per process run, and streams the response straight back.
 *
 * Usage: node opencode_proxy.mjs [port]
 * Then point drsh at http://127.0.0.1:<port>/v1 with the OpenCode Go key.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8787);
const UPSTREAM = "https://opencode.ai/inference/go/openai/v1";
const SESSION = randomUUID();
const HOP_BY_HOP = new Set([
	"host",
	"connection",
	"content-length",
	"accept-encoding",
	"transfer-encoding",
	"keep-alive",
]);

const server = createServer(async (req, res) => {
	const path = req.url?.replace(/^\/v1/, "") ?? "";
	const target = `${UPSTREAM}${path}`;

	const headers = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (HOP_BY_HOP.has(key.toLowerCase())) continue;
		if (typeof value === "string") headers[key] = value;
	}
	headers["x-opencode-session"] = SESSION;

	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = chunks.length ? Buffer.concat(chunks) : undefined;

	try {
		const upstream = await fetch(target, { method: req.method, headers, body });
		const out = {};
		upstream.headers.forEach((value, key) => {
			if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) return;
			out[key] = value;
		});
		res.writeHead(upstream.status, out);
		if (upstream.body) {
			for await (const chunk of upstream.body) {
				if (res.destroyed) break;
				res.write(chunk);
			}
		}
		res.end();
	} catch (error) {
		// A stream that dies mid-response (upstream reset, client abort) has
		// already sent headers; writing them again crashed the whole proxy and
		// took every in-flight research run with it. Close the socket instead.
		if (res.headersSent) {
			res.destroy();
			return;
		}
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String(error) }));
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`opencode-go proxy on http://127.0.0.1:${PORT}/v1 (session ${SESSION})`);
});
