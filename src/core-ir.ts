import type {
  Branch, Concept, Feedback, Passage, SearchHit, Snapshot, Span, TermScore, Token,
} from './types.js';

/**
 * Core retrieval. Surface tokens keep stopwords and UTF-16 offsets for phrase
 * and provenance work; BM25 scoring uses a separately normalized stream.
 *
 * Invariants:
 * - `segment` emits contiguous slices of snapshot.text (end - start === text.length),
 *   paragraph-packed toward 180-300 surface tokens with at most one small trailing
 *   paragraph carried into the next passage; a paragraph that alone exceeds the
 *   token or character cap is split at sentence boundaries (token boundaries when
 *   it has none) instead of being admitted whole, so every passage stays bounded;
 *   headings stay in the text and are mirrored into `section`, `page` comes from
 *   snapshot.pages.
 * - Indexing never mutates caller passages: `add` stores shallow copies and
 *   `get`/`all`/`rank` hand out fresh copies. Exact-body duplicates are indexed
 *   once (min-id canonical) and the rest become aliases sharing its duplicateGroup;
 *   near duplicates (5-shingle Jaccard >= 0.8) keep separate postings but share a
 *   duplicateGroup. Grouping is order-independent, so incremental intake and a
 *   full rebuild of the same corpus produce identical stats and rankings;
 *   `revision` counts distinct accepted snapshots (content-deterministic).
 * - `mmr` holds no cross-call state; TF-IDF vectors are derived per invocation
 *   from the hits it receives, never from mutable global index pointers.
 */

export const K1 = 1.2;
export const B = 0.75;
const PHRASE_EXACT_BONUS = 0.25;
const PHRASE_OCCURRENCE_BONUS = 0.05;
const PHRASE_PROXIMITY_BONUS = 0.10;
const SHINGLE = 5;
const NEAR_DUPLICATE_JACCARD = 0.8;
/** Packing cap for surface tokens; `SEGMENT_MIN` is the preferred floor for a split. */
const SEGMENT_MAX = 300;
const SEGMENT_MIN = 180;
/**
 * Hard bound on passage text in UTF-16 units. Ordinary prose at 300 tokens is
 * ~2.0-2.5k chars; the bound exists so a single long token (minified payload,
 * huge URL) cannot defeat the token cap and ship a whole page as one passage.
 */
const SEGMENT_MAX_CHARS = 4000;
const SEGMENT_OVERLAP_MAX = 60;
const PRF_POOL = 5;
const ANCHOR_OVERLAP_RATIO = 0.25;
const USEFUL_FEEDBACK_WEIGHT = 1.5;
const MAX_ADDITIONS = 3;
const ANCHOR_MASS = 0.75;
const EXPANSION_MASS = 0.25;
const NEGATIVE_PENALTY = 0.5;
const USED_VOCAB_DISCOUNT = 0.5;
const MAX_NGRAM = 4;

/** Standard English stopwords; apostrophe splits (don't -> don + t) are covered. */
export const STOPWORDS = new Set(`
i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself
it its itself they them their theirs themselves what which who whom this that these those am is are was were be been
being have has had having do does did doing a an the and but if or because as until while of at by for with about
against between into through during before after above below to from up down in out on off over under again further
then once here there when where why how all any both each few more most other some such no nor not only own same so
than too very s t can will just don should now d ll m o re ve y ain aren couldn didn doesn hadn hasn haven isn ma
mightn mustn needn shan shouldn wasn weren won wouldn
`.trim().split(/\s+/));

const WORD = /[\p{L}\p{N}]+/gu;

/** Every letter/number run, lowercased, with UTF-16 offsets and contiguous surface positions. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  if (!text) return tokens;
  WORD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD.exec(text)) !== null) {
    const surface = match[0]!;
    tokens.push({ term: surface.toLowerCase(), start: match.index, end: match.index + surface.length, position: tokens.length });
  }
  return tokens;
}

/**
 * Porter Stemmer (Martin Porter, 1980) for English.
 * Strips morphological suffixes to map word variants (e.g. detect, detection, detecting -> detect).
 */
export function stem(word: string): string {
  if (word.length < 3) return word.toLowerCase();
  let w = word.toLowerCase();

  const isConsonant = (str: string, i: number): boolean => {
    const c = str[i]!;
    if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
    if (c === 'y') return i === 0 ? true : !isConsonant(str, i - 1);
    return true;
  };

  const measure = (str: string): number => {
    let n = 0;
    let i = 0;
    const len = str.length;
    while (i < len && isConsonant(str, i)) i++;
    while (i < len) {
      while (i < len && !isConsonant(str, i)) i++;
      if (i < len) {
        n++;
        while (i < len && isConsonant(str, i)) i++;
      }
    }
    return n;
  };

  const hasVowel = (str: string): boolean => {
    for (let i = 0; i < str.length; i++) {
      if (!isConsonant(str, i)) return true;
    }
    return false;
  };

  const endsWithDoubleConsonant = (str: string): boolean => {
    const len = str.length;
    if (len < 2) return false;
    if (str[len - 1] !== str[len - 2]) return false;
    return isConsonant(str, len - 1);
  };

  const cvc = (str: string): boolean => {
    const len = str.length;
    if (len < 3) return false;
    if (!isConsonant(str, len - 1) || isConsonant(str, len - 2) || !isConsonant(str, len - 3)) return false;
    const last = str[len - 1]!;
    if (last === 'w' || last === 'x' || last === 'y') return false;
    return true;
  };

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (!w.endsWith('ss') && w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let extra1b = false;
  if (w.endsWith('eed')) {
    const s = w.slice(0, -3);
    if (measure(s) > 0) w = s + 'ee';
  } else if (w.endsWith('ed')) {
    const s = w.slice(0, -2);
    if (hasVowel(s)) {
      w = s;
      extra1b = true;
    }
  } else if (w.endsWith('ing')) {
    const s = w.slice(0, -3);
    if (hasVowel(s)) {
      w = s;
      extra1b = true;
    }
  }
  if (extra1b) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (endsWithDoubleConsonant(w) && !w.endsWith('l') && !w.endsWith('s') && !w.endsWith('z')) {
      w = w.slice(0, -1);
    } else if (measure(w) === 1 && cvc(w)) {
      w += 'e';
    }
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w.slice(0, -1))) {
    w = w.slice(0, -1) + 'i';
  }

  // Step 2
  const step2Pairs: [string, string][] = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['abli', 'able'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
  ];
  for (const [suffix, repl] of step2Pairs) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, -suffix.length);
      if (measure(s) > 0) w = s + repl;
      break;
    }
  }

  // Step 3
  const step3Pairs: [string, string][] = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'],
    ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', ''],
  ];
  for (const [suffix, repl] of step3Pairs) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, -suffix.length);
      if (measure(s) > 0) w = s + repl;
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant',
    'ement', 'ment', 'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
  ];
  for (const suffix of step4Suffixes) {
    if (w.endsWith(suffix)) {
      const s = w.slice(0, -suffix.length);
      if (measure(s) > 1) w = s;
      break;
    }
  }
  if (w.endsWith('ion')) {
    const s = w.slice(0, -3);
    if (measure(s) > 1 && (s.endsWith('s') || s.endsWith('t'))) {
      w = s;
    }
  }

  // Step 5a
  if (w.endsWith('e')) {
    const s = w.slice(0, -1);
    const m = measure(s);
    if (m > 1 || (m === 1 && !cvc(s))) {
      w = s;
    }
  }

  // Step 5b
  if (w.endsWith('ll') && measure(w.slice(0, -1)) > 1) {
    w = w.slice(0, -1);
  }

  return w;
}

/** Scoring normalization: the surface stream minus stopwords. */
export const keyTerms = (text: string): string[] =>
  tokenize(text).filter(token => !STOPWORDS.has(token.term)).map(token => token.term);

