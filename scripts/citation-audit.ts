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
	/** Uncited sentences that state a finding rather than reason over one. These are the real gaps. */
	uncitedClaims: number;
	uncitedReasoning: number;
}

/**
 * An uncited sentence is only a defect if it asserts something the corpus is supposed to carry: a
 * figure, a finding, or an attribution. Reasoning over a figure cited in the previous sentence
 * ("that specification implies roughly +21%") does not need its own citation, and counting it as a
 * gap made every report look a third unbounded.
 */
const CLAIM_SIGNALS = /\b\d|according to|reported|found that|shows? that|studies|study|survey|data|percent|%|et al/i;

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
	const uncited = sentences.filter((sentence) => !cited.includes(sentence));

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
		uncitedClaims: uncited.filter((sentence) => CLAIM_SIGNALS.test(sentence)).length,
		uncitedReasoning: uncited.filter((sentence) => !CLAIM_SIGNALS.test(sentence)).length,
	};
}

const files = process.argv.slice(2);
if (files.length) {
	for (const file of files) {
		const audit = auditReport(file, readFileSync(file, "utf8"));
		console.log(JSON.stringify(audit));
	}
}
