#!/usr/bin/env node
/**
 * SearXNG-shaped search endpoint backed by Exa's keyless MCP search.
 *
 * drsh's searxng engine only needs {results:[{title,url,content}]}; public
 * SearXNG instances answer automated clients with bot challenges, so this
 * serves the same JSON from https://mcp.exa.ai and drsh points SEARXNG_URL here.
 *
 * Exa's keyless endpoint rate-limits bursts (429), so requests are queued with
 * bounded concurrency, retried with exponential backoff, and identical queries
 * are served from a short-lived cache. That keeps several parallel drsh runs
 * working without hammering the shared pool.
 *
 * Usage: node exa_searxng.mjs [port]
 */

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8788);
const MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const MAX_INFLIGHT = 2;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 1;  // Exa is either up or saturated; a 429 goes straight to degoog

const cache = new Map();
const queue = [];
let inflight = 0;

function schedule(task) {
	return new Promise((resolve, reject) => {
		queue.push({ task, resolve, reject });
		pump();
	});
}

function pump() {
	while (inflight < MAX_INFLIGHT && queue.length) {
		const job = queue.shift();
		inflight += 1;
		Promise.resolve()
			.then(job.task)
			.then(job.resolve, job.reject)
			.finally(() => {
				inflight -= 1;
				pump();
			});
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exaCall(query, numResults) {
	const response = await fetch(MCP_URL, {
		signal: AbortSignal.timeout(8000),
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": "pi-web-access",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query, numResults } },
		}),
	});
	if (response.status === 429) throw Object.assign(new Error("exa mcp 429"), { retryable: true });
	if (!response.ok) throw new Error(`exa mcp ${response.status}`);

	const body = await response.text();
	const payload = body
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter(Boolean)
		.pop();
	if (!payload && !body.trim().startsWith("{")) throw new Error("empty exa reply");
	const rpc = JSON.parse(payload ?? body);
	if (rpc.error) throw new Error(rpc.error.message ?? "exa mcp error");

	const text = (rpc.result?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return parseBlocks(text);
}

async function degoogSearch(query, numResults) {
	const response = await fetch("https://degoog.org/api/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ query, type: "web", page: 1 }),
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`degoog ${response.status}`);
	const data = await response.json();
	const entries = Array.isArray(data?.results) ? data.results : [];
	return entries
		.filter((e) => e?.url)
		.slice(0, numResults)
		.map((e) => ({
			title: e.title ?? e.url,
			url: e.url,
			content: (e.snippet ?? e.content ?? "").slice(0, 2000),
			engine: "degoog",
			score: 1,
		}));
}

async function search(query, numResults) {
	const key = `${query}\u0000${numResults}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;

	return schedule(async () => {
		let lastError;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			try {
				const results = await exaCall(query, numResults);
				if (results.length === 0) throw Object.assign(new Error("exa empty"), { retryable: false });
				cache.set(key, { at: Date.now(), results });
				return results;
			} catch (error) {
				lastError = error;
				if (!error.retryable) throw error;
				await sleep(500);
			}
		}
		// Exa's shared pool stayed unavailable: fall back to the keyless degoog
		// metasearch instance rather than failing the whole research run.
		const results = await degoogSearch(query, numResults);
		cache.set(key, { at: Date.now(), results });
		return results;
	});
}

/** Exa's text reply is a flat list of blocks beginning with "Title: ". */
function parseBlocks(text) {
	const results = [];
	let current = null;
	let collecting = false;
	for (const line of text.split("\n")) {
		const field = /^(Title|URL|Published|Author):\s*(.*)$/.exec(line);
		if (field && field[1] === "Title") {
			if (current) results.push(current);
			current = { title: field[2], url: "", content: "" };
			collecting = false;
			continue;
		}
		if (!current) continue;
		if (field) {
			if (field[1] === "URL") current.url = field[2];
			continue;
		}
		if (/^Highlights:?/.test(line) || /^Text:?/.test(line)) {
			collecting = true;
			continue;
		}
		if (collecting) current.content += `${line}\n`;
	}
	if (current) results.push(current);
	return results
		.filter((r) => r.url)
		.map((r) => ({
			title: r.title,
			url: r.url,
			content: r.content.trim().slice(0, 2000),
			engine: "exa-mcp",
			score: 1,
		}));
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
	if (!url.pathname.startsWith("/search")) {
		res.writeHead(404).end();
		return;
	}
	const query = url.searchParams.get("q") ?? "";
	const limit = Number(url.searchParams.get("limit") ?? 10);
	try {
		const results = await search(query, Math.min(Math.max(limit, 1), 20));
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				query,
				number_of_results: results.length,
				results,
				unresponsive_engines: [],
			}),
		);
	} catch (error) {
		res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String(error), results: [] }));
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`exa→searxng adapter on http://127.0.0.1:${PORT}/search (cache + retry)`);
});
