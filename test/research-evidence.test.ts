/**
 * Offline checks for report rendering: a citation must stay a citation.
 * No network, no model calls: run with `npm test`.
 */
import assert from "node:assert/strict";
import { renderReport } from "../src/research-evidence.js";

const failures: string[] = [];
const check = (label: string, run: () => void) => {
	try {
		run();
		console.log(`ok   ${label}`);
	} catch (error) {
		failures.push(label);
		console.log(`FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`);
	}
};

const source = (id: string) => ({
	id,
	kind: "unclassified" as const,
	aliases: [],
	url: `https://example.org/${id}`,
	title: `Source ${id}`,
	text: "",
	retrievedAt: "2026-11-25T00:00:00.000Z",
});

const LONG = Array.from({ length: 120 }, (_, index) => `Sentence ${index} carries a claim about water loss.`).join(" ");
const passage = (id: string, text: string, start: number, end: number) => ({ id, source: source("s1"), start, end, text });

check("a long citation quotes a bounded excerpt, not the whole span", () => {
	const report = renderReport("Claim [P1].", [passage("P1", LONG, 0, LONG.length)], []);
	const quoted = report
		.split("\n")
		.filter((line) => line.startsWith("> "))
		.map((line) => line.slice(2))
		.join("\n");
	assert.ok(quoted.length > 0, "a quote is present");
	assert.ok(quoted.length <= 720, `quote is bounded, got ${quoted.length}`);
	assert.ok(quoted.endsWith("\u2026"), "a clipped quote is marked as clipped");
	assert.ok(!quoted.includes("Sentence 119"), "the tail of the span is not reprinted");
});

check("the excerpt keeps its anchor, source line and offsets", () => {
	const report = renderReport("Claim [P1].", [passage("P1", LONG, 120, 120 + LONG.length)], []);
	assert.ok(report.includes("[1](#evidence-1)"), "citation links to the entry");
	assert.ok(report.includes('<a id="evidence-1"></a>'), "anchor exists");
	assert.ok(report.includes("https://example.org/s1 \u00b7 retrieved 2026-11-25 \u00b7 text offsets 120"), "source and offsets survive");
});

check("a short passage is quoted whole", () => {
	const short = "Only one sentence, quoted in full.";
	const report = renderReport("Claim [P1].", [passage("P1", short, 0, short.length)], []);
	assert.ok(report.includes(`> ${short}`), "short quote is not clipped");
	assert.ok(!report.includes("\u2026"), "short quote has no ellipsis");
});

check("a literal-match inspection lists matches without reprinting text", () => {
	const inspection = {
		id: "I1",
		sourceId: "s1",
		sourceVersion: "s1",
		start: 0,
		end: 90000,
		matches: [{ term: "correntropy", count: 39, firstOffsets: [] }],
		source: source("s1"),
	};
	const report = renderReport("Checked [I1].", [], [inspection as never]);
	assert.ok(report.includes("Literal matches in the stored extraction"), "matches are listed");
	assert.ok(report.includes('"correntropy" (39)'), "the match count is reported");
	assert.ok(!report.includes("> "), "no page of source text is reprinted");
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;
