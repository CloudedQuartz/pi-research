/**
 * Citation audit for a saved research report.
 *
 * The point of the pipeline is corpus-first synthesis: the report is written from ranked passages and
 * must say which one carries each claim. This measures how true that is for a given report instead of
 * trusting the renderer to have been used correctly.
 *
 * Reports the checks separately so a report cannot look clean on one and quietly fail another:
 *  - links/anchors: every `#evidence-N` link has an anchor, and every anchor is used
 *  - coverage: share of body sentences carrying at least one citation
 *  - unresolved: citation ids the renderer could not resolve (left as literal [P..]/[I..] markers)
 *
 * Run: npm run eval:citations -- <report.md>
 */
import { readFileSync } from "node:fs";

export interface CitationAudit {
	file: string;
	links: number;
	anchors: number;
	dangling: string[];
	unused: string[];
	bodySentences: number;
	citedSentences: number;
	uncitedSentences: number;
	uncitedShare: number;
	unresolvedMarkers: number;
}

/** The evidence appendix starts here; prose before it is what the reader actually reads. */
const EVIDENCE_HEADING = /^##+\s+Evidence\b/im;

export function auditReport(file: string, text: string): CitationAudit {
	const heading = EVIDENCE_HEADING.exec(text);
	const body = heading ? text.slice(0, heading.index) : text;

	const links = new Set(Array.from(text.matchAll(/\]\(#evidence-(\d+)\)/g), (match) => match[1]!));
	const anchors = new Set(
		Array.from(text.matchAll(/id="evidence-(\d+)"|name="evidence-(\d+)"/g), (match) => (match[1] ?? match[2])!),
	);

	// Prose only: headings, tables and code blocks are not claims.
	const prose = body
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^\|.*\|$/gm, " ")
		.replace(/^#{1,6}.*$/gm, " ");
	const sentences = prose
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.split(/\s+/).length >= 4);
	const cited = sentences.filter((sentence) => /\]\(#evidence-\d+\)|\[\d+\]/.test(sentence));

	return {
		file,
		links: links.size,
		anchors: anchors.size,
		dangling: [...links].filter((id) => !anchors.has(id)),
		unused: [...anchors].filter((id) => !links.has(id)),
		bodySentences: sentences.length,
		citedSentences: cited.length,
		uncitedSentences: sentences.length - cited.length,
		uncitedShare: sentences.length ? (sentences.length - cited.length) / sentences.length : 0,
		unresolvedMarkers: (body.match(/\[(?:P|I)\d+\]/g) ?? []).length,
	};
}

const files = process.argv.slice(2);
if (files.length) {
	for (const file of files) {
		const audit = auditReport(file, readFileSync(file, "utf8"));
		console.log(JSON.stringify(audit));
	}
}
