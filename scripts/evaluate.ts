/**
 * Frozen-corpus retrieval ablation over one shared index.
 *
 * Compares three retrieval methods on the same human-judged passage pool:
 * BM25 with the query, anchored lexical pseudo-relevance feedback, and PRF
 * followed by MMR@10 diversification. Reporting is retrieval-only:
 * unjudged passages count as zero, `pooledRecall10` is recall relative to the
 * judged pool (never recall over the web), the heuristic PRF is not the live
 * contextual model assessment, and nothing here evaluates research policy,
 * allocation, conversation or report quality.
 *
 * Dataset (JSON), matching src/types.ts Passage:
 *   { passages: Passage[], queries: [{ id, text, judgments: { passageId: 0|1|2|3 } }] }
 * Exact-text aliases are rejected, not folded: deduplicate them and re-verify
 * the human judgments for the retained IDs. Near variants stay distinct.
 *
 * CLI: tsx scripts/evaluate.ts <judged-dataset.json>
 * Prints the evaluation JSON to stdout; any error goes to stderr with exit 1.
 * Judgments are human input only; this tool fabricates no results.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassageIndex, concepts, expandedQuery, mmr } from '../src/core-ir.js';
import type { Branch, Passage, SearchHit } from '../src/types.js';

export type Grade = 0 | 1 | 2 | 3;
export interface JudgedQuery { id: string; text: string; judgments: Record<string, Grade>; }
export interface Dataset { passages: Passage[]; queries: JudgedQuery[]; }
export interface Metrics {
  p5: number;
  p10: number;
  ndcg10: number;
  pooledRecall10: number;
  redundancy10: number;
  map: number;
  rPrec: number;
  bpref: number;
  interpolatedPR: number[];
}
export type Method = 'bm25' | 'bm25stem' | 'ql' | 'sdm' | 'lexicalPRF' | 'prfMMR';
export const METHODS: readonly Method[] = ['bm25', 'bm25stem', 'ql', 'sdm', 'lexicalPRF', 'prfMMR'];

function fail(message: string): never { throw new Error(message); }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate a judged dataset without inventing, folding or regrading any judgment. */
export function parseDataset(value: unknown): Dataset {
  if (!isRecord(value)) fail('Dataset must be a JSON object');
  const { passages, queries } = value;
  if (!Array.isArray(passages) || !Array.isArray(queries)) fail('Dataset requires passages[] and queries[]');
  if (!passages.length || !queries.length) fail('Dataset passages[] and queries[] must be non-empty');
  const passageIds = new Set<string>();
  const parsedPassages = passages.map((raw, at): Passage => {
    if (!isRecord(raw)) fail(`passages[${at}] must be an object`);
    const { id, snapshotId, text, start, end, duplicateGroup } = raw;
    if (typeof id !== 'string' || !id.trim()) fail(`passages[${at}].id must be a non-blank string`);
    if (passageIds.has(id)) fail(`passages[${at}] repeats passage id ${JSON.stringify(id)}`);
    if (typeof snapshotId !== 'string' || !snapshotId.trim()) fail(`passage ${id} requires a non-blank snapshotId`);
    if (typeof text !== 'string' || !text.trim()) fail(`passage ${id} requires non-blank text`);
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) || start < 0 || end <= start || end - start !== text.length) {
      fail(`passage ${id} requires safe-integer UTF-16 offsets with end - start === text.length`);
    }
    if (duplicateGroup !== undefined && (typeof duplicateGroup !== 'string' || !duplicateGroup.trim())) {
      fail(`passage ${id} duplicateGroup must be a non-blank string when present`);
    }
    passageIds.add(id);
    // duplicateGroup is derived by the shared index; an input value is only schema-checked.
    return { id, snapshotId, start, end, text, duplicateGroup: duplicateGroup ?? id };
  });
  const queryIds = new Set<string>();
  const parsedQueries = queries.map((raw, at): JudgedQuery => {
    if (!isRecord(raw)) fail(`queries[${at}] must be an object`);
    const { id, text, judgments } = raw;
    if (typeof id !== 'string' || !id.trim()) fail(`queries[${at}].id must be a non-blank string`);
    if (queryIds.has(id)) fail(`queries[${at}] repeats query id ${JSON.stringify(id)}`);
    if (typeof text !== 'string' || !text.trim()) fail(`query ${id} requires non-blank text`);
    if (!isRecord(judgments)) fail(`query ${id} requires judgments as { passageId: 0|1|2|3 }`);
    const grades: Record<string, Grade> = Object.create(null);
    for (const [passageId, grade] of Object.entries(judgments)) {
      if (!passageIds.has(passageId)) fail(`query ${id} grades passage ${passageId}, which is not in the corpus`);
      if (typeof grade !== 'number' || !Number.isInteger(grade) || grade < 0 || grade > 3) {
        fail(`query ${id} grade for passage ${passageId} must be an integer 0..3`);
      }
      grades[passageId] = grade as Grade;
    }
    queryIds.add(id);
    return { id, text, judgments: grades };
  });
  return { passages: parsedPassages, queries: parsedQueries };
}

