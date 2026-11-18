/**
 * Offline regression for the public src/core-ir.ts surface: distinct-document
 * DF under high TF, weighted-map mass and score scaling, surface phrase
 * adjacency, incremental/rebuilt equivalence, duplicate-group MMR selection
 * with retained index variants, corpus-basis vs pool-basis MMR fallback
 * without input mutation, and bounded paragraph segmentation with exact spans.
 *
 * Run: ./node_modules/.bin/tsx test/core-ir.test.ts   (exit 1 on any failed check)
 */
import assert from 'node:assert/strict';
import { PassageIndex, expandedQuery, mmr, segment, tokenize } from '../src/core-ir.js';
import type { Concept, Passage, SearchHit, Snapshot } from '../src/types.js';

const failures: string[] = [];
const check = (label: string, run: () => void): void => {
  try { run(); console.log(`ok   ${label}`); }
  catch (error) {
    failures.push(label);
    console.log(`FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`);
  }
};

const P = (id: string, snapshotId: string, text: string): Passage =>
  ({ id, snapshotId, start: 0, end: text.length, text, duplicateGroup: id });

const S = (text: string, pages?: Snapshot['pages']): Snapshot => ({
  id: 'seg', requestedUrl: 'https://example.org/a', finalUrl: 'https://example.org/a',
  canonicalUrl: 'https://example.org/a', fetchedAt: '2024-01-01T00:00:00.000Z',
  contentHash: 'content', textHash: 'text', rawBlob: 'raw', textBlob: 'text-blob',
  mime: 'text/html', status: 200, title: 'Example', extraction: 'readability', extractionVersion: '1',
  text, ...(pages ? { pages } : {}),
});

/** One unbroken prose paragraph of the reported live shape (~11.9k chars, ~1.1k tokens). */
function giantParagraph(chars = 11962): string {
  const words: string[] = [];
  for (let i = 0; words.join(' ').length < chars; i++) words.push(i % 37 === 0 ? 'attribution.' : `feature${i}`);
  const cut = words.join(' ').slice(0, chars);
  const last = cut.lastIndexOf(' ');
  return cut.slice(0, last > 0 ? last : cut.length);
}

/** Asserts span truthfulness, ordering and whitespace-only separation; returns token counts. */
function assertSpans(snapshot: Snapshot, passages: Passage[]): number[] {
  let cursor = 0;
  const counts: number[] = [];
  for (const passage of passages) {
    assert.equal(passage.snapshotId, snapshot.id);
    assert.equal(passage.id, `${snapshot.id}:${passage.start}`, 'passage id is the source start offset');
    assert.equal(passage.end - passage.start, passage.text.length, `${passage.id} span matches text length`);
    assert.equal(snapshot.text.slice(passage.start, passage.end), passage.text, `${passage.id} is an exact slice`);
    assert.ok(passage.start >= cursor, `${passage.id} starts after the previous passage`);
    assert.ok(/^\s*$/.test(snapshot.text.slice(cursor, passage.start)), `${passage.id} leaves only whitespace before it`);
    cursor = passage.end;
    counts.push(tokenize(passage.text).length);
  }
  assert.ok(/^\s*$/.test(snapshot.text.slice(cursor)), 'the remainder after the last passage is whitespace only');
  return counts;
}

