import assert from "node:assert/strict";
import { test } from "node:test";
import { auditReport } from "../scripts/citation-audit.js";

const report = [
	"# Title",
	"",
	"The first claim is supported [1](#evidence-1) by a source.",
	"An uncited sentence that asserts something without any evidence at all.",
	"",
	"| a | b |",
	"|---|---|",
	"| 1 | 2 |",
	"",
	"## Evidence",
	'#### <a id="evidence-1"></a>[1] Source',
].join("\n");

test("counts cited and uncited body sentences, ignoring headings and tables", () => {
	const audit = auditReport("r.md", report);
	assert.equal(audit.bodySentences, 2);
	assert.equal(audit.citedSentences, 1);
	assert.equal(audit.uncitedSentences, 1);
	assert.equal(audit.uncitedShare, 0.5);
});

test("a link without an anchor is dangling, an anchor without a link is unused", () => {
	assert.deepEqual(auditReport("r.md", report).dangling, []);
	assert.deepEqual(auditReport("r.md", report).unused, []);

	const broken = report.replace('id="evidence-1"', 'id="evidence-2"');
	const audit = auditReport("r.md", broken);
	assert.deepEqual(audit.dangling, ["1"]);
	assert.deepEqual(audit.unused, ["2"]);
});

test("unresolved passage ids left in the body are counted", () => {
	const audit = auditReport("r.md", report.replace("by a source", "by [P9] and [I3]"));
	assert.equal(audit.unresolvedMarkers, 2);
});

test("any uncited sentence carrying a figure or an attribution counts as an uncited claim", () => {
	const text = [
		"# T",
		"The coefficient was 3.78e-7 per passenger [1](#evidence-1).",
		"That specification implies roughly 21% more employment at this scale.",
		"Airports raise regional GDP by 1.3%.",
		"## Evidence",
		'#### <a id="evidence-1"></a>[1] Src',
	].join("\n");
	const audit = auditReport("r.md", text);
	// Both uncited sentences state a figure, so under this definition both are claims. Being derived
	// from a cited figure does not let a number into a report without saying where it came from.
	assert.equal(audit.uncitedClaims, 2);
	assert.equal(audit.uncitedReasoning, 0);
});