/** Per-query metrics for one ranking. P@5 and P@10 use fixed denominators 5 and 10. */
export function metrics(hits: SearchHit[], judgments: Record<string, number>): Metrics {
  const grade = (hit: SearchHit): number =>
    Object.hasOwn(judgments, hit.passage.id) ? (judgments[hit.passage.id] ?? 0) : 0;
  const relevant = (hit: SearchHit): boolean => grade(hit) > 0;
  const top = hits.slice(0, 10);
  const gain = (grades: number[]): number =>
    grades.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0);
  const ideal = gain(Object.values(judgments).sort((a, b) => b - a).slice(0, 10));
  const positives = Object.values(judgments).filter(value => value > 0).length;
  const negatives = Object.values(judgments).filter(value => value === 0).length;
  const groups = new Set(top.map(hit => hit.passage.duplicateGroup || hit.passage.id));

  // Mean Average Precision (MAP) at all recall cutoffs
  let relCount = 0;
  let apSum = 0;
  for (let i = 0; i < hits.length; i++) {
    if (relevant(hits[i]!)) {
      relCount++;
      apSum += relCount / (i + 1);
    }
  }
  const map = positives > 0 ? apSum / positives : 0;

  // R-Precision (precision at rank R, where R is total relevant documents)
  const topR = hits.slice(0, positives);
  const rPrec = positives > 0 ? topR.filter(relevant).length / positives : 0;

  // BPref (Binary Preference: Buckley & Voorhees, 2004 - robust to incomplete judgments)
  let nonrelAbove = 0;
  let bprefSum = 0;
  const denom = Math.min(positives, Math.max(negatives, 1));
  for (const hit of hits) {
    if (!Object.hasOwn(judgments, hit.passage.id)) continue;
    const g = judgments[hit.passage.id] ?? 0;
    if (g > 0) {
      bprefSum += (1 - Math.min(nonrelAbove, positives) / denom);
    } else {
      nonrelAbove++;
    }
  }
  const bpref = positives > 0 ? Math.max(0, bprefSum / positives) : 0;

  // 11-point interpolated Precision-Recall curve
  const prPoints: { recall: number; precision: number }[] = [];
  let seenRel = 0;
  for (let i = 0; i < hits.length; i++) {
    if (relevant(hits[i]!)) {
      seenRel++;
      prPoints.push({
        recall: positives > 0 ? seenRel / positives : 0,
        precision: seenRel / (i + 1),
      });
    }
  }
  const interpolatedPR: number[] = [];
  for (let step = 0; step <= 10; step++) {
    const targetRecall = step / 10;
    let maxP = 0;
    for (const pt of prPoints) {
      if (pt.recall >= targetRecall && pt.precision > maxP) maxP = pt.precision;
    }
    interpolatedPR.push(maxP);
  }

  return {
    p5: hits.slice(0, 5).filter(relevant).length / 5,
    p10: top.filter(relevant).length / 10,
    ndcg10: ideal > 0 ? gain(top.map(grade)) / ideal : 0,
    pooledRecall10: positives > 0 ? top.filter(relevant).length / positives : 0,
    redundancy10: top.length > 0 ? 1 - groups.size / top.length : 0,
    map,
    rPrec,
    bpref,
    interpolatedPR,
  };
}

