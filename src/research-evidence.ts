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
			: (text ?? "").trim().split("\n").map((line) => `> ${line}`).join("\n");
		return `<a id="evidence-${number}"></a>\n\n### ${number}. ${source.title || source.url}\n\n${source.url} · retrieved ${source.retrievedAt.slice(0, 10)} · text offsets ${start}–${end}\n\n${record}`;
	});
	return `${body}\n\n## Evidence\n\n${evidence.join("\n\n")}`;
}