const close = (actual: number, expected: number, label: string): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !~ ${expected}`);
const termOf = (hit: SearchHit, term: string) => hit.terms.find(entry => entry.term === term)!;

check('high TF still yields distinct-document DF', () => {
  const index = new PassageIndex();
  index.add([P('d1', 's1', 'alpha alpha alpha alpha beta'), P('d2', 's2', 'alpha beta beta gamma')]);
  assert.equal(index.documentFrequency('alpha'), 2);
  const hits = index.rank('alpha', 10);
  assert.deepEqual(hits.map(hit => hit.passage.id), ['d1', 'd2']);
  const high = termOf(hits[0]!, 'alpha');
  const low = termOf(hits[1]!, 'alpha');
  assert.equal(high.tf, 4);
  assert.equal(high.df, 2);
  assert.equal(low.tf, 1);
  assert.equal(low.df, 2);
  assert.ok(high.contribution > low.contribution, 'higher TF still scores higher at equal DF');
});

check('weight-map queries keep anchor mass and scale BM25 score', () => {
  const index = new PassageIndex();
  index.add([P('m1', 's1', 'training serving pipelines improve serving latency today')]);
  const asString = index.rank('training serving');
  const half = index.rank({ training: 0.5, serving: 0.5 });
  close(half[0]!.score, asString[0]!.score / 2, 'halved weights halve the weighted score');
  const concept: Concept = { id: 'c1', branchId: 'b1', term: 'serving skew', score: 2, anchorRelevance: 0.5, introducing: [] };
  const map = expandedQuery('training serving', [concept]);
  close(Object.values(map).reduce((sum, weight) => sum + weight, 0), 1, 'map mass is L1-normalized');
  close((map['training'] ?? 0) + (map['serving'] ?? 0), 0.75, 'anchor keeps 75% of the mass');
  close(map['serving skew']!, 0.25, 'single expansion keeps 25% of the mass');
  const expanded = index.rank(map);
  assert.equal(expanded[0]!.passage.id, 'm1');
  close(termOf(expanded[0]!, 'training').weight, 0.375, 'anchor token weight');
  close(termOf(expanded[0]!, 'serving').weight, 0.5, 'anchor plus distributed phrase key');
  close(termOf(expanded[0]!, 'skew').weight, 0.125, 'multiword key splits evenly');
  close(expanded[0]!.terms.reduce((sum, entry) => sum + entry.weight, 0), 1, 'rank preserves total map mass');
});

check('surface phrases need adjacency; a stopword gap is only proximity', () => {
  const gap = P('p1', 's1', 'training can serving skew appears in production systems today');
  const exact = P('p2', 's2', 'training serving skew appears in production systems');
  const index = new PassageIndex();
  index.add([gap, exact]);
  assert.equal(index.documentFrequency('training serving'), 1, 'gap passage is not a phrase document');
  assert.equal(index.documentFrequency('training can serving'), 1, 'surface phrase with the function word matches');
  const hits = index.rank('skew', 10, ['training serving']);
  const byId = new Map(hits.map(hit => [hit.passage.id, hit]));
  close(byId.get('p1')!.phraseBonus, 0.10, 'bounded proximity bonus for the gap passage');
  close(byId.get('p2')!.phraseBonus, 0.25, 'exact adjacency bonus');
});

check('incremental intake is equivalent to a full rebuild', () => {
  const corpus = [
    P('r1', 's1', 'alpha beta gamma delta epsilon'),
    P('r2', 's1', 'beta gamma delta alpha zeta'),
    P('r3', 's2', 'gamma delta epsilon alpha eta'),
  ];
  const incremental = new PassageIndex();
  incremental.add([corpus[0]!]);
  incremental.add([corpus[1]!, corpus[2]!]);
  const rebuilt = new PassageIndex();
  rebuilt.add(corpus);
  assert.deepEqual(incremental.stats, rebuilt.stats);
  assert.equal(incremental.stats.revision, 2, 'revision counts distinct snapshots');
  assert.deepEqual(incremental.all(), rebuilt.all());
  const query = { alpha: 1, gamma: 0.5 };
  assert.deepEqual(
    incremental.rank(query).map(hit => [hit.passage.id, hit.score, hit.phraseBonus, hit.length]),
    rebuilt.rank(query).map(hit => [hit.passage.id, hit.score, hit.phraseBonus, hit.length]),
  );
});

check('mmr picks one hit per duplicate group even at lambda 1; index keeps variants', () => {
  const index = new PassageIndex();
  index.add([
    P('v1', 's1', 'gamma delta alpha variant text one'),
    P('v1b', 's1', 'gamma delta alpha variant text one'),
    P('v2', 's2', 'gamma alpha different content words here'),
  ]);
  assert.equal(index.stats.passages, 3);
  assert.equal(index.stats.aliases, 1);
  assert.equal(index.documentFrequency('variant'), 1, 'alias does not raise df');
  assert.deepEqual(index.all().map(passage => passage.id), ['v1', 'v1b', 'v2']);
  assert.equal(index.rank('alpha', 10).filter(hit => hit.passage.duplicateGroup === 'v1').length, 1, 'postings rank the group once');
  const hit = (id: string, group: string, score: number, text: string): SearchHit => ({
    passage: { ...P(id, `s-${id}`, text), duplicateGroup: group },
    score, terms: [], phraseBonus: 0, length: 3, averageLength: 3,
  });
  const manual = [
    hit('g1', 'grp', 1, 'shared words alpha'),
    hit('g2', 'grp', 0.9, 'shared words alpha'),
    hit('g3', 'other', 0.8, 'different words beta'),
  ];
  assert.equal(mmr(manual, 3).length, 2, 'default lambda also keeps groups distinct');
  assert.deepEqual(mmr(manual, 3, 1).map(entry => entry.passage.id), ['g1', 'g3'], 'group member skipped without diversity pressure');
});

check('mmr prefers corpus vectors for fresh hits, pool vectors for copies, without mutation', () => {
  const index = new PassageIndex();
  const corpus: Passage[] = [
    P('h1', 's1', 'common common common alpha1 beta1 gamma1 delta1'),
    P('h2', 's2', 'common common common alpha2 beta2 gamma2 delta2'),
  ];
  for (let i = 0; i < 18; i++) corpus.push(P(`f${i}`, `sf${i}`, `common f${i}a f${i}b f${i}c f${i}d f${i}e f${i}f`));
  index.add(corpus);
  const ranked = index.rank('common', 2);
  assert.deepEqual(ranked.map(hit => hit.passage.id), ['h1', 'h2']);
  const rankedBefore = JSON.stringify(ranked);
  const full = mmr(ranked, 2);
  assert.equal(JSON.stringify(ranked), rankedBefore, 'fresh hits are not mutated');
  const copies = structuredClone(ranked);
  const copiesBefore = JSON.stringify(copies);
  const pooled = mmr(copies, 2);
  assert.equal(JSON.stringify(copies), copiesBefore, 'copied hits are not mutated');
  assert.ok(Math.abs(full[1]!.mmr! - pooled[1]!.mmr!) > 1e-4, `corpus and pool bases must differ: ${full[1]!.mmr} vs ${pooled[1]!.mmr}`);
  const again = mmr(full, 2);
  assert.deepEqual(again.map(entry => entry.passage.id), full.map(entry => entry.passage.id), 'transferred basis keeps selection');
  close(again[1]!.mmr!, full[1]!.mmr!, 'transferred basis reproduces the value');
});

check('an oversized unbroken paragraph splits into bounded 180-300 token passages', () => {
  const paragraph = giantParagraph();
  assert.ok(tokenize(paragraph).length > 1000, `fixture reproduces the live shape: ${tokenize(paragraph).length} tokens`);
  const text = `Feature attributions\n\n${paragraph}`;
  const snapshot = S(text, [{ page: 1, start: 0, end: 30 }, { page: 2, start: 30, end: text.length }]);
  const passages = segment(snapshot);
  assert.ok(passages.length >= 4, `expected a split, got ${passages.length} passage(s) of ${passages.map(p => p.text.length)} chars`);
  const counts = assertSpans(snapshot, passages);
  for (let i = 0; i < passages.length; i++) {
    const passage = passages[i]!;
    assert.ok(counts[i]! >= 180 && counts[i]! <= 300, `${passage.id} has ${counts[i]} tokens`);
    assert.ok(passage.text.length <= 4000, `${passage.id} has ${passage.text.length} chars`);
    assert.ok(passage.text.length < text.length, `${passage.id} is not the whole page`);
    assert.equal(passage.section, 'Feature attributions', `${passage.id} keeps its section`);
    assert.equal(passage.page, passage.start < 30 ? 1 : 2, `${passage.id} keeps its page`);
  }
  for (const passage of passages.slice(0, -1)) {
    assert.ok(passage.text.endsWith('.'), `${passage.id} breaks at a sentence: ${JSON.stringify(passage.text.slice(-24))}`);
  }
  assert.deepEqual(
    segment(snapshot).map(passage => [passage.id, passage.start, passage.end, passage.text]),
    passages.map(passage => [passage.id, passage.start, passage.end, passage.text]),
    'segmentation is deterministic in ids, order and spans',
  );
});

check('a pathological single token is bounded by the passage text cap', () => {
  const text = 'x'.repeat(12000);
  const snapshot = S(text);
  const passages = segment(snapshot);
  assert.ok(passages.length >= 3, `expected the run to split, got ${passages.length} passage(s)`);
  assertSpans(snapshot, passages);
  for (const passage of passages) {
    assert.ok(passage.text.length <= 4000, `${passage.id} has ${passage.text.length} chars`);
    assert.ok(passage.end <= text.length, `${passage.id} stays inside the source`);
  }
});

check('ordinary paragraph packing keeps its existing offsets', () => {
  const para = (name: string): string => `${Array.from({ length: 90 }, (_, i) => `${name}w${i}`).join(' ')}.`;
  const text = ['# Title', para('alpha'), para('beta'), para('gamma'), para('delta')].join('\n\n');
  const snapshot = S(text);
  const passages = segment(snapshot);
  assert.deepEqual(passages.map(passage => [passage.start, passage.end]), [[0, 2323], [2325, 3125]],
    'paragraph-packed spans are unchanged for pages that were never over the caps');
  assert.deepEqual(assertSpans(snapshot, passages), [271, 90]);
});

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
