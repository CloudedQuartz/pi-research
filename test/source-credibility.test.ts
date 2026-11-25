/**
 * Offline checks for the source prior: kind of host, plus CRED-1's rating.
 * No network calls: the dataset ships with the package.
 */
import assert from "node:assert/strict";
import { EvidenceLibrary } from "../src/research-library.js";
import { credibilityOf, hostOf, resetTrancoCache } from "../src/source-credibility.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const TEXT = "A field trial reported a 12% reduction in non-revenue water across 240 repaired leaks, measured from billed consumption.";

check("CRED-1 lowers a flagged outlet and says why", () => {
	const result = credibilityOf("https://www.infowars.com/politics/");
	assert.equal(result.tier, "low");
	assert.ok(result.factor < 1, `factor is a penalty, got ${result.factor}`);
	assert.match(result.detail, /CRED-1/);
	assert.match(result.detail, /fake|conspiracy|unreliable|satire|rumor/);
});

check("an unrated host is neutral, not trusted or penalised", () => {
	const result = credibilityOf("https://example.org/some/page");
	assert.equal(result.tier, "neutral");
	assert.equal(result.factor, 1);
	assert.match(result.detail, /no independent rating/);
});

check("institutions, journals and aggregators are told apart", () => {
	assert.equal(credibilityOf("https://www.epa.gov/water").tier, "institution");
	assert.equal(credibilityOf("https://arxiv.org/abs/2406.05054").tier, "journal");
	assert.equal(credibilityOf("https://www.scribd.com/document/878122637/x").tier, "aggregator");
	assert.equal(hostOf("https://WWW.EPA.gov/a"), "epa.gov");
});

check("the prior reorders passages but never drops evidence", () => {
	const library = new EvidenceLibrary();
	library.addSource({ url: "https://www.infowars.com/post", title: "Flagged", text: `${TEXT} The outlet also disputed the municipal audit.`, retrievedAt: "2026-11-25T00:00:00.000Z" });
	library.addSource({ url: "https://www.epa.gov/report", title: "Agency", text: `${TEXT} The agency published the underlying meter readings.`, retrievedAt: "2026-11-25T00:00:00.000Z" });
	assert.equal(library.sources.size, 2, "both sources are kept");
	const hits = library.retrieve("reduction in non-revenue water leaks", 10);
	assert.equal(hits.length >= 2, true, "both passages are retrievable");
	assert.match(hits[0]!.passage.sourceId, /epa\.gov/, "the credible source ranks first");
});

check("the report states the reason next to the citation", () => {
	const library = new EvidenceLibrary();
	library.addSource({ url: "https://www.infowars.com/post", title: "Flagged outlet", text: TEXT, retrievedAt: "2026-11-25T00:00:00.000Z" });
	const source = [...library.sources.values()][0]!;
	const passage = library.passages[0]!;
	const numbered = { ...passage, id: "P1", source };
	const report = renderReport("Claim [P1].", [numbered], []);
	assert.match(report, /CRED-1 rates this outlet low/, "the entry carries the CRED-1 reason");
	assert.match(report, /infowars\.com/, "and the URL");
});


check("a local Tranco list ranks a known domain and lowers an unknown one", () => {
	const dir = mkdtempSync(join(tmpdir(), "tranco-"));
	const file = join(dir, "tranco.txt");
	writeFileSync(file, "1,google.com\n250,epa.gov\n9000,example.org\n");
	process.env.PI_RESEARCH_TRANCO = file;
	resetTrancoCache();

	const known = credibilityOf("https://example.org/page");
	assert.equal(known.tier, "neutral");
	assert.match(known.detail, /Tranco ranks this domain 9000/);
	assert.equal(known.factor, 1);

	const unknown = credibilityOf("https://periodlywise.com/blog/post");
	assert.equal(unknown.factor, 0.9, "an unlisted host ranks lower when a list is configured");
	assert.match(unknown.detail, /not in the local Tranco list/);

	delete process.env.PI_RESEARCH_TRANCO;
	resetTrancoCache();
	const unconfigured = credibilityOf("https://periodlywise.com/blog/post");
	assert.equal(unconfigured.factor, 1, "with no list configured nothing is penalised");
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join("; ")}` : "\nall cases passed");
if (failures.length) process.exitCode = 1;