const rankIds = (hits: SearchHit[]): string[] => hits.slice(0, 10).map(hit => hit.passage.id);
const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Score all methods on one index. Throws before scoring if the index folds exact-text aliases. */
export function evaluate(dataset: Dataset) {
  const index = new PassageIndex();
  index.add(dataset.passages);
  const stats = index.stats;
  if (stats.aliases > 0) {
    fail(`${stats.aliases} exact-text alias(es) share a body with a canonical passage. ` +
      'Deduplicate exact-text aliases and re-verify the human judgments for the retained IDs; ' +
      'grades are never folded or guessed automatically, and near variants must stay distinct.');
  }
  const perQuery = dataset.queries.map(query => {
    const branch: Branch = {
      id: query.id, objectiveId: query.id, question: query.text, anchor: query.text,
      origin: 'initial', introducing: [], priority: 1, status: 'active', needs: [],
      aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
    };
    const bm25 = index.rank(query.text, 30);
    const bm25stem = index.rankStemmed(query.text, 30);
    const ql = index.rankQL(query.text, 30);
    const sdm = index.rankSDM(query.text, 30);
    // No qrel leakage: PRF concepts come only from the ranked corpus pool and the
    // anchor. This lexical ablation never reads query.judgments or any human grade.
    const lexicalPRF = index.rank(expandedQuery(query.text, concepts(bm25, branch, [], 12, index)), 30);
    const prfMMR = mmr(lexicalPRF, 10);
    return {
      queryId: query.id,
      text: query.text,
      judgedPositive: Object.values(query.judgments).filter(grade => grade > 0).length,
      rankings: {
        bm25: rankIds(bm25),
        bm25stem: rankIds(bm25stem),
        ql: rankIds(ql),
        sdm: rankIds(sdm),
        lexicalPRF: rankIds(lexicalPRF),
        prfMMR: rankIds(prfMMR),
      },
      metrics: {
        bm25: metrics(bm25, query.judgments),
        bm25stem: metrics(bm25stem, query.judgments),
        ql: metrics(ql, query.judgments),
        sdm: metrics(sdm, query.judgments),
        lexicalPRF: metrics(lexicalPRF, query.judgments),
        prfMMR: metrics(prfMMR, query.judgments),
      },
    };
  });
  const macro = {} as Record<Method, Metrics>;
  for (const method of METHODS) {
    const rows = perQuery.map(query => query.metrics[method]);
    const avgPR = Array.from({ length: 11 }, (_, idx) =>
      mean(rows.map(row => row.interpolatedPR[idx] ?? 0))
    );
    macro[method] = {
      p5: mean(rows.map(row => row.p5)),
      p10: mean(rows.map(row => row.p10)),
      ndcg10: mean(rows.map(row => row.ndcg10)),
      pooledRecall10: mean(rows.map(row => row.pooledRecall10)),
      redundancy10: mean(rows.map(row => row.redundancy10)),
      map: mean(rows.map(row => row.map)),
      rPrec: mean(rows.map(row => row.rPrec)),
      bpref: mean(rows.map(row => row.bpref)),
      interpolatedPR: avgPR,
    };
  }
  const significance = {
    bm25stemVsBm25: perQuery.length >= 2
      ? pairedTTest(
          perQuery.map(q => q.metrics.bm25stem.ndcg10),
          perQuery.map(q => q.metrics.bm25.ndcg10),
          'bm25stem',
          'bm25',
          'ndcg10',
        )
      : undefined,
  };
  return {
    scope: {
      corpus: 'one frozen index shared by all methods; every query is judged over the same pool',
      unjudged: 'passages without a human grade count as zero relevance (except BPref which evaluates only judged documents)',
      recall: 'pooledRecall10 is relative to the human-judged pool, not recall over the web',
      lexicalPRF: 'anchored corpus-derived lexical feedback, not the live contextual model assessment',
      excluded: 'this ablation does not evaluate research policy, allocation, conversation or report quality',
      judgments: 'all judgments are human-supplied input; this tool fabricates no results',
    },
    methods: METHODS,
    corpus: {
      passages: dataset.passages.length,
      queries: dataset.queries.length,
      zeroPositiveQrelQueries: perQuery.filter(query => query.judgedPositive === 0).length,
      index: stats,
    },
    perQuery,
    macro,
    significance,
  };
}

