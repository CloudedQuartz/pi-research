/**
 * Stage 1 of /research: the evidence library. Deterministic, no model calls.
 *
 * - Sources are deduplicated by arXiv ID (arxiv.org, ar5iv, alphaxiv renderings), then by
 *   canonical URL, then by 5-word shingle containment >= 0.8 (near-duplicate test).
 * - Text is split into sentence-packed passages; boilerplate-looking passages are dropped.
 * - Retrieval is per subquestion: BM25 over passages, then MMR so a second passage must
 *   add content the first one lacks, with at most two passages per source.
 * - The coverage table says which subquestions have enough independent evidence.
 */

export interface SourceInput {
	url: string;
	canonicalUrl?: string;
	title?: string;
	retrievedAt: string;
	text: string;
}

import { credibilityOf, type SourceCredibility } from "./source-credibility.js";

export interface Source extends SourceInput {
	id: string;
	kind: "summary" | "unclassified";
	/** Other URLs that resolved to this source (copies, mirrors, alternate renderings). */
	aliases: string[];
	/** Explainable source prior: kind of host plus any independent credibility rating. */
	credibility?: SourceCredibility;
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

const MIN_PASSAGE_WORDS = 8;
const PASSAGE_TARGET_CHARS = 900;
const SHINGLE_SIZE = 5;
const NEAR_DUPLICATE = 0.8;
const PER_SOURCE_LIMIT = 2;
const PASSAGES_PER_SUBQUESTION = 6;
const MIN_SOURCES_PER_SUBQUESTION = 2;
const MIN_PASSAGES_PER_SUBQUESTION = 2;
const MMR_LAMBDA = 0.7;
const STOPWORDS = new Set("a an and are as at be by for from has have in is it its of on or that the this to was were with which who what how why when where do does did can could should would not no".split(" "));

import { stem } from "./porter.js";

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const contentTerms = (text: string): string[] => words(text).filter((term) => term.length > 1 && !STOPWORDS.has(term)).map((term) => stem(term));

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

/**
 * Drop only text that cannot carry a claim: a stub with a handful of words, or a chunk with no
 * letters at all. Word-count ratios were a bad filter here — they removed one-sentence findings and
 * measurement tables while letting alphabetic navigation lists through — so length alone decides,
 * and ranking is left to BM25/MMR.
 */
function looksLikeBoilerplate(text: string): boolean {
	const tokens = text.split(/\s+/).filter(Boolean);
	if (tokens.length < MIN_PASSAGE_WORDS) return true;
	// Needs at least a few real words, not a bare number or symbol run.
	return !/\p{L}[\p{L}'’-]{2,}/u.test(text);
}

function packSentences(text: string): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	const sentence = /[^.!?\n]+(?:[.!?]+|\n+|$)/g;
	let start = -1;
	let end = 0;
	for (const match of text.matchAll(sentence)) {
		const at = match.index ?? 0;
		const stop = at + match[0].length;
		if (!match[0].trim()) continue;
		if (start < 0) start = at;
		if (stop - start > PASSAGE_TARGET_CHARS && end > start) {
			spans.push({ start, end });
			start = at;
		}
		end = stop;
	}
	if (start >= 0 && end > start) spans.push({ start, end });
	return spans;
}

export class EvidenceLibrary {
	readonly sources = new Map<string, Source>();
	readonly passages: Passage[] = [];
	private shingleCache = new Map<string, Set<string>>();

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
				this.sources.set(key, { ...input, id: key, kind, aliases, credibility: credibilityOf(input.url) });
				this.shingleCache.set(key, shingles(input.text));
				const previous = this.passages.filter((passage) => passage.sourceId === key);
				for (let i = this.passages.length - 1; i >= 0; i--) if (this.passages[i]!.sourceId === key) this.passages.splice(i, 1);
				if (!this.addPassages(key, input.text)) {
					// The fuller copy produced nothing usable: put the previous passages back.
					this.sources.set(key, { ...existing });
					this.passages.push(...previous);
					return { status: "alias", sourceId: key };
				}
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
		this.sources.set(key, { ...input, id: key, kind, aliases: [], credibility: credibilityOf(input.url) });
		this.shingleCache.set(key, fingerprint);
		if (!this.addPassages(key, input.text)) {
			// Nothing citable came out of the text: keep the corpus honest rather than counting a
			// source the writer can never cite.
			this.sources.delete(key);
			this.shingleCache.delete(key);
			return { status: "empty" };
		}
		return { status: "added", sourceId: key };
	}

