import { normalizeUrl, shouldSkipCandidateUrl } from "./research-acquisition.js";
import { EvidenceLibrary, type Passage, type Source } from "./research-library.js";

interface Need {
	id: number;
	question: string;
	queries: string[];
	essential: boolean;
	gap?: string;
	answered: boolean;
}

interface Hit { url: string; title?: string; snippet?: string }

export interface SourceInspection {
	id: string;
	sourceId: string;
	sourceVersion: string;
	start: number;
	end: number;
	matches?: { term: string; count: number; firstOffsets: number[] }[];
	text?: string;
}
export interface SearchGroup { query: string; results?: Hit[]; error?: string }
export type EvidencePacket = ReturnType<ResearchLoop["evidence"]>;

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const queryKey = (query: string) => query.toLowerCase().replace(/\s+/g, " ").trim();
const strings = (value: unknown): string[] => Array.isArray(value)
	? value.filter((item): item is string => typeof item === "string" && !!item.trim()).map((item) => item.trim())
	: [];

/**
 * Parse the model's JSON object, tolerating prose or a stray brace around it.
 *
 * A reply of `{...}` followed by one extra `}` made JSON.parse throw "Extra data", the error escaped
 * into the stage handler, and the run ended with no report while its corpus sat unused - three runs
 * this session died that way. Taking the first balanced object keeps a cosmetic mistake from costing
 * the whole run.
 */
export function modelObject(text: string): Record<string, unknown> {
	const cleaned = text.trim().replace(/^```(?:json)?\s*\n|\n```$/gi, "");
	const accept = (candidate: string): Record<string, unknown> => {
		const value: unknown = JSON.parse(candidate);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
		return value as Record<string, unknown>;
	};
	try {
		return accept(cleaned);
	} catch {
		const start = cleaned.indexOf("{");
		if (start < 0) throw new Error("The reply contained no JSON object.");
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let index = start; index < cleaned.length; index++) {
			const character = cleaned[index]!;
			if (inString) {
				if (escaped) escaped = false;
				else if (character === "\\") escaped = true;
				else if (character === '"') inString = false;
				continue;
			}
			if (character === '"') inString = true;
			else if (character === "{") depth++;
			else if (character === "}" && --depth === 0) return accept(cleaned.slice(start, index + 1));
		}
		throw new Error("The reply's JSON object was not closed.");
	}
}

/** Upper bound on search rounds before the report is written anyway. */
export const MAX_ROUNDS = 10;

export class ResearchLoop {
	readonly library = new EvidenceLibrary();
	readonly failures = new Set<string>();
	readonly searched = new Set<string>();
	/** Partial assessments are recorded here instead of ending the run they belong to. */
	readonly assessmentNotes: string[] = [];
	readonly attempted = new Set<string>();
	readonly inspections: SourceInspection[] = [];
	readonly inspectedSources = new Map<string, Source>();
	readonly searches: { query: string; hits: number; error?: string }[] = [];
	needs: Need[] = [];
	stopReason = "";
	private checkingStop = false;
	/** Consecutive rounds that produced no new source or passage. */
	private stalledRounds = 0;

	plan(reply: string): void {
		const { needs } = modelObject(reply);
		if (!Array.isArray(needs)) throw new Error("The plan did not contain research needs.");
		for (const row of needs) {
			const queries = strings(row?.queries);
			if (typeof row?.question !== "string" || !row.question.trim() || !queries.length) {
				throw new Error("Each research need requires a question and search queries.");
			}
			if (typeof row.essential !== "boolean") throw new Error("Each need must be marked essential or optional.");
			this.needs.push({ id: this.needs.length + 1, question: row.question.trim(), queries, essential: row.essential, answered: false });
		}
		if (!this.needs.some((need) => need.essential)) throw new Error("The plan must contain an essential research need.");
	}

