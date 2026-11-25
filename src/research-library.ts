/**
 * Stage 1 of /research: the evidence library. Deterministic, no model calls.
 *
 * - Sources are deduplicated by arXiv ID (arxiv.org, ar5iv, alphaxiv renderings), then by
 *   canonical URL, then by 5-word shingle containment >= 0.8 (near-duplicate test).
 * - Text is split by the IR core's paragraph-aware `segment()` (180-300 tokens, exact
 *   offsets); boilerplate-looking passages are dropped.
 * - Retrieval is per subquestion through the IR core: positional BM25 on the Porter-stemmed
 *   stream (`PassageIndex.rankStemmed`), then MMR so a second passage must add content the
 *   first one lacks, with at most two passages per source.
 * - The coverage table says which subquestions have enough independent evidence.
 */

import { PassageIndex, mmr, segment } from "./core-ir.js";
import type { Snapshot } from "./types.js";

export interface SourceInput {
	url: string;
	canonicalUrl?: string;
	title?: string;
	retrievedAt: string;
	text: string;
}

export interface Source extends SourceInput {
	id: string;
	kind: "summary" | "unclassified";
	/** Other URLs that resolved to this source (copies, mirrors, alternate renderings). */
	aliases: string[];
}

export interface Passage {
	id: string;
	sourceId: string;
	start: number;
	end: number;
	text: string;
}

export interface Coverage {
	subquestion: string;
	passages: string[];
	sources: string[];
	enough: boolean;
}

const MIN_PASSAGE_WORDS = 25;
const RANK_CANDIDATES = 200;
const SHINGLE_SIZE = 5;
const NEAR_DUPLICATE = 0.8;
const PER_SOURCE_LIMIT = 2;
const PASSAGES_PER_SUBQUESTION = 6;
const MIN_SOURCES_PER_SUBQUESTION = 2;
const MIN_PASSAGES_PER_SUBQUESTION = 2;
const MMR_LAMBDA = 0.7;
const STOPWORDS = new Set("a an and are as at be by for from has have in is it its of on or that the this to was were with which who what how why when where do does did can could should would not no".split(" "));

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const contentTerms = (text: string): string[] => words(text).filter((term) => term.length > 1 && !STOPWORDS.has(term));

function shingles(text: string): Set<string> {
	const tokens = words(text);
	const set = new Set<string>();
	for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i++) set.add(tokens.slice(i, i + SHINGLE_SIZE).join(" "));
	return set;
}

/** Share of the smaller text's shingles found in the larger one: catches abstract-versus-full-text copies. */
function containment(left: Set<string>, right: Set<string>): number {
	if (!left.size || !right.size) return 0;
	const [small, large] = left.size <= right.size ? [left, right] : [right, left];
	let shared = 0;
	for (const item of small) if (large.has(item)) shared++;
	return shared / small.size;
}

/** arXiv identifier across arxiv.org, ar5iv and alphaxiv renderings, without version suffix. */
export function arxivId(rawUrl: string): string | undefined {
	return rawUrl.match(/(?:arxiv\.org\/(?:abs|html|pdf)|ar5iv(?:\.labs\.arxiv)?\.org\/(?:abs|html)|alphaxiv\.org\/(?:abs|overview))\/(\d{4}\.\d{4,5})/i)?.[1];
}

function sourceKind(text: string): Source["kind"] {
	return /\bAI[- ]generated\b.{0,20}\bverify against the paper\b|\bAI[- ](?:generated|narrated) summary\b/i.test(text.slice(0, 3000))
		? "summary"
		: "unclassified";
}

/** Canonical identity for URLs: lowercase host, no fragment, no tracking params, no trailing slash. */
export function sourceKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		url.hash = "";
		for (const param of [...url.searchParams.keys()]) {
			if (/^(utm_|fbclid|gclid|ref$|amp$)/i.test(param)) url.searchParams.delete(param);
		}
		url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
		return `${url.hostname}${url.pathname.replace(/\/+$/, "")}${url.search}`;
	} catch {
		return rawUrl.trim().toLowerCase();
	}
}

