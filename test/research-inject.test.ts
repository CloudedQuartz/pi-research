/**
 * Checks for /research-inject: the evidence records written into a report must be recoverable, and the
 * injected bundle must be bounded, because it becomes context that every later turn pays for.
 *
 * No network, no model calls: run with `npm test`.
 */
import assert from "node:assert/strict";
import { injectBundle, parseEvidenceRecords, renderReport } from "../src/research-evidence.js";

const failures: string[] = [];
const check = (label: string, run: () => void) => {
	try {
		run();
		console.log(`ok   ${label}`);
	} catch (error) {
		failures.push(label);
		console.error(`FAIL ${label}\n     ${error instanceof Error ? error.message : String(error)}`);
	}
};

const source = {
	url: "https://example.org/paper",
	title: "A paper",
	text: "",
	retrievedAt: "2026-11-26T00:00:00.000Z",
} as never;

const passage = (id: string, text: string) => ({
	id,
	source,
	start: 10,
	end: 20,
	text,
});

const report = renderReport(
	"The finding holds [P1]. A second point rests on the review [P2], and an invented id appears [P9].",
	[passage("P1", "The measured effect was 21 percent across three sites."), passage("P2", "A review reported the same direction.")],
	[],
);

check("a rendered report's evidence records are recoverable", () => {
	const records = parseEvidenceRecords(report);
	assert.equal(records.length, 2);
	assert.equal(records[0]!.title, "A paper");
	assert.equal(records[0]!.url, "https://example.org/paper");
	assert.match(records[0]!.quote, /21 percent/);
	assert.match(records[0]!.meta, /retrieved 2026-11-26/);
});

check("an unresolved citation does not become a record", () => {
	const records = parseEvidenceRecords(report);
	assert.equal(records.length, 2);
	assert.ok(!records.some((record) => record.quote.includes("unresolved")));
});

check("the bundle numbers records and states the question", () => {
	const bundle = injectBundle({ question: "Does it hold?", status: "complete", rounds: [1, 2] }, report, 10);
	assert.match(bundle, /Question: Does it hold\?/);
	assert.match(bundle, /Status: complete · 2 rounds/);
	assert.match(bundle, /\[1\] A paper/);
	assert.match(bundle, /\[2\] A paper/);
});

check("the limit bounds how many records are injected", () => {
	const bundle = injectBundle({ question: "q" }, report, 1);
	assert.match(bundle, /\[1\] A paper/);
	assert.ok(!/\[2\] /.test(bundle), "a second record leaked past the limit");
	assert.match(bundle, /Cited records: 1 of 2/);
});

check("a small character budget drops the tail rather than the header", () => {
	const bundle = injectBundle({ question: "q" }, report, 10, 120);
	assert.match(bundle, /Question: q/);
	assert.match(bundle, /further records omitted/);
	assert.ok(bundle.length < 1200, "the injected bundle was not bounded");
});

check("a run with no report says so instead of injecting nothing", () => {
	const bundle = injectBundle({ question: "q", status: "stopped" }, undefined, 10);
	assert.match(bundle, /Status: stopped/);
	assert.match(bundle, /no evidence records/);
});

if (failures.length) {
	console.error(`\n${failures.length} failure${failures.length === 1 ? "" : "s"}: ${failures.join(", ")}`);
	process.exitCode = 1;
}
