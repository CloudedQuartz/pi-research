/**
 * Offline RPC regression for the tool-using /research workflow.
 *
 * Runs the real Pi CLI in RPC mode with:
 *   - the project extension at .pi/extensions/research.ts,
 *   - a local mock OpenAI-compatible provider (loopback HTTP only),
 *   - mock web_search / fetch_content / get_search_content tools.
 *
 * The scripted model emits a brief, two search rounds, page reads, a passage
 * lookup, and a final report. The test checks that the native tool loop ran,
 * tool results reached the next model request, the report appeared in the
 * conversation, and the extension saved it as Markdown.
 *
 * Run: node test/research-rpc.mjs
 * No paid calls, provider credentials, package installs, or non-loopback
 * network requests are used.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESEARCH_EXTENSION = join(ROOT, ".pi/extensions/research.ts");
const MOCK_EXTENSION = join(ROOT, "test/mock-research-extensions.mjs");

const BRIEF = `## Research brief

**What the report must settle:** whether mock utilities that deployed leak detection report realized economic outcomes, and whether those outcomes are comparable.

**Evidence that would count:** documented cases with a baseline, programme cost, measured water reduction, and a stated measurement method. Realized billing records are stronger than modelled projections.

**Comparisons and likely traps:** the two cases use different water-loss definitions, price assumptions, and measurement periods, so ranking their savings as one measure would be misleading.

**Search plan:** first search for mock deployed cases and reported outcomes; then read the case pages and the independent review; follow up on missing measurement details. The conclusion would change if the realized outcome were only a projection or if the review could not verify the billing records.`;

const REPORT = `# Mock evidence on utility leak-detection outcomes

The mock evidence supports a narrow conclusion: one utility reports a realized, billing-based saving from acoustic leak detection, while a second utility reports only a modelled estimate from a satellite pilot. The two results should not be ranked as a single measure because their water-loss definitions, price assumptions, and measurement methods differ [1][2][3].

## Case A: acoustic sensors and realized savings

Mock Case A deployed acoustic sensors in 2022 and reported a 12% reduction in non-revenue water. The reported realized saving was 1.8 million USD over two years against a 0.9 million USD programme cost. The baseline was the 2019-2021 average, and the utility says the result is measured from billed consumption rather than a projection [1]. The independent review says this outcome was supported by two years of billing records [3].

## Case B: satellite pilot and estimated savings

Mock Case B piloted satellite leak detection in 2023. It reported 40 confirmed leaks in the first six months and an estimated 0.7 million USD annual saving. The estimate is modelled from avoided water production and has not been verified against billed consumption; the programme cost was 0.4 million USD [2]. The review therefore treats the Case B saving as a projection, not a realized outcome [3].

## Comparison

The cases differ in technology, period, and measurement. Case A has a two-year billing record and a stated baseline; Case B has a six-month leak count and a modelled annual figure. Their reported savings also rest on different water-loss definitions and price assumptions. A table that places 1.8 million USD beside 0.7 million USD would imply a comparability the evidence does not establish [1][2][3].

| Dimension | Case A | Case B |
|---|---|---|
| Technology | Acoustic sensors | Satellite detection |
| Reported result | 12% non-revenue water reduction | 40 confirmed leaks in six months |
| Economic figure | 1.8 million USD realized over two years | 0.7 million USD annual estimate |
| Measurement | Billed consumption, 2019-2021 baseline | Modelled avoided production |
| Independent check | Billing records supported | Projection remained unverified |

## Recommendations

1. Treat Case A as evidence that a realized saving can be documented when billing data and a baseline are available.
2. Treat Case B as a promising pilot, not as evidence of a realized saving.
3. Require the same water-loss definition, price basis, and measurement period before comparing programmes.
4. Ask for the underlying billing or production data before using either figure in a financial decision.

## Limitations

The evidence is mock material created for an offline test; it is not a real utility study. The review covers only two cases and does not establish a general effect. Case B's projection could become a realized outcome if later billing data confirm it. A broader sample with consistent definitions would be needed to generalize.

## Sources

[1] Mock Case A - https://example.org/case-a (retrieved 2025-01-01)
[2] Mock Case B - https://example.org/case-b (retrieved 2025-01-01)
[3] Mock Verification - https://example.org/verification (retrieved 2025-01-01)`;

const SCRIPT = [
	{
		text: BRIEF,
		tool: {
			name: "web_search",
			arguments: { queries: ["mock utility leak detection realized savings", "mock water utility AI outcomes"] },
		},
	},
	{
		text: "**Gap check:** The search identifies two cases and an independent review. Case A reports a realized, billing-based saving; Case B reports an estimate. I still need the exact programme costs and the review's comparability warning, so I will read the case pages next.",
		tool: {
			name: "fetch_content",
			arguments: { urls: ["https://example.org/case-a", "https://example.org/case-b"] },
		},
	},
	{
		text: "**Gap check:** The case pages provide the costs and measurement methods, but the exact supporting sentence for the realized-saving claim should be checked against the stored passage. I will locate it, then search for independent verification to avoid relying on either utility's self-report.",
		tool: {
			name: "get_search_content",
			arguments: { responseId: "mock-fetch-1", findText: ["realized saving", "billing records"] },
		},
	},
	{
		text: "**Gap check:** The stored passage confirms the billing-based claim for Case A and the projection for Case B. One gap remains: independent confirmation that the two outcomes are not comparable. I will run a follow-up search for that verification.",
		tool: {
			name: "web_search",
			arguments: { query: "mock independent verification realized versus projected utility savings" },
		},
	},
	{ text: REPORT },
];

const failures = [];
const check = (label, condition) => {
	if (condition) {
		console.log(`ok   ${label}`);
	} else {
		failures.push(label);
		console.log(`FAIL ${label}`);
	}
};

const tempRoot = mkdtempSync(join(tmpdir(), "pi-research-rpc-"));
const cwd = join(tempRoot, "cwd");
const agentDir = join(tempRoot, "agent");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const requests = [];
let child;
let server;

const json = (value) => `${JSON.stringify(value)}\n`;

function chunkBase() {
	return {
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "mock-research",
	};
}

function sendStreamingTurn(res, turn) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	if (turn.text) {
		res.write(`data: ${JSON.stringify({ ...chunkBase(), choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }] })}\n\n`);
	}
	if (turn.tool) {
		res.write(
			`data: ${JSON.stringify({
				...chunkBase(),
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "mock-call",
									type: "function",
									function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
								},
							],
						},
						finish_reason: null,
					},
				],
			})}\n\n`,
		);
	}
	res.write(
		`data: ${JSON.stringify({
			...chunkBase(),
			choices: [{ index: 0, delta: {}, finish_reason: turn.tool ? "tool_calls" : "stop" }],
		})}\n\n`,
	);
	res.write(
		`data: ${JSON.stringify({
			...chunkBase(),
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		})}\n\n`,
	);
	res.write("data: [DONE]\n\n");
	res.end();
}

function sendJsonTurn(res, turn) {
	const message = { role: "assistant", content: turn.text ?? null };
	if (turn.tool) {
		message.tool_calls = [
			{
				id: "mock-call",
				type: "function",
				function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.arguments) },
			},
		];
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			id: "chatcmpl-mock",
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: "mock-research",
			choices: [{ index: 0, message, finish_reason: turn.tool ? "tool_calls" : "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		}),
	);
}

server = createServer((req, res) => {
	const body = [];
	req.on("data", (part) => body.push(part));
	req.on("end", () => {
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(Buffer.concat(body).toString("utf8"));
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "bad json" } }));
			return;
		}
		const turnIndex = requests.length;
		requests.push(parsed);
		const turn = SCRIPT[Math.min(turnIndex, SCRIPT.length - 1)];
		if (parsed.stream === false) sendJsonTurn(res, turn);
		else sendStreamingTurn(res, turn);
	});
});

const port = await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const records = [];
const toolStarts = [];
const toolEnds = [];
const assistantTexts = [];
const uiMessages = [];
let settled = false;
let lastAssistantText;
let exitCode;
let stderr = "";

let settleResolve;
const settleSignal = new Promise((resolve) => {
	settleResolve = resolve;
	const timer = setTimeout(resolve, 60000);
	timer.unref?.();
});
const settle = () => {
	if (!settled) {
		settled = true;
		settleResolve();
	}
};

try {
	child = spawn(process.env.PI_BIN || "pi", [
		"--mode", "rpc",
		"--no-session",
		"--no-extensions",
		"-e", MOCK_EXTENSION,
		"-e", RESEARCH_EXTENSION,
		"--model", "mock-research/mock-research",
		"--no-builtin-tools",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--offline",
	], {
		cwd,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			MOCK_BASE_URL: `http://127.0.0.1:${port}/v1`,
			NO_COLOR: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (data) => {
		buffer += data;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			records.push(record);
			if (record.type === "tool_execution_start") toolStarts.push(record);
			if (record.type === "tool_execution_end") toolEnds.push(record);
			if (record.type === "message_end" && record.message?.role === "assistant") {
				const text = (record.message.content ?? [])
					.filter((part) => part?.type === "text")
					.map((part) => part.text)
					.join("\n")
					.trim();
				if (text) assistantTexts.push(text);
			}
			if (record.type === "extension_ui_request") uiMessages.push(record);
			if (record.type === "response" && record.command === "get_last_assistant_text" && record.success) {
				lastAssistantText = record.data?.text;
			}
			if (record.type === "agent_settled") settle();
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	child.once("exit", (code) => {
		exitCode = code;
		settleResolve();
	});

	await new Promise((resolve) => setTimeout(resolve, 300));
	child.stdin.write(json({ id: "prompt-1", type: "prompt", message: "/research Does the mock evidence support comparing the two utility outcomes?" }));
	await settleSignal;

	// The settled handler writes the report asynchronously; allow it to finish.
	let reportPath;
	for (let attempt = 0; attempt < 50; attempt++) {
		const directory = join(cwd, ".pi", "research");
		if (existsSync(directory)) {
			const files = readdirSync(directory).filter((name) => name.endsWith(".md"));
			if (files.length > 0) {
				reportPath = join(directory, files[0]);
				break;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	child.stdin.write(json({ id: "last", type: "get_last_assistant_text" }));
	for (let attempt = 0; attempt < 30 && lastAssistantText === undefined; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const searchStarts = toolStarts.filter((event) => event.toolName === "web_search");
	const readStarts = toolStarts.filter((event) => event.toolName === "fetch_content");
	const passageStarts = toolStarts.filter((event) => event.toolName === "get_search_content");
	const report = reportPath && existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";

	check("native RPC run settled", settled);
	check("Pi stayed running until the run settled", exitCode === undefined);
	check("model provider received at least 5 requests (iterative loop)", requests.length >= 5);
	check("web_search ran in two rounds", searchStarts.length === 2);
	check("fetch_content read the case pages", readStarts.length === 1);
	check("get_search_content located stored passages", passageStarts.length === 1);
	check("no tool execution errors", toolEnds.every((event) => event.isError !== true));
	check("the brief appeared in the conversation", assistantTexts.some((text) => text.includes("## Research brief")));
	check("a gap check appeared after the first round", assistantTexts.some((text) => text.includes("**Gap check:**")));
	check("the final report appeared in the conversation", assistantTexts.some((text) => text.includes("# Mock evidence on utility leak-detection outcomes")));
	check("last assistant text matches the scripted report", typeof lastAssistantText === "string" && lastAssistantText.trim() === REPORT.trim());
	check("the report was saved as Markdown", reportPath !== undefined && report.length > 0);
	check("saved Markdown matches the final assistant message", report.trim() === REPORT.trim());
	check("saved report contains the title and sources", report.includes("# Mock evidence on utility leak-detection outcomes") && report.includes("## Sources"));
	check("saved report contains checkable URLs", ["https://example.org/case-a", "https://example.org/case-b", "https://example.org/verification"].every((url) => report.includes(url)));
	check("saved report is substantial (250+ words)", report.trim().split(/\s+/).filter(Boolean).length >= 250);
	check("first tool result reached the next model request", requests[1]?.messages?.some((message) => message.role === "tool" && String(message.content).includes("Mock search results")) === true);
	check("page-read result reached the next model request", requests[2]?.messages?.some((message) => message.role === "tool" && String(message.content).includes("Mock Case A")) === true);
	check("passage result reached the next model request", requests[3]?.messages?.some((message) => message.role === "tool" && String(message.content).includes("Mock passage hits")) === true);
	check("follow-up search result reached the next model request", requests[4]?.messages?.some((message) => message.role === "tool" && String(message.content).includes("mock independent verification")) === true);
	check("the saved-path notice was emitted", uiMessages.some((record) => JSON.stringify(record).includes("Report saved:")));

	if (!settled) {
		console.error("\nNo agent_settled event before timeout.");
	}
	if (failures.length > 0) {
		console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
		if (stderr.trim()) console.error(`\nPi stderr:\n${stderr}`);
		process.exitCode = 1;
	} else {
		console.log("\nall checks passed");
	}
} finally {
	if (child && child.exitCode === null && !child.killed) {
		child.stdin.end();
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 3000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
	await new Promise((resolve) => server.close(resolve));
	rmSync(tempRoot, { recursive: true, force: true });
}
