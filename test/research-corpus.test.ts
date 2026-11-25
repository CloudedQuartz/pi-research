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
import { formatJournal, harvestUrls, queueUrls } from "../src/research-host.js";
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
	for (const id of cited) assert.ok(byId.has(id), `cited id ${id} resolves to a packet passage`);
	assert.ok(
		cited.some((id) => byId.get(id)!.sourceId === waterId),
		"the need cites at least one passage from the delegated source",
	);
});

check("a delegated page that only duplicates an existing source adds no passages", () => {
	const library = new EvidenceLibrary();
	library.addSource({ url: "https://example.org/water", title: "Field trial", text: WATER, retrievedAt: "2026-11-25T00:00:00.000Z" });
	const count = library.passages.length;
	const again = library.addSource({ url: "https://example.org/water-copy", title: "Field trial (mirror)", text: WATER, retrievedAt: "2026-11-25T00:00:00.000Z" });
	assert.ok(["alias", "near-duplicate"].includes(again.status), `a copy is recognised (${again.status})`);
	assert.equal(library.passages.length, count, "a copy does not inflate the corpus");
});


check("a delegated reply yields clean, unique, capped page URLs", () => {
	const reply = `I found three useful pages.
- https://example.org/acoustic-trial (field data)
- https://example.org/satellite-pilot.
- <https://example.org/pressure-management>
- https://example.org/acoustic-trial
Trailing punctuation, https://example.org/report; and duplicates must not survive.`;
	const urls = harvestUrls(reply, 12);
	assert.deepEqual(urls, [
		"https://example.org/acoustic-trial",
		"https://example.org/satellite-pilot",
		"https://example.org/pressure-management",
		"https://example.org/report",
	], "normalized, deduplicated, punctuation stripped");
	assert.equal(harvestUrls(reply, 2).length, 2, "the cap is honoured");
	assert.deepEqual(harvestUrls("No links here."), [], "a reply without URLs contributes nothing");
});


check("a one-sentence finding survives and a stub does not", () => {
	const library = new EvidenceLibrary();
	library.addSource({
		url: "https://example.org/finding",
		title: "Short finding",
		text: "Acoustic loggers cut non-revenue water by 12% across 240 repairs in the district.",
		retrievedAt: "2026-11-25T00:00:00.000Z",
	});
	assert.ok(library.passages.length > 0, "a compact finding is citable evidence");

	const stub = new EvidenceLibrary();
	const result = stub.addSource({ url: "https://example.org/stub", title: "Stub", text: "Home About", retrievedAt: "2026-11-25T00:00:00.000Z" });
	assert.equal(result.status, "empty", "a handful of words is not a source");
	assert.equal(stub.passages.length, 0);
	assert.equal(stub.sources.size, 0, "an unusable page is not kept in the corpus");
});

check("a measurement table with labels survives the filter", () => {
	const library = new EvidenceLibrary();
	library.addSource({
		url: "https://example.org/table",
		title: "Reported savings",
		text: "Case A 12.0 1.8 0.9 2022 acoustic measured billing Case B 9.5 0.7 0.4 2023 satellite modelled production estimate",
		retrievedAt: "2026-11-25T00:00:00.000Z",
	});
	assert.ok(library.passages.length > 0, "numeric evidence with labels is kept");
});


check("a delegated page becomes a numbered citation in the report", () => {
	const loop = new ResearchLoop();
	loop.plan(JSON.stringify({ needs: [{ question: "What measured reductions do acoustic loggers report?", essential: true, queries: ["acoustic logger non-revenue water"] }] }));
	const stored = loop.library.addSource({
		url: "https://example.org/delegated-trial",
		title: "Delegated field trial",
		text: "Acoustic loggers cut non-revenue water by 12% across 240 repairs, measured from billed consumption over two years.",
		retrievedAt: "2026-11-25T00:00:00.000Z",
	});
	assert.equal(stored.status, "added");

	const packet = loop.evidence();
	const cited = packet.needs.flatMap((need) => need.passages);
	assert.ok(cited.length > 0, "the delegated page is cited by the need");

	const passages = packet.passages.map((passage) => ({ ...passage, source: loop.library.sources.get(passage.sourceId)! }));
	const report = renderReport(`Claim [${cited[0]}].`, passages, []);
	assert.ok(report.includes("[1](#evidence-1)"), "the citation resolves to a numbered link");
	assert.ok(report.includes("https://example.org/delegated-trial"), "the entry names the delegated URL");
	assert.ok(!report.includes("unresolved"), "nothing is left unresolved");
});


check("/research-view lists a delegated source under its round", () => {
	const lines = formatJournal({
		question: "Compare three approaches",
		status: "complete",
		startedAt: Date.now() - 60_000,
		finishedAt: Date.now(),
		rounds: [{ round: 2, queries: ["q"], sources: [], failures: [], passages: 3, totalSources: 11 }],
		assessments: [],
		inspections: [],
		delegations: [{ round: 2, added: [{ url: "https://example.org/delegated", title: "Delegated page", passages: 3 }], failed: [], skipped: [{ url: "https://example.org/dup", reason: "alias: already in the corpus" }] }],
		stopReason: "done",
	});
	const text = lines.join("\n");
	assert.ok(text.includes("Delegated sources"), "a section is rendered");
	assert.ok(text.includes("added 3 passages: Delegated page \u2014 https://example.org/delegated"), "the added page and its passage count are shown");
	assert.ok(text.includes("skipped: https://example.org/dup"), "a skipped page is shown with its reason");
});


check("a completion notification queues only new pages", () => {
	// What a subagent's completion report looks like: prose plus the pages it read.
	const notification = [
		"Subagent completed: acoustic evidence",
		"Found utility trials at https://example.org/trial-a and https://example.org/trial-b.",
		"Also saw https://example.org/trial-a again, and https://example.org/reused.",
	].join("\n");
	const queued = queueUrls(notification, ["https://example.org/reused"], 12);
	assert.deepEqual(queued, ["https://example.org/trial-a", "https://example.org/trial-b"], "new pages only, deduplicated");
	assert.equal(queueUrls(notification, [], 1).length, 1, "the cap is honoured");
	assert.deepEqual(queueUrls("No links", []), [], "a reply without pages queues nothing");
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;

check("a long question is clipped on a word boundary, not mid-word", () => {
	const question = `${"word ".repeat(90)}end`;
	const lines = formatJournal({
		question,
		status: "complete",
		startedAt: Date.now() - 1_000,
		finishedAt: Date.now(),
		rounds: [],
	} as never);
	const line = lines.find((entry) => entry.startsWith("Question:")) ?? "";
	assert.ok(line.endsWith("\u2026"), "the clip is marked");
	assert.ok(!/\s\S+\u2026$/.test(line.replace(/^Question: /, "")), "clipped at whitespace");
});