/**
 * String queries keep term-frequency weights. A weight map distributes each
 * key's weight evenly over its scoring tokens (a multiword key acts as one
 * weighted unit); overlapping keys accumulate and total mass is preserved.
 * Non-finite or negative weights and positive stopword-only keys are rejected.
 */
const queryWeights = (query: string | Record<string, number>): Map<string, number> => {
  const weights = new Map<string, number>();
  if (typeof query === 'string') {
    for (const term of keyTerms(query)) weights.set(term, (weights.get(term) ?? 0) + 1);
    return weights;
  }
  if (!query || typeof query !== 'object') throw new Error('PassageIndex.rank: query must be a string or weight map');
  for (const [key, weight] of Object.entries(query)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`PassageIndex.rank: invalid weight for query key "${key}"`);
    }
    if (weight === 0) continue;
    const parts = keyTerms(key);
    if (!parts.length) {
      throw new Error(`PassageIndex.rank: stopword-only query key "${key}" carries positive weight`);
    }
    const share = weight / parts.length;
    for (const term of parts) weights.set(term, (weights.get(term) ?? 0) + share);
  }
  return weights;
};

/** Opaque statistics-epoch tag: identifies a corpus basis without retaining an index pointer. */
const fingerprint = (parts: string[]): string => {
  const text = parts.join('\u0000');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
};

interface HitBasis { basis: string; vector: Map<string, number>; }

/** Fresh rank hits carry their corpus basis and immutable TF-IDF vector for mmr. */
const hitVectors = new WeakMap<SearchHit, HitBasis>();

const containsPhrase = (stream: string[], phrase: string[]): boolean => countPhrase(stream, phrase) > 0;

const countPhrase = (stream: string[], phrase: string[]): number => {
  if (phrase.length === 0 || phrase.length > stream.length) return 0;
  let count = 0;
  for (let i = 0; i + phrase.length <= stream.length; i++) {
    let hit = true;
    for (let k = 0; k < phrase.length; k++) {
      if (stream[i + k] !== phrase[k]) { hit = false; break; }
    }
    if (hit) count++;
  }
  return count;
};

/** All phrase terms present inside one bounded window, any order (nearby occurrence). */
const nearPhrase = (stream: string[], phrase: string[]): boolean => {
  const window = phrase.length + 2;
  for (let i = 0; i + phrase.length <= stream.length; i++) {
    const slice = stream.slice(i, i + window);
    if (phrase.every(term => slice.includes(term))) return true;
  }
  return false;
};

/** Occurrences where t1 and t2 appear within windowSize tokens of each other in stream. */
const countWindow = (stream: string[], t1: string, t2: string, windowSize: number): number => {
  if (stream.length < 2) return 0;
  let count = 0;
  for (let i = 0; i < stream.length; i++) {
    if (stream[i] === t1) {
      const from = Math.max(0, i - windowSize + 1);
      const to = Math.min(stream.length, i + windowSize);
      for (let j = from; j < to; j++) {
        if (i !== j && stream[j] === t2) {
          count++;
          break;
        }
      }
    }
  }
  return count;
};

const shinglesOf = (terms: string[]): Set<string> => {
  const out = new Set<string>();
  if (!terms.length) return out;
  if (terms.length < SHINGLE) { out.add(terms.join(' ')); return out; }
  for (let i = 0; i + SHINGLE <= terms.length; i++) out.add(terms.slice(i, i + SHINGLE).join(' '));
  return out;
};

// ------------------------------------------------------------------ segmentation

interface Unit { start: number; end: number; tokens: number; heading: string | undefined; overlap: boolean; }

const trimRange = (text: string, from: number, to: number, out: [number, number][]): void => {
  let start = from, end = to;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end > start) out.push([start, end]);
};

function paragraphRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const separator = /\n[ \t\r]*\n+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(text)) !== null) {
    trimRange(text, cursor, match.index, ranges);
    cursor = match.index + match[0].length;
  }
  trimRange(text, cursor, text.length, ranges);
  if (ranges.length <= 1 && text.includes('\n')) {
    // No blank-line structure: fall back to line units so packing still works.
    ranges.length = 0;
    const line = /\n+/g;
    cursor = 0;
    while ((match = line.exec(text)) !== null) {
      trimRange(text, cursor, match.index, ranges);
      cursor = match.index + match[0].length;
    }
    trimRange(text, cursor, text.length, ranges);
  }
  return ranges;
}

const MARKDOWN_HEADING = /^#{1,6}\s+(.*)$/;

