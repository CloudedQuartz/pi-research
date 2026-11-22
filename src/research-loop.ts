import { normalizeUrl, shouldSkipCandidateUrl } from "./research-acquisition.js";
import { EvidenceLibrary, type Passage } from "./research-library.js";

interface Need {
	id: number;
	question: string;
	queries: string[];
	gap?: string;
	answered: boolean;
}

interface Hit { url: string; title?: string; snippet?: string }
export interface SearchGroup { query: string; results?: Hit[]; error?: string }
export type EvidencePacket = ReturnType<ResearchLoop["evidence"]>;

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const queryKey = (query: string) => query.toLowerCase().replace(/\s+/g, " ").trim();
const strings = (value: unknown): string[] => Array.isArray(value)
	? value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
	: [];

export function modelObject(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n|\n```$/gi, ""));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
	return value as Record<string, unknown>;
}

export class ResearchLoop {
	readonly library = new EvidenceLibrary();
	readonly failures = new Set<string>();
	readonly searched = new Set<string>();
	readonly attempted = new Set<string>();
	needs: Need[] = [];
	stopReason = "";
	private checkingStop = false;

	plan(reply: string): void {
		const { needs } = modelObject(reply);
		if (!Array.isArray(needs)) throw new Error("The plan did not contain research needs.");
		for (const row of needs) {
			const queries = strings(row?.queries);
			if (typeof row?.question !== "string" || !row.question.trim() || !queries.length) {
				throw new Error("Each research need requires a question and search queries.");
			}
			this.needs.push({ id: this.needs.length + 1, question: row.question.trim(), queries, answered: false });
		}
		if (!this.needs.length) throw new Error("The plan did not contain a usable research need.");
	}

	pendingQueries(): string[] {
		const pending = new Map<string, string>();
		for (const need of this.needs) {
			if (need.answered) continue;
			for (const query of need.queries) {
				const key = queryKey(query);
				if (!this.searched.has(key)) pending.set(key, query);
			}
		}
		return [...pending.values()];
	}

	markSearched(queries: string[]): void {
		for (const query of queries) this.searched.add(queryKey(query));
	}

	selectUrls(groups: SearchGroup[]): string[] {
		const urls: string[] = [];
		// Pick one unread hit per query so broad queries cannot take over a round.
		for (const group of groups) {
			if (group.error) this.failures.add(`Search “${group.query}”: ${group.error}`);
			const query = words(group.query);
			const ranked = (group.results ?? []).filter((hit) => typeof hit.url === "string" && /^https?:\/\//i.test(hit.url))
				.map((hit) => ({ url: hit.url, score: [...words(`${hit.title ?? ""} ${hit.snippet ?? ""}`)].filter((term) => query.has(term)).length }))
				.sort((left, right) => right.score - left.score);
			for (const hit of ranked) {
				const key = normalizeUrl(hit.url);
				if (!key || this.attempted.has(key) || shouldSkipCandidateUrl(hit.url).skip) continue;
				this.attempted.add(key);
				urls.push(hit.url);
				break;
			}
		}
		return urls;
	}

	evidence() {
		const selected = new Map<string, { id: string; passage: Passage }>();
		const needs = this.needs.map((need) => {
			const query = [need.question, ...need.queries.filter((query) => this.searched.has(queryKey(query)))].join(" ");
			const hits = this.library.retrieve(query, 12).map(({ passage }) => {
				let entry = selected.get(passage.id);
				if (!entry) {
					entry = { id: `P${selected.size + 1}`, passage };
					selected.set(passage.id, entry);
				}
				return entry.id;
			});
			return { id: need.id, question: need.question, answered: need.answered, gap: need.gap, passages: hits };
		});
		const passages = [...selected.values()].map(({ id, passage }) => {
			const source = this.library.sources.get(passage.sourceId)!;
			return { id, sourceId: source.id, url: source.url, title: source.title, start: passage.start, end: passage.end, text: passage.text };
		});
		return { needs, passages };
	}

	assess(reply: string, packet: EvidencePacket, gainedEvidence: boolean): boolean {
		const { needs, continueSearching, reason } = modelObject(reply);
		if (!Array.isArray(needs) || typeof continueSearching !== "boolean") throw new Error("The assessment did not contain coverage and a search decision.");
		const judgments = new Map(needs.map((entry) => [entry?.id, entry]));
		if (this.needs.some((need) => typeof judgments.get(need.id)?.answered !== "boolean")) {
			throw new Error("The assessment did not judge each research need.");
		}
		for (const need of this.needs) {
			const row = judgments.get(need.id);
			const available = packet.needs.find((entry) => entry.id === need.id)?.passages ?? [];
			const cited = strings(row?.passages).filter((id) => available.includes(id));
			need.answered = row?.answered === true && cited.length > 0;
			need.gap = typeof row?.gap === "string" ? row.gap.trim() : undefined;
			if (!need.answered) need.queries.push(...strings(row?.queries));
		}
		if (this.needs.every((need) => need.answered)) this.stopReason = "The assessment found evidence for every research need.";
		else if (!this.pendingQueries().length) this.stopReason = "No new search queries were proposed for the remaining gaps.";
		else if (!continueSearching && (!gainedEvidence || this.checkingStop)) {
			this.stopReason = typeof reason === "string" && reason.trim() ? reason.trim() : "Another search was unlikely to change the conclusions.";
		}
		this.checkingStop = !continueSearching;
		return !this.stopReason;
	}
}