/** Passages that are mostly navigation, metadata or very short: not evidence. */
function looksLikeBoilerplate(text: string): boolean {
	const tokens = text.split(/\s+/).filter(Boolean);
	if (words(text).length < MIN_PASSAGE_WORDS) return true;
	const alphabetic = tokens.filter((token) => /^[\p{L}][\p{L}'’-]{2,}[.,;:!?)]?$/u.test(token)).length;
	return alphabetic / tokens.length < 0.6;
}

export class EvidenceLibrary {
	readonly sources = new Map<string, Source>();
	readonly passages: Passage[] = [];
	private shingleCache = new Map<string, Set<string>>();
	/** Built lazily on the next retrieval after the passage set changes. */
	private index?: PassageIndex;

	/** Returns the stored source id; copies are recorded as aliases rather than stored twice. */
	addSource(input: SourceInput): { status: "added" | "alias" | "near-duplicate" | "empty"; sourceId?: string } {
		if (!input.text.trim()) return { status: "empty" };
		const id = arxivId(input.url) ?? arxivId(input.canonicalUrl ?? "");
		const key = id ? `arxiv:${id}` : sourceKey(input.canonicalUrl || input.url);
		const kind = sourceKind(input.text);
		const existing = this.sources.get(key);
		if (existing) {
			if (!existing.aliases.includes(input.url) && input.url !== existing.url) existing.aliases.push(input.url);
			// A fuller copy of the same document replaces an abstract-level one; its passages are re-split.
			// Same arXiv ID is the same document even when front matter garbles the shingles.
			const sameDocument = key.startsWith("arxiv:") || containment(shingles(existing.text), shingles(input.text)) >= NEAR_DUPLICATE;
			const replacesSummary = existing.kind === "summary" && kind !== "summary";
			const isFullerCopy = kind === existing.kind && input.text.length > existing.text.length * 1.2;
			if (sameDocument && (replacesSummary || isFullerCopy)) {
				const aliases = [...new Set([existing.url, ...existing.aliases])].filter((url) => url !== input.url);
				this.sources.set(key, { ...input, id: key, kind, aliases });
				this.shingleCache.set(key, shingles(input.text));
				for (let i = this.passages.length - 1; i >= 0; i--) if (this.passages[i]!.sourceId === key) this.passages.splice(i, 1);
				this.addPassages(key, input.text);
				return { status: "alias", sourceId: key };
			}
			return { status: "alias", sourceId: key };
		}
		const fingerprint = shingles(input.text);
		for (const [id, source] of this.sources) {
			if (!this.shingleCache.has(id)) this.shingleCache.set(id, shingles(source.text));
			if (kind === source.kind && containment(fingerprint, this.shingleCache.get(id)!) >= NEAR_DUPLICATE) {
				if (!source.aliases.includes(input.url)) source.aliases.push(input.url);
				return { status: "near-duplicate", sourceId: id };
			}
		}
		this.sources.set(key, { ...input, id: key, kind, aliases: [] });
		this.shingleCache.set(key, fingerprint);
		this.addPassages(key, input.text);
		return { status: "added", sourceId: key };
	}

	private addPassages(sourceId: string, text: string): void {
		this.index = undefined;
		// segment() reads only id, text and pages; the rest of Snapshot is acquisition metadata.
		for (const span of segment({ id: sourceId, text } as Snapshot)) {
			if (!span.text.trim() || looksLikeBoilerplate(span.text)) continue;
			this.passages.push({ id: `${sourceId}#${span.start}`, sourceId, start: span.start, end: span.end, text: span.text });
		}
	}

	/** Passages for one subquestion: stemmed BM25, MMR-diversified, capped per source. */
	retrieve(subquestion: string, limit = PASSAGES_PER_SUBQUESTION): { passage: Passage; score: number }[] {
		if (!contentTerms(subquestion).length || !this.passages.length) return [];
		const byId = new Map(this.passages.map((passage) => [passage.id, passage]));
		if (!this.index) {
			this.index = new PassageIndex();
			this.index.add(this.passages.map((p) => ({ id: p.id, snapshotId: p.sourceId, start: p.start, end: p.end, text: p.text, duplicateGroup: p.id })));
		}
		const ranked = this.index.rankStemmed(subquestion, RANK_CANDIDATES).filter((hit) => hit.score > 0);
		// Full MMR ordering, then the per-source cap: the cap must not let one source fill the shortlist.
		const chosen: { passage: Passage; score: number }[] = [];
		const perSource = new Map<string, number>();
		for (const hit of mmr(ranked, ranked.length, MMR_LAMBDA)) {
			const passage = byId.get(hit.passage.id);
			if (!passage || (perSource.get(passage.sourceId) ?? 0) >= PER_SOURCE_LIMIT) continue;
			perSource.set(passage.sourceId, (perSource.get(passage.sourceId) ?? 0) + 1);
			chosen.push({ passage, score: hit.score });
			if (chosen.length >= limit) break;
		}
		return chosen;
	}

	/** Coverage table: which subquestions have enough independent evidence to write from. */
	coverage(subquestions: string[]): { table: Coverage[]; gaps: string[] } {
		const table = subquestions.map((subquestion) => {
			const hits = this.retrieve(subquestion);
			const sources = [...new Set(hits.map((hit) => hit.passage.sourceId))];
			const enough = hits.length >= MIN_PASSAGES_PER_SUBQUESTION && sources.length >= MIN_SOURCES_PER_SUBQUESTION;
			return { subquestion, passages: hits.map((hit) => hit.passage.id), sources, enough };
		});
		return { table, gaps: table.filter((row) => !row.enough).map((row) => row.subquestion) };
	}
}