function headingLabel(raw: string): string | undefined {
  const trimmed = raw.trim();
  const markdown = MARKDOWN_HEADING.exec(trimmed);
  if (markdown) return (markdown[1] ?? '').trim() || undefined;
  if (trimmed.includes('\n') || trimmed.length > 80) return undefined;
  const words = trimmed.split(/\s+/);
  if (words.length > 12 || !/\p{L}/u.test(trimmed)) return undefined;
  if (/[.!?,;:]["')\]]?$/.test(trimmed)) return undefined;
  if (!/^[\p{Lu}\d]/u.test(trimmed)) return undefined;
  return trimmed;
}

function pageAt(pages: Snapshot['pages'], start: number): number | undefined {
  if (!pages || !pages.length) return undefined;
  let chosen: { page: number; start: number } | undefined;
  for (const entry of pages) {
    if (entry.page >= 1 && entry.start <= start && start < entry.end && (!chosen || entry.start >= chosen.start)) {
      chosen = { page: entry.page, start: entry.start };
    }
  }
  return chosen?.page;
}

const trimEndAt = (text: string, from: number, to: number): number => {
  let end = to;
  while (end > from && /\s/.test(text[end - 1]!)) end--;
  return end;
};

/** Sentence punctuation or a line break in the gap that follows one token. */
const SENTENCE_END = /[.!?\u2026]["'\u201d\u2019)\]]*(?=\s|$)/u;
const endsSentence = (raw: string, end: number, next: number): boolean => {
  const gap = raw.slice(end, next);
  return gap.includes('\n') || SENTENCE_END.test(gap);
};

/** Cut inside one overlong token, never between the halves of a surrogate pair. */
const hardCut = (raw: string, from: number, limit: number): number => {
  let cut = Math.min(raw.length, from + limit);
  if (cut >= raw.length) return raw.length;
  const code = raw.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut > from ? cut : from + 1;
};

/**
 * Split one over-cap paragraph range into pieces that each fit both caps. Every
 * piece is an exact, trimmed source slice; a break lands after sentence-ending
 * punctuation when that keeps at least SEGMENT_MIN tokens, otherwise at the cap.
 * Pieces never become headings and never seed contextual overlap. The range is
 * tokenized once, so a very long paragraph stays linear in its own length.
 */
function splitRange(text: string, from: number, to: number): Unit[] {
  const pieces: Unit[] = [];
  const raw = text.slice(from, to);
  const tokens = tokenize(raw);
  let cursor = 0;
  while (cursor < tokens.length) {
    const origin = tokens[cursor]!.start;
    let fit = cursor;
    while (fit < tokens.length && fit - cursor < SEGMENT_MAX && tokens[fit]!.end - origin <= SEGMENT_MAX_CHARS) fit++;
    if (fit === cursor) {
      // One token alone exceeds the text cap: cut it and continue with the fragment.
      const cut = hardCut(raw, origin, SEGMENT_MAX_CHARS);
      pieces.push({ start: from + origin, end: from + cut, tokens: 1, heading: undefined, overlap: false });
      tokens[cursor] = { ...tokens[cursor]!, start: cut };
      continue;
    }
    let take = fit;
    if (fit < tokens.length && fit - cursor >= SEGMENT_MIN) {
      for (let k = fit; k - cursor >= SEGMENT_MIN; k--) {
        if (endsSentence(raw, tokens[k - 1]!.end, tokens[k]!.start)) { take = k; break; }
      }
    }
    // Keep the punctuation that closes the last token, but never past the text cap.
    const end = Math.min(
      trimEndAt(raw, tokens[take - 1]!.end, take < tokens.length ? tokens[take]!.start : raw.length),
      origin + SEGMENT_MAX_CHARS,
    );
    pieces.push({ start: from + origin, end: from + end, tokens: take - cursor, heading: undefined, overlap: false });
    cursor = take;
  }
  return pieces;
}

/** Trimmed paragraph units, with paragraphs that exceed a cap split into bounded pieces. */
function paragraphUnits(text: string): Unit[] {
  const units: Unit[] = [];
  for (const [start, end] of paragraphRanges(text)) {
    const raw = text.slice(start, end);
    const tokens = tokenize(raw).length;
    if (tokens <= SEGMENT_MAX && raw.length <= SEGMENT_MAX_CHARS) {
      units.push({ start, end, tokens, heading: headingLabel(raw), overlap: true });
      continue;
    }
    units.push(...splitRange(text, start, end));
  }
  return units;
}

/** Paragraph-aware passages targeting SEGMENT_MIN..SEGMENT_MAX tokens with limited overlap. */
export function segment(snapshot: Snapshot): Passage[] {
  const text = snapshot.text;
  if (!text) return [];
  const units = paragraphUnits(text);
  if (!units.length) return [];
  const sections: (string | undefined)[] = [];
  let current: string | undefined;
  for (const unit of units) {
    if (unit.heading) current = unit.heading;
    sections.push(current);
  }
  const passages: Passage[] = [];
  let i = 0;
  while (i < units.length) {
    const start = units[i]!.start;
    let count = 0;
    let j = i;
    while (j < units.length) {
      const unit = units[j]!;
      if (j > i && (count + unit.tokens > SEGMENT_MAX || unit.end - start > SEGMENT_MAX_CHARS)) break;
      count += unit.tokens;
      j++;
    }
    const end = units[j - 1]!.end;
    const passage: Passage = {
      id: `${snapshot.id}:${start}`, snapshotId: snapshot.id, start, end,
      text: text.slice(start, end), duplicateGroup: `${snapshot.id}:${start}`,
    };
    const section = sections[i];
    if (section) passage.section = section;
    const page = pageAt(snapshot.pages, start);
    if (page !== undefined) passage.page = page;
    passages.push(passage);
    // Carry at most one small trailing paragraph into the next passage as context.
    const previous = units[j - 1]!;
    i = (j - 1 > i && previous.overlap && previous.tokens <= SEGMENT_OVERLAP_MAX) ? j - 1 : j;
  }
  return passages;
}

// ------------------------------------------------------------------ index

export interface IndexStats {
  /** BM25 document count: passages carrying postings; exact-body aliases excluded. */
  n: number;
  /** Accepted passages including exact-body aliases. */
  passages: number;
  aliases: number;
  terms: number;
  tokens: number;
  avg: number;
  groups: number;
  revision: number;
}

export interface SDMWeights {
  lambdaT?: number;
  lambdaO?: number;
  lambdaU?: number;
  mu?: number;
  windowSize?: number;
}

interface IndexedPassage {
  passage: Passage;
  tokens: Token[];
  surface: string[];
  content: string[];
  stems: string[];
  length: number;
  shingles: Set<string>;
}

/**
 * Positional index over accepted passages. `add` accepts a growing corpus in
 * any chunking; every accepted intake rebuilds grouping, postings and stats
 * from the accepted set so results are independent of intake order.
 */
export class PassageIndex {
  private accepted = new Map<string, Passage>();
  private records = new Map<string, IndexedPassage>();
  private postings = new Map<string, string[]>();
  private df = new Map<string, number>();
  private stemPostings = new Map<string, string[]>();
  private stemDf = new Map<string, number>();
  private contentCf = new Map<string, number>();
  private totalContentTokens = 0;
  private basisTag = 'empty';
  private statsValue: IndexStats = { n: 0, passages: 0, aliases: 0, terms: 0, tokens: 0, avg: 0, groups: 0, revision: 0 };

  add(passages: Passage[]): void {
    let added = false;
    passages.forEach((passage, at) => {
      if (!passage || typeof passage.id !== 'string' || !passage.id ||
          typeof passage.snapshotId !== 'string' || typeof passage.text !== 'string' ||
          !Number.isInteger(passage.start) || !Number.isInteger(passage.end) ||
          passage.start < 0 || passage.end <= passage.start ||
          passage.end - passage.start !== passage.text.length) {
        throw new Error(`PassageIndex.add: malformed passage at index ${at}`);
      }
      if (this.accepted.has(passage.id)) return;
      this.accepted.set(passage.id, { ...passage });
      added = true;
    });
    if (added) this.rebuild();
  }

  get(id: string): Passage | undefined {
    const passage = this.accepted.get(id);
    return passage ? { ...passage } : undefined;
  }

  all(): Passage[] {
    return [...this.accepted.keys()].sort().map(id => ({ ...this.accepted.get(id)! }));
  }

  get stats(): IndexStats { return { ...this.statsValue }; }

  documentCount(): number { return this.statsValue.n; }

  /**
   * Positional document frequency over distinct passages. Single terms use the
   * df table; multiword phrases match surface tokens consecutively, so a
   * function-word gap blocks an exact match.
   * If options.stem is true, document frequency is evaluated on the stemmed stream.
   */
  documentFrequency(termOrPhrase: string, options?: { stem?: boolean }): number {
    const isStem = Boolean(options?.stem);
    const phrase = tokenize(termOrPhrase).map(token => isStem ? stem(token.term) : token.term);
    if (!phrase.length) return 0;
    if (phrase.length === 1) return (isStem ? this.stemDf.get(phrase[0]!) : this.df.get(phrase[0]!)) ?? 0;
    let df = 0;
    for (const record of this.records.values()) {
      const stream = isStem ? record.stems : record.surface;
      if (containsPhrase(stream, phrase)) df++;
    }
    return df;
  }

  /**
   * Weighted BM25 (k1=1.2, b=0.75) over a string or weighted term map, with
   * per-term contributions and a small exact/proximity phrase bonus computed on
   * surface tokens. Ties break by passage id so output is deterministic across
   * intake order; fresh hits carry their corpus basis and TF-IDF vector.
   * If options.stem is true, terms and phrases match against the stemmed stream.
   */
  rank(query: string | Record<string, number>, limit = 30, phrases?: string[], options?: { stem?: boolean }): SearchHit[] {
    if (limit <= 0 || !this.records.size) return [];
    const isStem = Boolean(options?.stem);
    const rawWeights = queryWeights(query);
    if (!rawWeights.size) return [];
    const weights = new Map<string, number>();
    if (isStem) {
      for (const [term, weight] of rawWeights) {
        const st = stem(term);
        weights.set(st, (weights.get(st) ?? 0) + weight);
      }
    } else {
      for (const [term, weight] of rawWeights) weights.set(term, weight);
    }
    const dfSource = isStem ? this.stemDf : this.df;
    const postingsSource = isStem ? this.stemPostings : this.postings;
    const { n, avg } = this.statsValue;
    const idfs = new Map<string, number>();
    for (const term of weights.keys()) {
      const df = dfSource.get(term) ?? 0;
      idfs.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    }
    const tfs = new Map<string, Map<string, number>>();
    for (const term of weights.keys()) {
      for (const id of postingsSource.get(term) ?? []) {
        let byTerm = tfs.get(id);
        if (!byTerm) { byTerm = new Map(); tfs.set(id, byTerm); }
        byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
      }
    }
    const phraseStreams = (phrases ?? [])
      .map(phrase => tokenize(phrase).map(token => isStem ? stem(token.term) : token.term))
      .filter(stream => stream.length >= 2);
    const queryOrder = [...weights.keys()];
    const hits: SearchHit[] = [];
    for (const [id, tfMap] of tfs) {
      const record = this.records.get(id);
      if (!record) continue;
      const length = record.length;
      const norm = avg > 0 ? K1 * (1 - B + B * (length / avg)) : K1;
      const terms: TermScore[] = [];
      let score = 0;
      for (const term of queryOrder) {
        const tf = tfMap.get(term) ?? 0;
        const weight = weights.get(term)!;
        const df = dfSource.get(term) ?? 0;
        const idf = idfs.get(term)!;
        const contribution = tf > 0 ? weight * idf * ((tf * (K1 + 1)) / (tf + norm)) : 0;
        score += contribution;
        terms.push({ term, weight, tf, df, idf, contribution });
      }
      let phraseBonus = 0;
      const matchStream = isStem ? record.stems : record.surface;
      for (const stream of phraseStreams) {
        const occurrences = countPhrase(matchStream, stream);
        if (occurrences > 0) phraseBonus += PHRASE_EXACT_BONUS + PHRASE_OCCURRENCE_BONUS * Math.min(occurrences - 1, 2);
        else if (nearPhrase(matchStream, stream)) phraseBonus += PHRASE_PROXIMITY_BONUS;
      }
      score += phraseBonus;
      hits.push({ passage: { ...record.passage }, score, terms, phraseBonus, length, averageLength: avg });
    }
    hits.sort((a, b) => b.score - a.score || (a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0));
    const limited = hits.slice(0, limit);
    for (const hit of limited) {
      const record = this.records.get(hit.passage.id);
      if (record) hitVectors.set(hit, { basis: this.basisTag, vector: this.tfidfVector(record) });
    }
    return limited;
  }

  /**
   * Ranked BM25 using Porter stemming on terms and phrases.
   * Original surface tokens and character spans in hit passages are preserved.
   */
  rankStemmed(query: string | Record<string, number>, limit = 30, phrases?: string[]): SearchHit[] {
    return this.rank(query, limit, phrases, { stem: true });
  }

  /**
   * Query-Likelihood Language Model with Bayesian Dirichlet smoothing (Zhai & Lafferty, 2001).
   *
   * score(d) = Σ_{w ∈ q} c(w, q) * log(1 + tf(w, d) / (μ * P(w|C))) + |q| * log(μ / (|d| + μ))
   */
  rankQL(query: string | Record<string, number>, limit = 30, mu = 2000): SearchHit[] {
    if (limit <= 0 || !this.records.size) return [];
    const weights = queryWeights(query);
    if (!weights.size) return [];
    const totalC = Math.max(this.totalContentTokens, 1);
    const queryTerms = [...weights.keys()];
    const totalQueryWeight = [...weights.values()].reduce((sum, w) => sum + w, 0);

    const tfs = new Map<string, Map<string, number>>();
    for (const term of queryTerms) {
      for (const id of this.postings.get(term) ?? []) {
        let byTerm = tfs.get(id);
        if (!byTerm) { byTerm = new Map(); tfs.set(id, byTerm); }
        byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
      }
    }
    if (!tfs.size) return [];

    const hits: SearchHit[] = [];
    for (const [id, tfMap] of tfs) {
      const record = this.records.get(id);
      if (!record) continue;
      const docLen = Math.max(record.length, 1);
      const lengthPenalty = Math.log(mu / (docLen + mu));
      let score = totalQueryWeight * lengthPenalty;
      const terms: TermScore[] = [];

      for (const term of queryTerms) {
        const weight = weights.get(term)!;
        const tf = tfMap.get(term) ?? 0;
        const cf = this.contentCf.get(term) ?? 0;
        const df = this.df.get(term) ?? 0;
        const pC = Math.max(cf, 0.5) / totalC;
        const idf = Math.log(1 / pC);
        const matchGain = tf > 0 ? weight * Math.log(1 + tf / (mu * pC)) : 0;
        score += matchGain;
        terms.push({ term, weight, tf, df, idf, contribution: weight * lengthPenalty + matchGain });
      }

      hits.push({
        passage: { ...record.passage },
        score,
        terms,
        phraseBonus: 0,
        length: record.length,
        averageLength: this.statsValue.avg,
      });
    }

    hits.sort((a, b) => b.score - a.score || (a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0));
    const limited = hits.slice(0, limit);
    for (const hit of limited) {
      const record = this.records.get(hit.passage.id);
      if (record) hitVectors.set(hit, { basis: this.basisTag, vector: this.tfidfVector(record) });
    }
    return limited;
  }

  /**
   * Sequential Dependence Model / Markov Random Field retrieval (Metzler & Croft, 2005).
   * Linearly combines unigram Dirichlet language model (λ_T = 0.85),
   * ordered bigram window #1 (λ_O = 0.10), and unordered window bigrams #8 (λ_U = 0.05).
   */
  rankSDM(
    query: string | Record<string, number>,
    limit = 30,
    weights?: SDMWeights,
  ): SearchHit[] {
    if (limit <= 0 || !this.records.size) return [];
    const lambdaT = weights?.lambdaT ?? 0.85;
    const lambdaO = weights?.lambdaO ?? 0.10;
    const lambdaU = weights?.lambdaU ?? 0.05;
    const mu = weights?.mu ?? 2000;
    const windowSize = weights?.windowSize ?? 8;

    const qWeights = queryWeights(query);
    if (!qWeights.size) return [];
    const queryTerms = [...qWeights.keys()];

    if (queryTerms.length < 2) {
      return this.rankQL(query, limit, mu);
    }

    const totalC = Math.max(this.totalContentTokens, 1);
    const totalSurfaceC = Math.max(this.statsValue.tokens, 1);
    const totalQueryWeight = [...qWeights.values()].reduce((sum, w) => sum + w, 0);

    const candidateIds = new Set<string>();
    const tfs = new Map<string, Map<string, number>>();
    for (const term of queryTerms) {
      for (const id of this.postings.get(term) ?? []) {
        candidateIds.add(id);
        let byTerm = tfs.get(id);
        if (!byTerm) { byTerm = new Map(); tfs.set(id, byTerm); }
        byTerm.set(term, (byTerm.get(term) ?? 0) + 1);
      }
    }
    if (!candidateIds.size) return [];

    const pairs: [string, string][] = [];
    for (let i = 0; i < queryTerms.length - 1; i++) {
      pairs.push([queryTerms[i]!, queryTerms[i + 1]!]);
    }

    const cfO = new Map<string, number>();
    const cfU = new Map<string, number>();
    for (const [t1, t2] of pairs) {
      const key = `${t1}\0${t2}`;
      let cO = 0;
      let cU = 0;
      for (const record of this.records.values()) {
        cO += countPhrase(record.surface, [t1, t2]);
        cU += countWindow(record.surface, t1, t2, windowSize);
      }
      cfO.set(key, cO);
      cfU.set(key, cU);
    }

    const hits: SearchHit[] = [];
    for (const id of candidateIds) {
      const record = this.records.get(id);
      if (!record) continue;
      const docLen = Math.max(record.length, 1);
      const surfaceLen = Math.max(record.tokens.length, 1);
      const lengthPenaltyT = Math.log(mu / (docLen + mu));
      const lengthPenaltyO = Math.log(mu / (surfaceLen + mu));
      const lengthPenaltyU = Math.log(mu / (surfaceLen + mu));

      // 1. Unigram feature f_T
      let scoreT = totalQueryWeight * lengthPenaltyT;
      const terms: TermScore[] = [];
      const tfMap = tfs.get(id);
      for (const term of queryTerms) {
        const weight = qWeights.get(term)!;
        const tf = tfMap?.get(term) ?? 0;
        const cf = this.contentCf.get(term) ?? 0;
        const df = this.df.get(term) ?? 0;
        const pC = Math.max(cf, 0.5) / totalC;
        const idf = Math.log(1 / pC);
        const matchGain = tf > 0 ? weight * Math.log(1 + tf / (mu * pC)) : 0;
        scoreT += matchGain;
        terms.push({ term, weight, tf, df, idf, contribution: weight * lengthPenaltyT + matchGain });
      }

      // 2. Ordered bigram feature f_O (#1)
      let scoreO = pairs.length * lengthPenaltyO;
      for (const [t1, t2] of pairs) {
        const key = `${t1}\0${t2}`;
        const tfO = countPhrase(record.surface, [t1, t2]);
        const pCO = Math.max(cfO.get(key) ?? 0, 0.5) / totalSurfaceC;
        if (tfO > 0) {
          scoreO += Math.log(1 + tfO / (mu * pCO));
        }
      }

      // 3. Unordered window feature f_U (#windowSize)
      let scoreU = pairs.length * lengthPenaltyU;
      for (const [t1, t2] of pairs) {
        const key = `${t1}\0${t2}`;
        const tfU = countWindow(record.surface, t1, t2, windowSize);
        const pCU = Math.max(cfU.get(key) ?? 0, 0.5) / totalSurfaceC;
        if (tfU > 0) {
          scoreU += Math.log(1 + tfU / (mu * pCU));
        }
      }

      const totalScore = lambdaT * scoreT + lambdaO * scoreO + lambdaU * scoreU;
      const phraseBonus = lambdaO * scoreO + lambdaU * scoreU;

      hits.push({
        passage: { ...record.passage },
        score: totalScore,
        terms,
        phraseBonus,
        length: record.length,
        averageLength: this.statsValue.avg,
      });
    }

    hits.sort((a, b) => b.score - a.score || (a.passage.id < b.passage.id ? -1 : a.passage.id > b.passage.id ? 1 : 0));
    const limited = hits.slice(0, limit);
    for (const hit of limited) {
      const record = this.records.get(hit.passage.id);
      if (record) hitVectors.set(hit, { basis: this.basisTag, vector: this.tfidfVector(record) });
    }
    return limited;
  }

  /** Full-corpus TF-IDF vector for a ranked passage (content stream, L2-normalized). */
  private tfidfVector(record: IndexedPassage): Map<string, number> {
    const tf = new Map<string, number>();
    for (const term of record.content) tf.set(term, (tf.get(term) ?? 0) + 1);
    const vector = new Map<string, number>();
    let square = 0;
    const n = this.statsValue.n;
    for (const [term, frequency] of tf) {
      const df = this.df.get(term) ?? 0;
      const weight = frequency * Math.log(1 + (n - df + 0.5) / (df + 0.5));
      vector.set(term, weight);
      square += weight * weight;
    }
    if (square > 0) {
      const norm = Math.sqrt(square);
      for (const [term, weight] of vector) vector.set(term, weight / norm);
    }
    return vector;
  }

  private rebuild(): void {
    const accepted = [...this.accepted.values()];
    // Exact-body duplicates: one canonical (min id), the rest become aliases.
    const byText = new Map<string, string[]>();
    for (const passage of accepted) {
      const ids = byText.get(passage.text);
      if (ids) ids.push(passage.id);
      else byText.set(passage.text, [passage.id]);
    }
    const canonicalOf = new Map<string, string>();
    for (const [body, ids] of byText) {
      ids.sort();
      canonicalOf.set(body, ids[0]!);
    }
    const canonicalIds = [...canonicalOf.values()].sort();
    const records = new Map<string, IndexedPassage>();
    for (const id of canonicalIds) {
      const passage = this.accepted.get(id)!;
      const tokens = tokenize(passage.text);
      const content = tokens.filter(token => !STOPWORDS.has(token.term)).map(token => token.term);
      const stems = content.map(term => stem(term));
      records.set(id, {
        passage, tokens, surface: tokens.map(token => token.term), content, stems, length: content.length,
        shingles: shinglesOf(tokens.map(token => token.term)),
      });
    }
    // Near-duplicate groups (order-independent union-find over canonicals).
    const parent = new Map<string, string>(canonicalIds.map(id => [id, id]));
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root)!;
      let cursor = id;
      while (parent.get(cursor) !== root) { const next = parent.get(cursor)!; parent.set(cursor, root); cursor = next; }
      return root;
    };
    for (let a = 0; a < canonicalIds.length; a++) {
      for (let b = a + 1; b < canonicalIds.length; b++) {
        const left = records.get(canonicalIds[a]!)!;
        const right = records.get(canonicalIds[b]!)!;
        const small = left.shingles.size <= right.shingles.size ? left.shingles : right.shingles;
        const large = left.shingles.size <= right.shingles.size ? right.shingles : left.shingles;
        if (!small.size || !large.size || small.size / large.size < NEAR_DUPLICATE_JACCARD) continue;
        let intersection = 0;
        for (const shingle of small) if (large.has(shingle)) intersection++;
        const union = small.size + large.size - intersection;
        if (union > 0 && intersection / union >= NEAR_DUPLICATE_JACCARD) {
          const rootA = find(canonicalIds[a]!);
          const rootB = find(canonicalIds[b]!);
          if (rootA !== rootB) parent.set(rootA, rootB);
        }
      }
    }
    const groupOfRoot = new Map<string, string>();
    for (const id of canonicalIds) {
      const root = find(id);
      const prior = groupOfRoot.get(root);
      if (prior === undefined || id < prior) groupOfRoot.set(root, id);
    }
    // Derived copies for every accepted passage (aliases inherit the group).
    const groups = new Set<string>();
    const copies = new Map<string, Passage>();
    for (const passage of accepted) {
      const canonical = canonicalOf.get(passage.text)!;
      const group = groupOfRoot.get(find(canonical))!;
      copies.set(passage.id, { ...passage, duplicateGroup: group });
      groups.add(group);
    }
    this.accepted = copies;
    for (const id of canonicalIds) records.get(id)!.passage = copies.get(id)!;
    // Postings over canonicals in sorted id order (occurrence lists, so tf
    // counts repeats); distinct-document df and stats derive from the accepted set.
    const postings = new Map<string, string[]>();
    const df = new Map<string, number>();
    const stemPostings = new Map<string, string[]>();
    const stemDf = new Map<string, number>();
    const contentCf = new Map<string, number>();
    let tokens = 0;
    let totalLength = 0;
    for (const id of canonicalIds) {
      const record = records.get(id)!;
      tokens += record.tokens.length;
      totalLength += record.length;
      for (const token of record.tokens) {
        const list = postings.get(token.term);
        if (list) list.push(id);
        else postings.set(token.term, [id]);
      }
      for (const term of new Set(record.surface)) df.set(term, (df.get(term) ?? 0) + 1);

      for (const st of record.stems) {
        const list = stemPostings.get(st);
        if (list) list.push(id);
        else stemPostings.set(st, [id]);
      }
      for (const st of new Set(record.stems)) stemDf.set(st, (stemDf.get(st) ?? 0) + 1);

      for (const term of record.content) {
        contentCf.set(term, (contentCf.get(term) ?? 0) + 1);
      }
    }
    this.records = records;
    this.postings = postings;
    this.df = df;
    this.stemPostings = stemPostings;
    this.stemDf = stemDf;
    this.contentCf = contentCf;
    this.totalContentTokens = totalLength;
    const n = canonicalIds.length;
    const snapshots = new Set(accepted.map(passage => passage.snapshotId));
    this.statsValue = {
      n,
      passages: accepted.length,
      aliases: accepted.length - n,
      terms: postings.size,
      tokens,
      avg: n > 0 ? totalLength / n : 0,
      groups: groups.size,
      revision: snapshots.size,
    };
    this.basisTag = fingerprint([
      String(n), String(accepted.length), String(postings.size), String(tokens),
      String(groups.size), String(snapshots.size), String(this.statsValue.avg), canonicalIds.join('|'),
    ]);
  }
}

// ------------------------------------------------------------------ diversification

const cosine = (a: Map<string, number>, b: Map<string, number>): number => {
  if (!a.size || !b.size) return 0;
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  return Math.min(1, Math.max(0, dot));
};

/**
 * Maximal marginal relevance: normalized BM25 relevance minus maximum cosine
 * similarity to already-selected hits. Full-corpus TF-IDF vectors are used
 * only when every supplied hit carries the same corpus basis (fresh rank hits);
 * arbitrary, copied or mixed-basis hits fall back to pool TF-IDF for all of
 * them, so IDF bases are never mixed. Returns fresh hit objects in selection
 * order with basis metadata transferred; inputs are never mutated. Ordinary
 * selection emits one representative per duplicate group; variants stay indexed.
 */
export function mmr(hits: SearchHit[], count = 8, lambda = 0.75): SearchHit[] {
  if (count <= 0 || !hits.length) return [];
  const total = Math.min(count, hits.length);
  let maxScore = 0;
  for (const hit of hits) if (hit.score > maxScore) maxScore = hit.score;
  const metadata = hits.map(hit => hitVectors.get(hit));
  const basis = metadata[0]?.basis;
  const compatible = basis !== undefined && metadata.every(entry => entry?.basis === basis);
  let vectors: Map<string, number>[];
  if (compatible) {
    vectors = metadata.map(entry => entry!.vector);
  } else {
    // Explicit fallback: arbitrary, copied or mixed-basis hits all get pool TF-IDF.
    const streams = hits.map(hit => keyTerms(hit.passage.text));
    const poolDf = new Map<string, number>();
    for (const stream of streams) {
      for (const term of new Set(stream)) poolDf.set(term, (poolDf.get(term) ?? 0) + 1);
    }
    vectors = streams.map(stream => {
      const tf = new Map<string, number>();
      for (const term of stream) tf.set(term, (tf.get(term) ?? 0) + 1);
      const vector = new Map<string, number>();
      let square = 0;
      for (const [term, frequency] of tf) {
        const df = poolDf.get(term)!;
        const weight = frequency * Math.log(1 + (streams.length - df + 0.5) / (df + 0.5));
        vector.set(term, weight);
        square += weight * weight;
      }
      if (square > 0) {
        const norm = Math.sqrt(square);
        for (const [term, weight] of vector) vector.set(term, weight / norm);
      }
      return vector;
    });
  }
  const relevance = hits.map(hit => (maxScore > 0 ? Math.max(0, hit.score) / maxScore : 0));
  const chosen = new Set<number>();
  const groups = new Set<string>();
  const order: number[] = [];
  const values: number[] = new Array(hits.length).fill(0);
  while (order.length < total) {
    let best = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < hits.length; i++) {
      if (chosen.has(i) || groups.has(hits[i]!.passage.duplicateGroup || hits[i]!.passage.id)) continue;
      let similarity = 0;
      for (const selected of order) similarity = Math.max(similarity, cosine(vectors[i]!, vectors[selected]!));
      const value = lambda * relevance[i]! - (1 - lambda) * similarity;
      if (value > bestValue) { bestValue = value; best = i; }
    }
    if (best < 0) break;
    chosen.add(best);
    groups.add(hits[best]!.passage.duplicateGroup || hits[best]!.passage.id);
    order.push(best);
    values[best] = bestValue;
  }
  return order.map(i => {
    const fresh = { ...hits[i]!, mmr: values[i] };
    const entry = metadata[i];
    if (entry) hitVectors.set(fresh, entry); // transfer basis metadata to fresh output hits
    return fresh;
  });
}

