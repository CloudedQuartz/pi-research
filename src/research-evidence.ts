import type { Source } from "./research-library.js";

interface Passage {
	id: string;
	source: Source;
	start: number;
	end: number;
	text: string;
}

export function renderReport(draft: string, passages: Passage[]): string {
	const byId = new Map(passages.map((passage) => [passage.id, passage]));
	const citations = new Map<Passage, number>();
	const body = draft.replace(/\[(P\d+)\]/g, (_match, id: string) => {
		const passage = byId.get(id);
		if (!passage) return "[unresolved citation]";
		const number = citations.get(passage) ?? citations.size + 1;
		citations.set(passage, number);
		return `[${number}](#evidence-${number})`;
	});
	if (!citations.size) return body;
	const evidence = [...citations].map(([{ source, start, end, text }, number]) => {
		const quote = text.trim().split("\n").map((line) => `> ${line}`).join("\n");
		return `<a id="evidence-${number}"></a>\n\n### ${number}. ${source.title || source.url}\n\n${source.url} · retrieved ${source.retrievedAt.slice(0, 10)} · text offsets ${start}–${end}\n\n${quote}`;
	});
	return `${body}\n\n## Evidence\n\n${evidence.join("\n\n")}`;
}