	/** Returns how many citable passages the text produced; zero means the source is unusable. */
	private addPassages(sourceId: string, text: string): number {
		let added = 0;
		for (const span of packSentences(text)) {
			const passage = text.slice(span.start, span.end);
			if (!passage.trim() || looksLikeBoilerplate(passage)) continue;
			this.passages.push({ id: `${sourceId}#${span.start}`, sourceId, start: span.start, end: span.end, text: passage });
			added += 1;
		}
		return added;
	}

	/** Passages for one subquestion, diverse by MMR and capped per source. */
	retrieve(subquestion: string, limit = PASSAGES_PER_SUBQUESTION): { passage: Passage; score: number }[] {
		const query = [...new Set(contentTerms(subquestion))];
		if (!query.length || !this.passages.length) return [];
		const docs = this.passages.map((passage) => ({ passage, terms: contentTerms(passage.text) }));
		const avgLength = docs.reduce((total, doc) => total + doc.terms.length, 0) / docs.length || 1;
		const df = new Map<string, number>();
		for (const doc of docs) for (const term of new Set(doc.terms)) df.set(term, (df.get(term) ?? 0) + 1);
		const scored = docs.map((doc) => {
			const tf = new Map<string, number>();
			for (const term of doc.terms) tf.set(term, (tf.get(term) ?? 0) + 1);
			let score = 0;
			for (const term of query) {
				const f = tf.get(term) ?? 0;
				if (!f) continue;
				const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
				score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (doc.terms.length / avgLength))));
			}
			const factor = this.sources.get(doc.passage.sourceId)?.credibility?.factor ?? 1;
			return { passage: doc.passage, terms: doc.terms, score: score * factor };
		}).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 200);
		if (!scored.length) return [];

		const maxScore = scored[0]!.score;
		const vectors = scored.map((entry) => termVector(entry.terms));
		const chosen: number[] = [];
		const perSource = new Map<string, number>();
		while (chosen.length < limit) {
			let best = -1;
			let bestValue = -Infinity;
			for (let i = 0; i < scored.length; i++) {
				if (chosen.includes(i)) continue;
				const sourceId = scored[i]!.passage.sourceId;
				if ((perSource.get(sourceId) ?? 0) >= PER_SOURCE_LIMIT) continue;
				const relevance = scored[i]!.score / maxScore;
				let similarity = 0;
				for (const j of chosen) similarity = Math.max(similarity, cosine(vectors[i]!, vectors[j]!));
				const value = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * similarity;
				if (value > bestValue) { bestValue = value; best = i; }
			}
			if (best < 0) break;
			chosen.push(best);
			const sourceId = scored[best]!.passage.sourceId;
			perSource.set(sourceId, (perSource.get(sourceId) ?? 0) + 1);
		}
		return chosen.map((i) => ({ passage: scored[i]!.passage, score: scored[i]!.score }));
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

function termVector(terms: string[]): Map<string, number> {
	const vector = new Map<string, number>();
	for (const term of terms) vector.set(term, (vector.get(term) ?? 0) + 1);
	let square = 0;
	for (const value of vector.values()) square += value * value;
	const norm = Math.sqrt(square) || 1;
	for (const [term, value] of vector) vector.set(term, value / norm);
	return vector;
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
	let sum = 0;
	const [small, large] = left.size <= right.size ? [left, right] : [right, left];
	for (const [term, value] of small) sum += value * (large.get(term) ?? 0);
	return sum;
}