// ------------------------------------------------------------------ corpus-derived expansion

const BOILERPLATE = new Set([
  'cookie', 'cookies', 'javascript', 'sitemap', 'bookmark', 'bookmarks', 'advertisement', 'advertisements',
  'disclaimer', 'copyright', 'newsletter', 'subscribe', 'subscription', 'login', 'logout', 'homepage',
  'sidebar', 'footer', 'navigation', 'menu', 'tweet', 'retweet', 'permalink', 'captcha',
  'privacy policy', 'cookie policy', 'terms of service', 'terms and conditions', 'read more', 'read less',
  'click here', 'sign in', 'sign up', 'learn more', 'contact us', 'about us', 'all rights reserved',
  'skip to content', 'load more', 'show more', 'see more', 'share this', 'follow us', 'back to top',
]);

const slug = (term: string): string => {
  const normalized = term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return (normalized || 'term').slice(0, 80);
};

/**
 * Lexical pseudo-relevance feedback over engine-qualified hits: the top five
 * passages that overlap the anchor context, from distinct duplicate groups and
 * at most one per snapshot, with latest `irrelevant` feedback rejected and
 * `useful` preferred (empty feedback still yields plain lexical PRF). Adjacent
 * 1-4 surface windows keep internal function words (content word required,
 * never leading/trailing) so introducing spans tokenize back to the exact
 * candidate; TF-IDF uses corpus positional df via the `index` or an explicit
 * surface pool fallback, with boilerplate filtered and used/negative/anchor
 * comparisons on content terms so function words cannot bypass discounts.
 * Returns [] when nothing qualifies.
 */
