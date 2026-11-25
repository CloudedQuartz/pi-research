/**
 * Offline checks that a page added late still reaches the evidence packet.
 *
 * This is the property a delegated source depends on: a page fetched after the
 * round's packet was built must become passages, must be retrievable for a need,
 * and must be citable. No network, no model calls: run with `npm test`.
 */
import assert from "node:assert/strict";
import { EvidenceLibrary } from "../src/research-library.js";
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

const WATER = [
	"A field trial of acoustic loggers reported a 12% reduction in non-revenue water across 240 repaired leaks.",
	"The utility measured the saving from billed consumption over two years rather than modelling it from production.",
	"An independent review found the billing records supported the realized saving.",
].join(" ");

const SATELLITE = [
	"A satellite leak-detection pilot reported 40 confirmed leaks in six months and a modelled saving of 0.7 million.",
	"The operator describes the saving as provisional pending a second year of billed data, so it is not yet realized.",
].join(" ");

check("a newly added source becomes passages with exact offsets", () => {
	const library = new EvidenceLibrary();
	assert.equal(library.passages.length, 0);
	const result = library.addSource({ url: "https://example.org/water", title: "Field trial", text: WATER, retrievedAt: "2026-11-25T00:00:00.000Z" });
	assert.equal(result.status, "added");
	assert.ok(result.sourceId, "the source has a library id");
	assert.ok(library.passages.length > 0, "passages were created");
	for (const passage of library.passages) {
		assert.equal(passage.text, WATER.slice(passage.start, passage.end), "offsets point at the quoted text");
		assert.ok(passage.text.trim().length > 0, "no empty passage");
	}
});

check("a page added after the packet was built still appears in the next packet", () => {
	const loop = new ResearchLoop();
	loop.plan(JSON.stringify({ needs: [{ question: "What measured reductions do acoustic loggers report?", essential: true, queries: ["acoustic logger non-revenue water"] }] }));
	const satellite = loop.library.addSource({ url: "https://example.org/satellite", title: "Satellite pilot", text: SATELLITE, retrievedAt: "2026-11-25T00:00:00.000Z" });
	assert.ok(satellite.sourceId);

	const before = loop.evidence();
	const beforeSources = new Set(before.passages.map((passage) => passage.sourceId));
	assert.ok(!beforeSources.has("water"), "the delegated page is not in the packet yet");

	// This is what research_add_urls does for a page a subagent found.
	const water = loop.library.addSource({ url: "https://example.org/water", title: "Field trial", text: WATER, retrievedAt: "2026-11-25T00:00:00.000Z" });
	const waterId = water.sourceId!;
	assert.ok(waterId, "the delegated page has a library id");
	const after = loop.evidence();

	const afterSources = new Set(after.passages.map((passage) => passage.sourceId));
	assert.ok(afterSources.has(waterId), "the delegated source is now in the packet");
	const cited = after.needs.flatMap((need) => need.passages);
	assert.ok(cited.length > 0, "the need cites passages from the packet");
	const byId = new Map(after.passages.map((passage) => [passage.id, passage]));
	for (const id of cited) {
		assert.ok(byId.has(id), `cited id ${id} resolves to a packet passage`);
		assert.equal(byId.get(id)!.sourceId, waterId, `cited ${id} came from the delegated source`);
	}
});

check("a delegated page that only duplicates an existing source adds no passages", () => {
	const library = new EvidenceLibrary();
	library.addSource({ url: "https://example.org/water", title: "Field trial", text: WATER, retrievedAt: "2026-11-25T00:00:00.000Z" });
	const count = library.passages.length;
	const again = library.addSource({ url: "https://example.org/water-copy", title: "Field trial (mirror)", text: WATER, retrievedAt: "2026-11-25T00:00:00.000Z" });
	assert.ok(["alias", "near-duplicate"].includes(again.status), `a copy is recognised (${again.status})`);
	assert.equal(library.passages.length, count, "a copy does not inflate the corpus");
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;