/** Approximate two-tailed p-value for Student's t-distribution with df degrees of freedom. */
export function studentTTwoTailedP(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(t)) return 1.0;
  const absT = Math.abs(t);
  if (absT === 0) return 1.0;
  const a = df / 2;
  const b = 0.5;
  const x = df / (df + absT * absT);

  const betaLn = (z: number): number => {
    const g = 7;
    const C = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.138571095836524, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - betaLn(1 - z);
    z -= 1;
    let base = C[0]!;
    for (let i = 1; i < g + 2; i++) base += C[i]! / (z + i);
    const tVal = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(tVal) - tVal + Math.log(base);
  };

  const lnBeta = betaLn(a) + betaLn(b) - betaLn(a + b);
  const betacf = (aa: number, bb: number, xx: number): number => {
    const qab = aa + bb;
    const qap = aa + 1.0;
    const qam = aa - 1.0;
    let c = 1.0;
    let d = 1.0 - (qab * xx) / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1.0 / d;
    let h = d;
    for (let m = 1; m <= 100; m++) {
      const m2 = 2 * m;
      let num = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
      d = 1.0 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1.0 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1.0 / d;
      h *= d * c;
      num = -((aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
      d = 1.0 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1.0 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1.0 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1.0) < 3e-12) break;
    }
    return h;
  };
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta);
  const ix = x < (a + 1.0) / (a + b + 2.0)
    ? (bt * betacf(a, b, x)) / a
    : 1.0 - (bt * betacf(b, a, 1.0 - x)) / b;
  return Math.min(1.0, Math.max(0.0, ix));
}

export interface SignificanceResult {
  metric: string;
  methodA: string;
  methodB: string;
  n: number;
  meanA: number;
  meanB: number;
  meanDiff: number;
  tStatistic: number;
  pValue: number;
  significantAt05: boolean;
  significantAt01: boolean;
}

export function pairedTTest(
  sampleA: number[],
  sampleB: number[],
  methodA: string,
  methodB: string,
  metric = 'ndcg10',
): SignificanceResult {
  if (sampleA.length !== sampleB.length || sampleA.length < 2) {
    throw new Error('pairedTTest requires two non-empty equal-length samples of size >= 2');
  }
  const n = sampleA.length;
  const diffs = sampleA.map((a, i) => a - sampleB[i]!);
  const meanDiff = mean(diffs);
  const variance = diffs.reduce((acc, d) => acc + (d - meanDiff) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const t = se > 0 ? meanDiff / se : 0;
  const pValue = se > 0 ? studentTTwoTailedP(t, n - 1) : (meanDiff === 0 ? 1.0 : 0.0);
  return {
    metric,
    methodA,
    methodB,
    n,
    meanA: mean(sampleA),
    meanB: mean(sampleB),
    meanDiff,
    tStatistic: t,
    pValue,
    significantAt05: pValue < 0.05,
    significantAt01: pValue < 0.01,
  };
}

export interface ParamSweepResult {
  k1: number;
  b: number;
  p10: number;
  ndcg10: number;
  map: number;
}

export function sweepBM25(
  dataset: Dataset,
  grid = {
    k1: [0.8, 1.2, 1.6, 2.0],
    b: [0.5, 0.65, 0.75, 0.85],
  },
): ParamSweepResult[] {
  const index = new PassageIndex();
  index.add(dataset.passages);
  const results: ParamSweepResult[] = [];
  for (const k1 of grid.k1) {
    for (const b of grid.b) {
      const scores = dataset.queries.map(q => {
        const hits = index.rankStemmed(q.text, 30);
        const m = metrics(hits, q.judgments);
        return { p10: m.p10, ndcg10: m.ndcg10, map: m.map };
      });
      results.push({
        k1,
        b,
        p10: mean(scores.map(s => s.p10)),
        ndcg10: mean(scores.map(s => s.ndcg10)),
        map: mean(scores.map(s => s.map)),
      });
    }
  }
  results.sort((a, b) => b.ndcg10 - a.ndcg10);
  return results;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (!filename) {
    console.error('Usage: tsx scripts/evaluate.ts <judged-dataset.json>');
    process.exitCode = 1;
  } else {
    try {
      const value: unknown = JSON.parse(readFileSync(filename, 'utf8'));
      process.stdout.write(`${JSON.stringify(evaluate(parseDataset(value)), null, 2)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