export function concepts(
  hits: SearchHit[], branch: Branch, feedback: Feedback[], limit = 12, index?: PassageIndex,
): Concept[] {
  if (limit <= 0 || !hits.length) return [];
  const latest = new Map<string, Feedback>();
  for (const entry of feedback) {
    if (entry.kind !== 'useful' && entry.kind !== 'irrelevant') continue;
    const prior = latest.get(entry.targetId);
    if (!prior || entry.createdAt >= prior.createdAt) latest.set(entry.targetId, entry);
  }
  const anchor = new Set(keyTerms(branch.anchor.trim() || branch.question.trim()));
  if (!anchor.size) return [];
  const required = Math.max(1, Math.ceil(anchor.size * ANCHOR_OVERLAP_RATIO));
  interface Qualified { hit: SearchHit; tokens: Token[]; overlap: number; useful: boolean; }
  const qualified: Qualified[] = [];
  for (const hit of hits) {
    const entry = latest.get(hit.passage.id);
    if (entry?.kind === 'irrelevant') continue;
    const tokens = tokenize(hit.passage.text);
    const content = new Set(tokens.filter(token => !STOPWORDS.has(token.term)).map(token => token.term));
    let shared = 0;
    for (const term of content) if (anchor.has(term)) shared++;
    if (shared < required) continue;
    qualified.push({ hit, tokens, overlap: shared / anchor.size, useful: entry?.kind === 'useful' });
  }
  qualified.sort((a, b) =>
    Number(b.useful) - Number(a.useful) ||
    b.hit.score - a.hit.score ||
    (a.hit.passage.id < b.hit.passage.id ? -1 : a.hit.passage.id > b.hit.passage.id ? 1 : 0));
  const pool: Qualified[] = [];
  const groups = new Set<string>();
  const snapshots = new Set<string>();
  for (const candidate of qualified) {
    if (pool.length >= PRF_POOL) break;
    const passage = candidate.hit.passage;
    const group = passage.duplicateGroup || passage.id;
    if (groups.has(group) || snapshots.has(passage.snapshotId)) continue;
    groups.add(group);
    snapshots.add(passage.snapshotId);
    pool.push(candidate);
  }
  if (!pool.length) return [];
  const negativeTerms = new Set<string>();
  for (const entry of latest.values()) {
    if (entry.kind !== 'irrelevant') continue;
    const passage = hits.find(hit => hit.passage.id === entry.targetId)?.passage ?? index?.get(entry.targetId);
    if (!passage) continue;
    for (const term of new Set(keyTerms(passage.text))) negativeTerms.add(term);
  }
  const used = new Set<string>();
  for (const phrase of [...(branch.aliases ?? []), ...(branch.queries ?? [])]) {
    for (const term of keyTerms(phrase)) used.add(term);
  }
  interface PoolCandidate { tf: number; passages: Map<string, Span>; }
  const candidates = new Map<string, PoolCandidate>();
  for (const member of pool) {
    const weight = member.useful ? USEFUL_FEEDBACK_WEIGHT : 1;
    const surface = member.tokens;
    for (let size = 1; size <= MAX_NGRAM && size <= surface.length; size++) {
      for (let i = 0; i + size <= surface.length; i++) {
        const slice = surface.slice(i, i + size);
        const first = slice[0]!;
        const last = slice[size - 1]!;
        // Windows stay adjacent on the surface stream (internal function words
        // retained) but never begin or end on a function word.
        if (STOPWORDS.has(first.term) || STOPWORDS.has(last.term)) continue;
        const term = slice.map(token => token.term).join(' ');
        if (!/\p{L}/u.test(term)) continue; // query expansion needs words, not bare numbers
        if (size === 1 && term.length < 2) continue;
        if (BOILERPLATE.has(term) || slice.some(token => BOILERPLATE.has(token.term))) continue;
        const contentParts = slice.filter(token => !STOPWORDS.has(token.term)).map(token => token.term);
        if (contentParts.every(part => anchor.has(part))) continue; // already-covered anchor vocabulary
        let entry = candidates.get(term);
        if (!entry) { entry = { tf: 0, passages: new Map() }; candidates.set(term, entry); }
        entry.tf += weight;
        if (!entry.passages.has(member.hit.passage.id)) {
          entry.passages.set(member.hit.passage.id, {
            passageId: member.hit.passage.id, start: first.start, end: last.end,
          });
        }
      }
    }
  }
  const derived: Concept[] = [];
  for (const [term, entry] of candidates) {
    const parts = term.split(' ');
    const contentParts = parts.filter(part => !STOPWORDS.has(part));
    const df = index
      ? index.documentFrequency(term)
      : pool.filter(member => containsPhrase(member.tokens.map(token => token.term), parts)).length;
    const nDocs = index ? index.documentCount() : pool.length;
    const idf = Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
    let score = entry.tf * idf;
    if (used.has(term) || contentParts.every(part => used.has(part))) score *= USED_VOCAB_DISCOUNT;
    if (negativeTerms.size && contentParts.every(part => negativeTerms.has(part))) score *= NEGATIVE_PENALTY;
    if (!Number.isFinite(score)) continue;
    const containing = pool.filter(member => entry.passages.has(member.hit.passage.id));
    if (!containing.length) continue;
    let relevance = 0;
    for (const member of containing) relevance += member.overlap;
    derived.push({
      id: `concept:${branch.id}:${slug(term)}`,
      branchId: branch.id,
      term,
      score,
      anchorRelevance: relevance / containing.length,
      introducing: [...entry.passages.values()],
    });
  }
  derived.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return derived.slice(0, limit);
}

