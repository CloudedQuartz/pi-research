/**
 * Porter stemming, ported from origin/riya, and its effect on retrieval.
 * Offline: no network, no model calls.
 */
import assert from "node:assert/strict";
import { stem } from "../src/porter.js";
import { EvidenceLibrary } from "../src/research-library.js";

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

check("morphological variants collapse to one term", () => {
	assert.equal(stem("leaks"), "leak");
	assert.equal(stem("leaking"), "leak");
	assert.equal(stem("losses"), "loss");
	assert.equal(stem("detected"), stem("detection"));
	assert.equal(stem("measured"), stem("measure"));
});

check("numbers, identifiers and versions are not mangled", () => {
	for (const token of ["2023", "tt186", "zonescan", "v1.2", "epa"]) {
		assert.equal(stem(token), token.toLowerCase(), `${token} must survive`);
	}
});

check("Porter does not unify every family member, and that is recorded here", () => {
	// Known limitation: "leakage" stems to "leakag", so it does not meet "leak". Pinned so the
	// behaviour is explicit rather than surprising.
	assert.equal(stem("leakage"), "leakag");
	assert.notEqual(stem("leakage"), stem("leak"));
});

check("a query finds a passage written with a different inflection", () => {
	const library = new EvidenceLibrary();
	library.addSource({
		url: "https://example.org/leaks",
		title: "Field report",
		text: "Crews repaired 240 leaks last year, and the utility measured the water losses from billed consumption.",
		retrievedAt: "2026-11-25T00:00:00.000Z",
	});
	assert.ok(library.passages.length > 0, "the source produced a passage");
	assert.ok(library.retrieve("leak", 5).length > 0, "'leak' finds 'leaks'");
	assert.ok(library.retrieve("loss", 5).length > 0, "'loss' finds 'losses'");
	assert.equal(library.retrieve("analytics", 5).length, 0, "an unrelated term finds nothing");
});

check("stemming keeps retrieval order stable for equal passages", () => {
	const library = new EvidenceLibrary();
	library.addSource({ url: "https://a.example.org/x", title: "A", text: "Leak detection reduced losses across the utility.", retrievedAt: "2026-11-25T00:00:00.000Z" });
	library.addSource({ url: "https://b.example.org/y", title: "B", text: "Leaking pipes caused losses across the utility.", retrievedAt: "2026-11-25T00:00:00.000Z" });
	const first = library.retrieve("leak losses utility", 10).map((hit) => hit.passage.sourceId);
	const second = library.retrieve("leaks loss utilities", 10).map((hit) => hit.passage.sourceId);
	assert.deepEqual(first, second, "inflected and uninflected queries rank identically");
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;
