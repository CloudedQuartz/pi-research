/**
 * Offline checks for the research loop's stop policy and assessment contract.
 * No network, no model calls: run with `npm test`.
 */
import assert from "node:assert/strict";
import { MAX_ROUNDS, ResearchLoop, modelObject } from "../src/research-loop.js";

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

check("a run that never runs out of queries stops at the round limit", () => {
	const loop = new ResearchLoop();
	loop.plan(plan(["alpha"]));
	loop.markSearched(["alpha"]);
	// The assessment wants to continue and offers fresh queries each time.
	const keep = JSON.stringify({ needs: [{ id: 1, answered: false, passages: [], gap: "g", queries: ["alpha", "beta"] }], continueSearching: true, reason: "more" });
	assert.equal(loop.assess(keep, packet, true, 1), true);
	assert.equal(loop.assess(keep, packet, true, MAX_ROUNDS), false);
	assert.match(loop.stopReason, /round limit/);
});

check("a reply with a stray brace after the object still parses", () => {
	// This is the shape that ended a live run: valid JSON, then one extra closing brace.
	const parsed = modelObject('{"needs":[{"id":1,"answered":true}],"continueSearching":false}\n}');
	assert.equal(Array.isArray(parsed.needs), true);
});

check("a fenced reply with commentary around the object still parses", () => {
	const parsed = modelObject('Here is my assessment:\n```json\n{"needs":[],"continueSearching":false}\n```\nDone.');
	assert.deepEqual(parsed.needs, []);
});

check("a brace inside a string does not end the object early", () => {
	const parsed = modelObject('{"gap":"the { bracket } test","continueSearching":true} trailing');
	assert.equal(parsed.gap, "the { bracket } test");
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;

check("a partial assessment leaves the unjudged needs unanswered instead of throwing", () => {
	const loop = new ResearchLoop();
	loop.plan(JSON.stringify({ needs: [
		{ question: "First?", essential: true, queries: ["a"] },
		{ question: "Second?", essential: true, queries: ["b"] },
	] }));
	// Only the first need is judged; the reply is otherwise well formed.
	const partial = JSON.stringify({ needs: [{ id: 1, answered: false, passages: [], gap: "g", queries: ["a"] }], continueSearching: true, reason: "keep going" });
	// The stop decision itself follows the usual policy; what matters is that it returns instead of throwing.
	const stopping = loop.assess(partial, { needs: [{ id: 1, question: "First?", passages: ["P1"] }, { id: 2, question: "Second?", passages: [] }], passages: [], sources: [] } as never, false);
	assert.equal(typeof stopping, "boolean");
	assert.equal(loop.needs[1]?.answered, false);
	assert.match(loop.assessmentNotes.at(-1) ?? "", /judged 1 of 2 needs/);
});