/**
 * Query expansion as a standalone anchor string plus at most three added
 * concepts: L1-normalized weights give the anchor 75% of total mass when an
 * expansion exists (100% otherwise), all weights are nonnegative, terms found
 * in negative passages are penalized, and keys never duplicate anchor terms.
 */
export function expandedQuery(
  anchor: string, candidates: Concept[], negativePassages?: Passage[],
): Record<string, number> {
  const anchorStream = keyTerms(anchor);
  if (!anchorStream.length) return {};
  const anchorTf = new Map<string, number>();
  for (const term of anchorStream) anchorTf.set(term, (anchorTf.get(term) ?? 0) + 1);
  let anchorTotal = 0;
  for (const weight of anchorTf.values()) anchorTotal += weight;
  const negative = new Set<string>();
  for (const passage of negativePassages ?? []) {
    for (const term of new Set(keyTerms(passage.text))) negative.add(term);
  }
  const additions = new Map<string, number>();
  for (const concept of candidates) {
    if (!concept || typeof concept.term !== 'string' || !Number.isFinite(concept.score) || concept.score <= 0) continue;
    const parts = keyTerms(concept.term);
    if (!parts.length) continue;
    if (parts.every(term => anchorTf.has(term))) continue;
    let score = concept.score;
    if (negative.size && parts.every(term => negative.has(term))) score *= NEGATIVE_PENALTY;
    if (score <= 0) continue;
    const key = parts.join(' ');
    const prior = additions.get(key);
    if (prior === undefined || score > prior) additions.set(key, score);
  }
  const top = [...additions.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_ADDITIONS);
  const out: Record<string, number> = {};
  const anchorScale = top.length ? ANCHOR_MASS : 1;
  for (const [term, weight] of anchorTf) out[term] = anchorScale * (weight / anchorTotal);
  if (top.length) {
    let sum = 0;
    for (const [, score] of top) sum += score;
    for (const [term, score] of top) out[term] = EXPANSION_MASS * (score / sum);
  }
  return out;
}

