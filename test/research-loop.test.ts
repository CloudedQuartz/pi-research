/**
 * Offline checks for the research loop's stop policy and assessment contract.
 * No network, no model calls: run with `npm test`.
 */
import assert from "node:assert/strict";
import { ResearchLoop } from "../src/research-loop.js";

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

const packet = {
	needs: [{ id: 1, question: "Is there evidence?", passages: ["P1"] }],
	passages: [{ id: "P1", sourceId: "s1", start: 0, end: 10, text: "0123456789" }],
} as never;

const plan = (queries: string[]) => JSON.stringify({ needs: [{ question: "Is there evidence?", essential: true, queries }] });
const assessment = (queries: string[], answered = false) =>
	JSON.stringify({
		needs: [{ id: 1, answered, passages: answered ? ["P1"] : [], gap: "g", queries }],
		continueSearching: true,
		reason: "keep going",
	});

check("plan requires a question, queries and an essential need", () => {
	const loop = new ResearchLoop();
	assert.throws(() => loop.plan(JSON.stringify({ needs: [] })), /essential research need/);
	loop.plan(plan(["alpha"]));
	assert.equal(loop.needs.length, 1);
	assert.equal(loop.needs[0]?.essential, true);
});

check("answered needs with a cited passage stop the loop", () => {
	const loop = new ResearchLoop();
	loop.plan(plan(["alpha"]));
	assert.equal(loop.assess(assessment(["beta"], true), packet, true), false);
	assert.match(loop.stopReason, /every essential research need/);
});

check("two rounds with no new evidence stop the loop", () => {
	const loop = new ResearchLoop();
	loop.plan(plan(["alpha"]));
	assert.equal(loop.assess(assessment(["beta"]), packet, false), true, "first stalled round continues");
	assert.match(loop.stopReason, /^$/);
	assert.equal(loop.assess(assessment(["gamma"]), packet, false), false, "second stalled round stops");
	assert.match(loop.stopReason, /no new sources or passages/);
});

check("rounds that keep adding evidence are not cut off", () => {
	const loop = new ResearchLoop();
	loop.plan(plan(["alpha"]));
	for (const query of ["beta", "gamma", "delta", "epsilon"]) {
		assert.equal(loop.assess(assessment([query]), packet, true), true, `${query} keeps going`);
	}
	assert.equal(loop.stopReason, "");
});

check("no new queries stop the loop", () => {
	const loop = new ResearchLoop();
	loop.plan(plan(["alpha"]));
	loop.markSearched(["alpha"]);
	assert.equal(loop.assess(assessment([]), packet, true), false);
	assert.match(loop.stopReason, /No new search queries/);
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;