	pendingQueries(): string[] {
		const pending = new Map<string, string>();
		for (const need of this.needs) {
			if (need.answered || !need.essential) continue;
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
		// Two unread hits per query: one per query let a nine-query wave add at most nine sources, which
		// is how a task ended a round with eight and scored worst on comprehensiveness. Two keeps a
		// broad query from taking over the round while giving every need a second candidate.
		const PER_QUERY = 2;
		// Two per query over thirty-plus queries fetched 146 pages for 115 passages on task 77 and 144 for
		// 107 on task 51, both of which then ran past twenty minutes. Breadth still comes from rounds.
		const PER_ROUND = 20;
		for (const group of groups) {
			if (urls.length >= PER_ROUND) break;
			this.searches.push({ query: group.query, hits: group.results?.length ?? 0, error: group.error });
			if (group.error) this.failures.add(`Search “${group.query}”: ${group.error}`);
			const query = words(group.query);
			const ranked = (group.results ?? []).filter((hit) => typeof hit.url === "string" && /^https?:\/\//i.test(hit.url))
				.map((hit) => ({ url: hit.url, score: [...words(`${hit.title ?? ""} ${hit.snippet ?? ""}`)].filter((term) => query.has(term)).length }))
				.sort((left, right) => right.score - left.score);
			let taken = 0;
			for (const hit of ranked) {
				if (taken >= PER_QUERY) break;
				const key = normalizeUrl(hit.url);
				if (!key || this.attempted.has(key) || shouldSkipCandidateUrl(hit.url).skip) continue;
				this.attempted.add(key);
				urls.push(hit.url);
				taken++;
			}
		}
		return urls;
	}

	inspect(sourceId: string, terms?: string[], start = 0, end?: number): SourceInspection {
		const source = this.library.sources.get(sourceId);
		if (!source) throw new Error(`Unknown stored source: ${sourceId}`);
		const literalTerms = terms?.filter((term) => term.trim());
		const stop = end ?? (literalTerms?.length ? source.text.length : Math.min(start + 6000, source.text.length));
		if (start < 0 || stop <= start || stop > source.text.length) throw new Error(`Invalid range for this ${source.text.length}-character source.`);
		if (!literalTerms?.length && stop - start > 6000) throw new Error("Read source text in chunks of at most 6,000 characters.");
		const text = source.text.slice(start, stop);
		let sourceVersion = [...this.inspectedSources].find(([, snapshot]) => snapshot === source)?.[0];
		if (!sourceVersion) {
			sourceVersion = `V${this.inspectedSources.size + 1}`;
			this.inspectedSources.set(sourceVersion, source);
		}
		const inspection: SourceInspection = { id: `I${this.inspections.length + 1}`, sourceId, sourceVersion, start, end: stop };
		if (literalTerms?.length) {
			inspection.matches = literalTerms.map((term) => {
				const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
				let count = 0;
				const firstOffsets: number[] = [];
				for (const match of text.matchAll(pattern)) {
					count++;
					if (firstOffsets.length < 12) firstOffsets.push(start + match.index);
				}
				return { term, count, firstOffsets };
			});
		} else {
			inspection.text = text;
		}
		this.inspections.push(inspection);
		return inspection;
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
			return { id: need.id, question: need.question, essential: need.essential, answered: need.answered, gap: need.gap, passages: hits };
		});
		const passages = [...selected.values()].map(({ id, passage }) => {
			const source = this.library.sources.get(passage.sourceId)!;
			return { id, sourceId: source.id, url: source.url, title: source.title, kind: source.kind, start: passage.start, end: passage.end, text: passage.text };
		});
		const sources = [...this.library.sources.values()].map(({ id, url, title, text, kind }) => ({ id, url, title, kind, length: text.length }));
		return { needs, passages, sources };
	}