export interface RocchioOptions {
  alpha?: number;
  beta?: number;
  gamma?: number;
  maxTerms?: number;
}

/**
 * Classic Rocchio Relevance Feedback (Salton & Buckley, 1990; Manning et al. 2008):
 * q' = α * q_0 + β * (1/|D_rel|) * Σ d_rel - γ * (1/|D_irrel|) * Σ d_irrel
 *
 * Promotes discriminative vocabulary from user-judged useful evidence while penalizing
 * non-relevant noise (preventing topic drift). Negative weights are truncated to 0,
 * and top maxTerms expansion terms are merged with the anchor into an L1-normalized query.
 */
export function rocchioQuery(
  anchor: string | Record<string, number>,
  usefulPassages: Passage[],
  irrelevantPassages: Passage[],
  index?: PassageIndex,
  options?: RocchioOptions,
): Record<string, number> {
  const alpha = options?.alpha ?? 1.0;
  const beta = options?.beta ?? 0.75;
  const gamma = options?.gamma ?? 0.25;
  const maxTerms = options?.maxTerms ?? 5;

  const baseWeights = queryWeights(anchor);
  if (!baseWeights.size) return {};

  const baseTotal = [...baseWeights.values()].reduce((sum, w) => sum + w, 0);
  const q0 = new Map<string, number>();
  for (const [term, weight] of baseWeights) q0.set(term, weight / (baseTotal || 1));

  const passageVector = (p: Passage): Map<string, number> => {
    const stream = keyTerms(p.text);
    const tf = new Map<string, number>();
    for (const term of stream) tf.set(term, (tf.get(term) ?? 0) + 1);
    const vec = new Map<string, number>();
    let sq = 0;
    const n = index ? index.documentCount() : 10;
    for (const [term, freq] of tf) {
      const df = index ? index.documentFrequency(term) : 1;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const w = freq * idf;
      vec.set(term, w);
      sq += w * w;
    }
    const norm = Math.sqrt(sq) || 1;
    for (const [term, w] of vec) vec.set(term, w / norm);
    return vec;
  };

  const relSum = new Map<string, number>();
  if (usefulPassages.length > 0) {
    for (const p of usefulPassages) {
      const vec = passageVector(p);
      for (const [term, w] of vec) {
        relSum.set(term, (relSum.get(term) ?? 0) + w / usefulPassages.length);
      }
    }
  }

  const irrelSum = new Map<string, number>();
  if (irrelevantPassages.length > 0) {
    for (const p of irrelevantPassages) {
      const vec = passageVector(p);
      for (const [term, w] of vec) {
        irrelSum.set(term, (irrelSum.get(term) ?? 0) + w / irrelevantPassages.length);
      }
    }
  }

  const candidateScores = new Map<string, number>();
  const allTerms = new Set([...q0.keys(), ...relSum.keys(), ...irrelSum.keys()]);

  for (const term of allTerms) {
    const qVal = q0.get(term) ?? 0;
    const relVal = relSum.get(term) ?? 0;
    const irrelVal = irrelSum.get(term) ?? 0;
    const newWeight = alpha * qVal + beta * relVal - gamma * irrelVal;
    if (newWeight > 0) {
      candidateScores.set(term, newWeight);
    }
  }

  const expansionTerms: [string, number][] = [];
  for (const [term, score] of candidateScores) {
    if (!q0.has(term)) expansionTerms.push([term, score]);
  }
  expansionTerms.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const retainedExpansion = new Set(expansionTerms.slice(0, maxTerms).map(e => e[0]));

  const result: Record<string, number> = {};
  let totalScore = 0;
  for (const [term, score] of candidateScores) {
    if (q0.has(term) || retainedExpansion.has(term)) {
      result[term] = score;
      totalScore += score;
    }
  }

  if (totalScore > 0) {
    for (const term of Object.keys(result)) {
      result[term] = result[term]! / totalScore;
    }
  }
  return result;
}

