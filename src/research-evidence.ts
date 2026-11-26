import type { Source } from "./research-library.js";
import type { SourceInspection } from "./research-loop.js";

interface Passage {
	id: string;
	source: Source;
	start: number;
	end: number;
	text: string;
}

type Evidence = Passage | (SourceInspection & { source: Source });

/** A citation quotes its source, it does not reprint it. */
const MAX_QUOTE_CHARS = 700;

function quoteBlock(text: string): string {
	const trimmed = text.trim();
	const clipped = trimmed.length <= MAX_QUOTE_CHARS
		? trimmed
		: `${trimmed.slice(0, MAX_QUOTE_CHARS).replace(/\s+\S*$/, "")}\u2026`;
	return clipped.split("\n").map((line) => `> ${line}`).join("\n");
}

export function renderReport(draft: string, passages: Passage[], inspections: (SourceInspection & { source: Source })[]): string {
	const byId = new Map<string, Evidence>([...passages, ...inspections].map((entry) => [entry.id, entry]));
	const citations = new Map<Evidence, number>();
	const body = draft.replace(/\[([PI]\d+)\]/g, (_match, id: string) => {
		const passage = byId.get(id);
		if (!passage) return "[unresolved citation]";
		const number = citations.get(passage) ?? citations.size + 1;
		citations.set(passage, number);
		return `[${number}](#evidence-${number})`;
	});
	if (!citations.size) return body;
	const evidence = [...citations].map(([entry, number]) => {
		const { source, start, end, text } = entry;
		const record = "matches" in entry && entry.matches
			? `Literal matches in the stored extraction: ${entry.matches.map(({ term, count }) => `${JSON.stringify(term)} (${count})`).join(", ")}.`
			: quoteBlock(text ?? "");
		const credibility = source.credibility ? ` · ${source.credibility.detail}` : "";
		return `<a id="evidence-${number}"></a>\n\n### ${number}. ${source.title || source.url}\n\n${source.url} · retrieved ${source.retrievedAt.slice(0, 10)} · text offsets ${start}–${end}${credibility}\n\n${record}`;
	});
	return `${body}\n\n## Evidence\n\n${evidence.join("\n\n")}`;
}

/** One cited record as it appears in a rendered report's Evidence section. */
export interface EvidenceRecord {
	title: string;
	url: string;
	/** Retrieval date, offsets and credibility, already formatted. */
	meta: string;
	quote: string;
}

/**
 * Read back the records `renderReport` wrote, so a finished run can be handed to a later conversation.
 * The ids in the report are positional links; the renumbering is why the ids in an injected bundle are
 * the report's numbers and not the internal P/I ids.
 */
export function parseEvidenceRecords(report: string): EvidenceRecord[] {
	const start = report.search(/^##\s+Evidence\b.*$/m);
	if (start < 0) return [];
	const section = report.slice(start);
	const records: EvidenceRecord[] = [];
	for (const block of section.split(/<a id="evidence-\d+"><\/a>/).slice(1)) {
		const lines = block.split("\n");
		const heading = lines.find((line) => /^###\s+\d+\./.test(line.trim()));
		const metaLine = lines.find((line) => line.includes("retrieved ") && /https?:\/\//.test(line));
		const quote = lines
			.filter((line) => line.trimStart().startsWith(">"))
			.map((line) => line.replace(/^\s*>\s?/, "").trim())
			.join(" ")
			.trim();
		if (!heading) continue;
		records.push({
			title: heading.replace(/^###\s+\d+\.\s*/, "").trim() || "untitled source",
			url: (metaLine?.match(/https?:\/\/\S+/) ?? [""])[0]!.replace(/[.,;]$/, ""),
			meta: (metaLine ?? "").trim(),
			quote,
		});
	}
	return records;
}

const INJECT_QUOTE_CHARS = 400;

/**
 * A compact evidence bundle for injecting into a chat session. Bounded twice over: per quote and in
 * total, because an injected message is context every later turn pays for.
 */
export function injectBundle(
	journal: { question?: string; status?: string; stopReason?: string; rounds?: unknown[] },
	report: string | undefined,
	limit = 40,
	maxChars = 60_000,
): string {
	const records = report ? parseEvidenceRecords(report) : [];
	const kept = records.slice(0, Math.max(1, limit));
	const header = [
		"Research evidence from the last finished run. Cite these records by their bracketed number;",
		"do not invent numbers, and say when the evidence does not cover something.",
		"",
		`Question: ${journal.question ?? "(unknown)"}`,
		`Status: ${journal.status ?? "unknown"}${journal.rounds?.length ? ` \u00b7 ${journal.rounds.length} round${journal.rounds.length === 1 ? "" : "s"}` : ""}`,
		...(journal.stopReason ? [`Why it stopped: ${journal.stopReason}`] : []),
		`Cited records: ${kept.length}${records.length > kept.length ? ` of ${records.length} (limit ${limit})` : ""}`,
		"",
	];
	if (!kept.length) {
		return [...header, "The report carried no evidence records, so nothing can be quoted from this run."].join("\n");
	}
	const body: string[] = [];
	let used = header.join("\n").length;
	for (const [index, record] of kept.entries()) {
		const quote = record.quote.length > INJECT_QUOTE_CHARS
			? `${record.quote.slice(0, INJECT_QUOTE_CHARS).replace(/\s+\S*$/, "")}\u2026`
			: record.quote;
		const entry = [`[${index + 1}] ${record.title}`, `    ${record.meta || record.url}`, `    > ${quote}`].join("\n");
		if (used + entry.length > maxChars) {
			body.push(`(${kept.length - index} further records omitted to keep the injected evidence bounded.)`);
			break;
		}
		used += entry.length;
		body.push(entry);
	}
	return [...header, ...body].join("\n").trim();
}