	assess(reply: string, packet: EvidencePacket, gainedEvidence: boolean, round = 0): boolean {
		const { needs, continueSearching, reason } = modelObject(reply);
		if (!Array.isArray(needs) || typeof continueSearching !== "boolean") throw new Error("The assessment did not contain coverage and a search decision.");
		const judgments = new Map(needs.map((entry) => [entry?.id, entry]));
		// A reply that skips a need is a weaker answer, not a reason to throw away four rounds of
		// evidence. Missing needs stay unanswered and the omission is recorded for the journal.
		const unjudged = this.needs.filter((need) => typeof judgments.get(need.id)?.answered !== "boolean");
		if (unjudged.length) {
			this.assessmentNotes.push(
				`The assessment judged ${this.needs.length - unjudged.length} of ${this.needs.length} needs; ${unjudged
					.map((need) => need.id)
					.join(", ")} left unanswered.`,
			);
		}
		for (const need of this.needs) {
			const row = judgments.get(need.id);
			const available = packet.needs.find((entry) => entry.id === need.id)?.passages ?? [];
			const cited = strings(row?.passages).filter((id) => available.includes(id) || this.inspections.some((inspection) => inspection.id === id));
			need.answered = row?.answered === true && cited.length > 0;
			need.gap = typeof row?.gap === "string" ? row.gap.trim() : undefined;
			if (!need.answered && need.essential) need.queries.push(...strings(row?.queries));
		}
		if (gainedEvidence) this.stalledRounds = 0;
		else this.stalledRounds += 1;
		// A run that keeps finding queries will keep going, and a long enough run ends with the provider
		// silent at the end - task 51 spent eleven rounds and 57 sources, then produced no report at all.
		// Bounding the rounds trades a little depth for a report that exists.
		if (round >= MAX_ROUNDS) this.stopReason = `Reached the ${MAX_ROUNDS}-round limit; writing from the corpus collected.`;
		else if (this.needs.every((need) => !need.essential || need.answered)) this.stopReason = "The assessment found evidence for every essential research need.";
		else if (this.stalledRounds >= 2) this.stopReason = "Two rounds added no new sources or passages; further searches were not producing evidence.";
		else if (!this.pendingQueries().length) this.stopReason = "No new search queries were proposed for the remaining gaps.";
		else if (!continueSearching && (!gainedEvidence || this.checkingStop)) {
			this.stopReason = typeof reason === "string" && reason.trim() ? reason.trim() : "Another search was unlikely to change the conclusions.";
		}
		this.checkingStop = !continueSearching;
		return !this.stopReason;
	}
}

/**
 * How long to wait before re-asking after a provider error, or undefined if the error
 * is not worth retrying. A throttled run should back off instead of ending without a
 * report: eight concurrent runs were enough to exhaust a provider's rate limit.
 */
export function providerRetryDelay(reason: string | undefined, attempt: number): number | undefined {
	if (!reason) return undefined;
	if (!/429|rate[_ ]?limit|overloaded|too many requests|timed? ?out|\b50[0234]\b/i.test(reason)) return undefined;
	return Math.min(120_000, 20_000 * 2 ** Math.max(0, attempt - 1));
}

/**
 * The reply for a stage, read from the session transcript. `agent_settled` can arrive before the
 * message_end hook has recorded the response, and without this a finished report already sitting in
 * the session is thrown away and the run ends claiming it produced nothing. Only turns that started
 * after the stage prompt are eligible.
 */
export function pickAssistantReply(
	branch: readonly unknown[],
	since?: number,
): { text: string; stopReason?: string } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as {
			type?: string;
			timestamp?: string;
			message?: { role?: string; stopReason?: string; timestamp?: string; content?: unknown };
		};
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		// Sessions stamp the entry, not the message; reading only the message made this guard dead code.
		const stamp = entry.timestamp ?? entry.message.timestamp;
		if (since && stamp && Date.parse(stamp) < since) return undefined;
		const parts = Array.isArray(entry.message.content) ? entry.message.content : [];
		const text = parts
			.filter((part): part is { type: "text"; text: string } => Boolean(part) && (part as { type?: string }).type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return { text, stopReason: entry.message.stopReason };
	}
	return undefined;
}

/**
 * How long a stage may go without replying before the run is ended. Off unless asked for: a
 * research turn that is still collecting evidence is not stuck, and ending it discards the work.
 */
export function stageTimeoutMs(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