export interface PassageCluster {
  id: string;
  label: string;
  centroidTerms: string[];
  passageIds: string[];
}

/**
 * Spherical k-means clustering over passage TF-IDF vectors (Manning et al., 2008).
 * Labels each cluster with its top centroid terms to surface data-driven research facets.
 */
export function clusterPassages(
  passages: Passage[],
  k?: number,
  maxIterations = 20,
): PassageCluster[] {
  if (!passages.length) return [];
  const uniquePassages = [...new Map(passages.map(p => [p.id, p])).values()];
  if (uniquePassages.length === 1) {
    const stream = keyTerms(uniquePassages[0]!.text);
    const topTerms = [...new Set(stream)].slice(0, 3);
    return [{
      id: 'cluster-1',
      label: topTerms.join(' | ') || 'general',
      centroidTerms: topTerms,
      passageIds: [uniquePassages[0]!.id],
    }];
  }

  const numClusters = Math.min(
    uniquePassages.length,
    Math.max(2, k ?? Math.min(6, Math.round(Math.sqrt(uniquePassages.length)))),
  );

  const corpusDf = new Map<string, number>();
  const passageTokens = uniquePassages.map(p => keyTerms(p.text));
  for (const stream of passageTokens) {
    for (const term of new Set(stream)) {
      corpusDf.set(term, (corpusDf.get(term) ?? 0) + 1);
    }
  }

  const n = uniquePassages.length;
  const vectors: Map<string, number>[] = passageTokens.map(stream => {
    const tf = new Map<string, number>();
    for (const t of stream) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    let sq = 0;
    for (const [t, count] of tf) {
      const df = corpusDf.get(t) ?? 1;
      const weight = count * Math.log(1 + (n - df + 0.5) / (df + 0.5));
      vec.set(t, weight);
      sq += weight * weight;
    }
    const norm = Math.sqrt(sq) || 1;
    for (const [t, w] of vec) vec.set(t, w / norm);
    return vec;
  });

  const centroids: Map<string, number>[] = [];
  centroids.push(new Map(vectors[0]!));

  while (centroids.length < numClusters) {
    let bestIdx = -1;
    let maxDist = -1;
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]!;
      let minSim = 1.0;
      for (const c of centroids) {
        const sim = cosine(v, c);
        if (sim < minSim) minSim = sim;
      }
      const dist = 1 - minSim;
      if (dist > maxDist) {
        maxDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) centroids.push(new Map(vectors[bestIdx]!));
    else centroids.push(new Map(vectors[centroids.length]!));
  }

  let assignments = new Array<number>(uniquePassages.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]!;
      let bestSim = -1;
      let bestCluster = 0;
      for (let c = 0; c < numClusters; c++) {
        const sim = cosine(v, centroids[c]!);
        if (sim > bestSim) {
          bestSim = sim;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }
    if (!changed && iter > 0) break;

    for (let c = 0; c < numClusters; c++) {
      const memberIndices = assignments.map((a, idx) => a === c ? idx : -1).filter(idx => idx >= 0);
      if (!memberIndices.length) continue;
      const sumVec = new Map<string, number>();
      for (const idx of memberIndices) {
        for (const [t, w] of vectors[idx]!) {
          sumVec.set(t, (sumVec.get(t) ?? 0) + w);
        }
      }
      let sq = 0;
      for (const w of sumVec.values()) sq += w * w;
      const norm = Math.sqrt(sq) || 1;
      const newCentroid = new Map<string, number>();
      for (const [t, w] of sumVec) newCentroid.set(t, w / norm);
      centroids[c] = newCentroid;
    }
  }

  const clusters: PassageCluster[] = [];
  for (let c = 0; c < numClusters; c++) {
    const memberPassages = uniquePassages.filter((_, idx) => assignments[idx] === c);
    if (!memberPassages.length) continue;
    const sortedTerms = [...centroids[c]!.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(entry => entry[0]);
    const topTerms = sortedTerms.slice(0, 3);
    const label = topTerms.join(' | ') || `facet-${c + 1}`;
    clusters.push({
      id: `cluster-${c + 1}`,
      label,
      centroidTerms: topTerms,
      passageIds: memberPassages.map(p => p.id),
    });
  }
  return clusters;
}

export interface CandidatePrediction {
  label: 'on-topic' | 'off-topic';
  score: number;
  confidence: number;
}

/**
 * Multinomial Naive Bayes text classifier with Laplace add-1 smoothing.
 * Filters out off-topic candidate search results prior to HTTP fetch and LLM evaluation,
 * directly protecting fetch budgets and model call allowances.
 */
export class NaiveBayesCandidateClassifier {
  private onTopicTermCounts = new Map<string, number>();
  private offTopicTermCounts = new Map<string, number>();
  private totalOnTopicTerms = 0;
  private totalOffTopicTerms = 0;
  private numOnTopicDocs = 0;
  private numOffTopicDocs = 0;
  private vocab = new Set<string>();

  train(documents: { text: string; label: 'on-topic' | 'off-topic' }[]): void {
    for (const doc of documents) {
      const words = keyTerms(doc.text);
      if (doc.label === 'on-topic') {
        this.numOnTopicDocs++;
        for (const w of words) {
          this.vocab.add(w);
          this.onTopicTermCounts.set(w, (this.onTopicTermCounts.get(w) ?? 0) + 1);
          this.totalOnTopicTerms++;
        }
      } else {
        this.numOffTopicDocs++;
        for (const w of words) {
          this.vocab.add(w);
          this.offTopicTermCounts.set(w, (this.offTopicTermCounts.get(w) ?? 0) + 1);
          this.totalOffTopicTerms++;
        }
      }
    }
  }

  predict(text: string): CandidatePrediction {
    const words = keyTerms(text);
    if (!words.length || this.numOnTopicDocs === 0 || this.numOffTopicDocs === 0) {
      return { label: 'on-topic', score: 0.5, confidence: 0 };
    }

    const V = Math.max(this.vocab.size, 1);
    const totalDocs = Math.max(1, this.numOnTopicDocs + this.numOffTopicDocs);
    const priorOn = Math.log(Math.max(1, this.numOnTopicDocs) / (totalDocs + 1));
    const priorOff = Math.log(Math.max(1, this.numOffTopicDocs) / (totalDocs + 1));

    let logProbOn = priorOn;
    let logProbOff = priorOff;

    for (const w of words) {
      const countOn = this.onTopicTermCounts.get(w) ?? 0;
      const countOff = this.offTopicTermCounts.get(w) ?? 0;
      logProbOn += Math.log((countOn + 1) / (this.totalOnTopicTerms + V));
      logProbOff += Math.log((countOff + 1) / (this.totalOffTopicTerms + V));
    }

    const maxLog = Math.max(logProbOn, logProbOff);
    const expOn = Math.exp(logProbOn - maxLog);
    const expOff = Math.exp(logProbOff - maxLog);
    const probOn = expOn / (expOn + expOff);

    return {
      label: probOn >= 0.5 ? 'on-topic' : 'off-topic',
      score: probOn,
      confidence: Math.abs(probOn - 0.5) * 2,
    };
  }
}
