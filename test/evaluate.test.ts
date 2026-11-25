/**
 * Offline regression for scripts/evaluate.ts (imported without its CLI). Fixtures are
 * synthetic hand-built records: no human-benchmark judgments, generated results or live calls.
 * Run: ./node_modules/.bin/tsx test/evaluate.test.ts   (exit 1 on any failed check)
 */
import assert from 'node:assert/strict';
import { PassageIndex } from '../src/core-ir.js';
import { METHODS, evaluate, metrics, pairedTTest, parseDataset, sweepBM25 } from '../scripts/evaluate.js';
import type { Passage } from '../src/types.js';

const failures: string[] = [];
const check = (label: string, run: () => void): void => {
  try { run(); console.log(`ok   ${label}`); }
  catch (error) {
    failures.push(label);
    console.log(`FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`);
  }
};
const close = (actual: number, expected: number, label: string): void =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !~ ${expected}`);
const P = (id: string, snapshotId: string, text: string): Passage =>
  ({ id, snapshotId, start: 0, end: text.length, text, duplicateGroup: id });
const Q = (id: string, text: string, judgments: Record<string, number>) => ({ id, text, judgments });

// n1/n2 are near variants the shared index groups; n3 is unrelated. q2 has empty qrels.
const near = () => ({
  passages: [
    P('n1', 's1', 'neural retrieval baseline improves recall on domain corpora'),
    P('n2', 's2', 'neural retrieval baseline improves recall on domain corpora today'),
    P('n3', 's3', 'unrelated cooking recipe with basil and tomatoes'),
  ],
  queries: [Q('q1', 'neural retrieval baseline', { n1: 1, n2: 3 }), Q('q2', 'neural retrieval baseline', {})],
});
const alias = () => ({
  passages: [
    P('a1', 's1', 'identical body text for both records'),
    P('a2', 's2', 'identical body text for both records'),
  ],
  queries: [Q('q1', 'identical body', { a1: 0, a2: 3 })],
});

check('fixed-denominator metrics, exponential nDCG, pooled recall, zero-positive macro', () => {
  const index = new PassageIndex();
  index.add(parseDataset(near()).passages);
  const hits = index.rank('neural retrieval baseline', 10);
  assert.deepEqual(hits.map(hit => hit.passage.id), ['n1', 'n2'], 'fixture rank order');
  assert.equal(hits[0]!.passage.duplicateGroup, 'n1', 'derived group root');
  assert.equal(hits[1]!.passage.duplicateGroup, 'n1', 'derived group member');
  const judged = metrics(hits, { n1: 1, n2: 3 });
  close(judged.p5, 2 / 5, 'P@5 fixed denominator');
  close(judged.p10, 2 / 10, 'P@10 fixed denominator');
  close(judged.ndcg10, (1 + 7 / Math.log2(3)) / (7 + 1 / Math.log2(3)), 'exponential graded nDCG');
  close(judged.pooledRecall10, 1, 'pooled recall over the two judged positives');
  close(judged.redundancy10, 0.5, 'group redundancy');
  const zero = metrics(hits, { n1: 0 });
  close(zero.ndcg10, 0, 'zero positives: nDCG');
  close(zero.pooledRecall10, 0, 'zero positives: pooled recall');
  const scored = evaluate(parseDataset(near()));
  assert.equal(scored.perQuery[1]!.judgedPositive, 0, 'empty qrels have no positives');
  assert.equal(scored.corpus.zeroPositiveQrelQueries, 1, 'empty qrels are counter-visible');
  close(scored.macro.bm25.p5, scored.perQuery[0]!.metrics.bm25.p5 / 2, 'macro averages the zero-positive query');
  close(scored.macro.bm25.ndcg10, scored.perQuery[0]!.metrics.bm25.ndcg10 / 2, 'zero-positive query adds 0');
  assert.deepEqual(Object.keys(scored.macro), [...METHODS]);
});

check('schema rejects malformed datasets', () => {
  const base = near();
  const mutate = (edit: (value: any) => void): unknown => {
    const value: any = structuredClone(base);
    edit(value);
    return value;
  };
  const rejects: [string, unknown, RegExp][] = [
    ['non-object', 42, /must be a JSON object/],
    ['missing arrays', { passages: [] }, /requires passages\[\] and queries\[\]/],
    ['empty arrays', { passages: [], queries: [] }, /must be non-empty/],
    ['duplicate passage id', mutate(v => { v.passages[1]!.id = 'n1'; }), /repeats passage id/],
    ['bad offsets', mutate(v => { v.passages[0]!.end += 1; }), /safe-integer UTF-16 offsets/],
    ['blank passage', mutate(v => { v.passages[0]!.text = ' '; }), /non-blank text/],
    ['duplicate query id', mutate(v => { v.queries[1]!.id = 'q1'; }), /repeats query id/],
    ['blank query', mutate(v => { v.queries[0]!.text = ''; }), /non-blank text/],
    ['non-object judgments', mutate(v => { v.queries[0]!.judgments = null; }), /requires judgments/],
    ['fractional grade', mutate(v => { v.queries[0]!.judgments.n1 = 1.5; }), /integer 0\.\.3/],
    ['out-of-range grade', mutate(v => { v.queries[0]!.judgments.n1 = 4; }), /integer 0\.\.3/],
    ['unknown passage', mutate(v => { v.queries[0]!.judgments.n9 = 1; }), /not in the corpus/],
    ['blank duplicateGroup', mutate(v => { v.passages[0]!.duplicateGroup = '  '; }),
      /duplicateGroup must be a non-blank string/],
  ];
  for (const [label, value, pattern] of rejects) assert.throws(() => parseDataset(value), pattern, label);
});

check('exact-text aliases are refused before scoring, never folded', () => {
  const parsed = parseDataset(alias());
  assert.equal(parsed.passages.length, 2, 'both alias records parse');
  const probe = new PassageIndex();
  probe.add(parsed.passages);
  assert.equal(probe.stats.aliases, 1, 'fixture really produces an exact-text alias');
  // a2 carries grade 3 while its canonical a1 carries 0: folding would rewrite the judgment.
  assert.throws(() => evaluate(parsed), /exact-text alias/, 'alias refusal');
  assert.throws(() => evaluate(parsed), /never folded or guessed/, 'judgments are not regraded');
  assert.equal(evaluate(parseDataset(near())).corpus.index.aliases, 0, 'near variants are not aliases');
});

check('near variants stay distinct and MMR keeps one group representative', () => {
  const result = evaluate(parseDataset(near()));
  assert.equal(result.corpus.index.passages, 3, 'all three records stay in the corpus');
  assert.equal(result.perQuery[0]!.judgedPositive, 2, 'each near variant keeps its own grade');
  const bm25 = result.perQuery[0]!.rankings.bm25;
  assert.ok(bm25.includes('n1') && bm25.includes('n2'), 'both near variants rank');
  close(result.perQuery[0]!.metrics.bm25.redundancy10, 0.5, 'group-derived redundancy');
  const chosen = result.perQuery[0]!.rankings.prfMMR.filter(id => id === 'n1' || id === 'n2');
  assert.equal(chosen.length, 1, 'MMR keeps exactly one near-variant representative');
});

check('rankings are invariant under different qrels', () => {
  const other = near();
  other.queries[0] = Q('q1', 'neural retrieval baseline', { n2: 3, n3: 2 });
  const left = evaluate(parseDataset(near()));
  const right = evaluate(parseDataset(other));
  assert.deepEqual(left.perQuery[0]!.rankings, right.perQuery[0]!.rankings, 'rankings ignore grades');
  assert.notEqual(left.perQuery[0]!.metrics.bm25.ndcg10, right.perQuery[0]!.metrics.bm25.ndcg10,
    'grades still change scoring');
});

check('empty qrels and hostile qrel keys are preserved and scored', () => {
  const hostile: any = JSON.parse(JSON.stringify(near()));
  hostile.passages.push(P('__proto__', 's4', 'neural retrieval baseline extra'));
  hostile.passages.push(P('constructor', 's5', 'neural retrieval baseline helper'));
  hostile.queries[0].judgments = JSON.parse('{"__proto__": 3, "constructor": 2}');
  const parsed = parseDataset(hostile);
  assert.equal(Object.keys(parsed.queries[1]!.judgments).length, 0, 'empty qrels parse');
  const judgments = parsed.queries[0]!.judgments;
  assert.equal(Object.getOwnPropertyDescriptor(judgments, '__proto__')?.value, 3, 'own __proto__ grade kept');
  assert.equal(Object.getOwnPropertyDescriptor(judgments, 'constructor')?.value, 2, 'constructor grade kept');
  assert.equal(Object.values(judgments).filter(grade => grade > 0).length, 2, 'both special grades count');
  const scored = evaluate(parsed);
  assert.equal(scored.perQuery[0]!.judgedPositive, 2, 'evaluate counts both special grades');
  close(scored.perQuery[1]!.metrics.bm25.p10, 0, 'empty qrels score zero');
  close(scored.perQuery[1]!.metrics.bm25.pooledRecall10, 0, 'empty qrels pooled recall is zero');
  assert.equal(scored.corpus.zeroPositiveQrelQueries, 1, 'empty qrels counted');
  const bare = new PassageIndex();
  bare.add(parsed.passages);
  const specialHits = bare.rank('neural retrieval baseline', 10).filter(hit => hit.passage.id === '__proto__' || hit.passage.id === 'constructor');
  assert.equal(specialHits.length, 2, 'both special-id hits rank');
  const ungraded = metrics(specialHits, { [parsed.passages[0]!.id]: 1 });
  assert.ok([ungraded.p5, ungraded.p10, ungraded.ndcg10, ungraded.pooledRecall10].every(value => value === 0) && Number.isFinite(ungraded.redundancy10), 'unjudged inherited-name IDs score finite zero even with a positive ideal DCG');
});

check('MAP, R-Precision, BPref, and 11-point PR curve calculation', () => {
  const index = new PassageIndex();
  const ds = parseDataset(near());
  index.add(ds.passages);
  const hits = index.rank('neural retrieval baseline', 10);
  // hits[0] is n1, hits[1] is n2. Judgments: { n1: 1, n2: 3, n3: 0 }. Positives = 2, Negatives = 1.
  const m = metrics(hits, { n1: 1, n2: 3, n3: 0 });
  // At rank 1 (n1): P@1 = 1/1 = 1. At rank 2 (n2): P@2 = 2/2 = 1. MAP = (1 + 1)/2 = 1.0.
  close(m.map, 1.0, 'MAP for perfect top-2 ranking');
  // R = 2. In top 2, both are relevant. R-Prec = 2/2 = 1.0.
  close(m.rPrec, 1.0, 'R-Precision for perfect top-2 ranking');
  // BPref: n1 has 0 non-relevant above it. n2 has 0 non-relevant above it. bpref = (1 + 1)/2 = 1.0.
  close(m.bpref, 1.0, 'BPref with no non-relevant documents preceding relevant');
  // 11-point interpolated precision:
  assert.equal(m.interpolatedPR.length, 11, '11 points on PR curve');
  assert.equal(m.interpolatedPR[0], 1.0, 'P@recall 0.0 is 1.0');
  assert.equal(m.interpolatedPR[10], 1.0, 'P@recall 1.0 is 1.0');
});

check('paired t-test calculates t-statistic and significance', () => {
  // Method A strictly higher than Method B
  const sampleA = [0.45, 0.50, 0.48, 0.52, 0.49, 0.55];
  const sampleB = [0.35, 0.38, 0.36, 0.40, 0.37, 0.41];
  const test = pairedTTest(sampleA, sampleB, 'methodA', 'methodB', 'ndcg10');
  assert.equal(test.n, 6);
  assert.ok(test.meanDiff > 0, 'mean difference is positive');
  assert.ok(test.tStatistic > 5, 't-statistic is strongly positive');
  assert.ok(test.pValue < 0.001, 'p-value is highly significant');
  assert.equal(test.significantAt05, true);
  assert.equal(test.significantAt01, true);

  // Equal samples
  const equalTest = pairedTTest(sampleA, sampleA, 'methodA', 'methodA', 'ndcg10');
  assert.equal(equalTest.meanDiff, 0);
  assert.equal(equalTest.pValue, 1.0);
  assert.equal(equalTest.significantAt05, false);
});

check('BM25 parameter sweep evaluates grid combinations', () => {
  const ds = parseDataset(near());
  const gridResults = sweepBM25(ds, { k1: [1.2], b: [0.75] });
  assert.equal(gridResults.length, 1);
  assert.equal(gridResults[0]!.k1, 1.2);
  assert.equal(gridResults[0]!.b, 0.75);
  assert.ok(gridResults[0]!.ndcg10 > 0, 'nDCG@10 is computed');
  assert.ok(gridResults[0]!.map > 0, 'MAP is computed');
});

console.log(failures.length ? `\n${failures.length} case(s) failed: ${failures.join('; ')}` : '\nall cases passed');
if (failures.length) process.exitCode = 1;
