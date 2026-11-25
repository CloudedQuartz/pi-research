import assert from 'node:assert/strict';
import { PassageIndex } from '../src/core-ir.js';
import {
  StreamingBM25Evaluator,
  aggregateMaxPassage,
  documentToPassages,
  formatTrecRun,
} from '../scripts/evaluate-browsecomp-plus.js';
// @ts-expect-error ESM .mjs helper module
import { formatFilteredQrels, parseTrecQrels, selectQuerySubset } from '../scripts/prepare-browsecomp-plus.mjs';

const failures: string[] = [];
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`FAIL ${label} — ${err instanceof Error ? err.message : String(err)}`);
  }
};

// 1. Dataset parsing & ID preservation
check('parseTrecQrels parses 4-column TREC qrels and preserves original IDs', () => {
  const raw = '769 Q0 18639 1\n769 Q0 41759 1\n770 Q0 1735 1\n';
  const { qrels, lineCount } = parseTrecQrels(raw);
  assert.equal(lineCount, 3);
  assert.equal(qrels.size, 2);
  assert.equal(qrels.get('769').get('18639'), 1);
  assert.equal(qrels.get('769').get('41759'), 1);
  assert.equal(qrels.get('770').get('1735'), 1);
});

// 2. Deterministic query subset selection
check('selectQuerySubset is deterministic for a fixed seed and independent of input order', () => {
  const queries = Array.from({ length: 50 }, (_, i) => ({
    query_id: String(100 + i),
    query: `Question number ${i}`,
  }));
  const reversed = [...queries].reverse();
  const s1 = selectQuerySubset(queries, 10, 42);
  const s2 = selectQuerySubset(reversed, 10, 42);
  const s3 = selectQuerySubset(queries, 10, 99);
  assert.equal(s1.length, 10);
  assert.deepEqual(s1.map((q: { query_id: string }) => q.query_id), s2.map((q: { query_id: string }) => q.query_id));
  assert.notDeepEqual(s1.map((q: { query_id: string }) => q.query_id), s3.map((q: { query_id: string }) => q.query_id));
});

// 3. Correct association of both qrel sets
check('formatFilteredQrels retains only selected queries for both evidence and gold sets', () => {
  const ev = parseTrecQrels('10 Q0 100 1\n10 Q0 101 1\n20 Q0 200 1\n');
  const gold = parseTrecQrels('10 Q0 100 1\n20 Q0 200 1\n');
  const evOut = formatFilteredQrels(ev.qrels, ['10']);
  const goldOut = formatFilteredQrels(gold.qrels, ['10']);
  assert.equal(evOut.pairCount, 2);
  assert.equal(goldOut.pairCount, 1);
  assert.ok(!evOut.text.includes('20 Q0'));
  assert.ok(!goldOut.text.includes('20 Q0'));
});

// 4. Passage-to-parent mapping
check('documentToPassages maps every generated passage ID back to its parent docid', () => {
  const para = 'Machine learning systems require careful monitoring of training serving skew across pipelines. '.repeat(25);
  const doc = { docid: 'doc-42', text: `${para}\n\n${para}\n\n${para}` };
  const { passages, passageToDoc } = documentToPassages(doc);
  assert.ok(passages.length >= 2, `expected multiple passages, got ${passages.length}`);
  for (const p of passages) {
    assert.equal(p.snapshotId, 'doc-42');
    assert.equal(passageToDoc.get(p.id), 'doc-42');
  }
});

// 5. Max-passage aggregation, deduplication, deterministic tie-breaking, and top-1000 truncation
check('aggregateMaxPassage computes max score per parent, deduplicates, and breaks ties deterministically', () => {
  const map = new Map([
    ['d1:0', 'docB'],
    ['d1:100', 'docB'],
    ['d2:0', 'docA'],
    ['d3:0', 'docC'],
  ]);
  const hits = [
    { passageId: 'd1:0', score: 2.5 },
    { passageId: 'd1:100', score: 5.0 },
    { passageId: 'd2:0', score: 5.0 },
    { passageId: 'd3:0', score: 1.0 },
  ];
  const agg = aggregateMaxPassage(hits, map, 1000);
  assert.equal(agg.length, 3, 'parent documents are deduplicated');
  assert.deepEqual(agg.map(d => d.docid), ['docA', 'docB', 'docC'], 'tie on 5.0 breaks by ascending docid');
  assert.equal(agg[0]!.score, 5.0);
  assert.equal(agg[1]!.score, 5.0);
});

check('aggregateMaxPassage and formatTrecRun enforce top-1000 truncation and valid TREC format', () => {
  const map = new Map<string, string>();
  const hits: { passageId: string; score: number }[] = [];
  for (let i = 0; i < 1200; i++) {
    const pid = `doc${i}:0`;
    map.set(pid, `doc${i}`);
    hits.push({ passageId: pid, score: 1200 - i });
  }
  const agg = aggregateMaxPassage(hits, map, 1000);
  assert.equal(agg.length, 1000);
  const lines = formatTrecRun('769', agg, 'pi_passage_bm25', 1000);
  assert.equal(lines.length, 1000);
  assert.equal(lines[0], '769 Q0 doc0 1 1200.000000 pi_passage_bm25');
  assert.equal(lines[999], '769 Q0 doc999 1000 201.000000 pi_passage_bm25');
  for (const line of lines) {
    assert.ok(!line.includes(':0 '), 'no passage IDs appear in TREC run lines');
  }
});

// 6. Exact mathematical equivalence between StreamingBM25Evaluator and PassageIndex
check('StreamingBM25Evaluator matches PassageIndex.rank and rankStemmed to 1e-12 precision', () => {
  const docs = [
    { docid: '101', text: 'Detecting training serving skew in machine learning pipelines.' },
    { docid: '102', text: 'Automated detection of pipeline failures and feature logging.' },
    { docid: '103', text: 'Unrelated gardening advice about growing tomatoes in summer.' },
  ];
  const queries = [
    { query_id: 'q1', query: 'detecting pipeline failures' },
    { query_id: 'q2', query: 'training serving skew' },
  ];

  // Reference PassageIndex (1 doc = 1 passage since short texts)
  const index = new PassageIndex();
  index.add(docs.map(d => ({
    id: d.docid, snapshotId: d.docid, start: 0, end: d.text.length, text: d.text, duplicateGroup: d.docid,
  })));

  const streaming = new StreamingBM25Evaluator(queries);
  for (const d of docs) streaming.addDocument(d);

  const rawMap = streaming.rankWholeDocuments({ stem: false });
  const stemMap = streaming.rankWholeDocuments({ stem: true });

  for (const q of queries) {
    const refRaw = index.rank(q.query, 10);
    const gotRaw = rawMap.get(q.query_id)!;
    assert.equal(gotRaw.length, refRaw.length);
    for (let i = 0; i < refRaw.length; i++) {
      assert.equal(gotRaw[i]!.docid, refRaw[i]!.passage.id);
      assert.ok(Math.abs(gotRaw[i]!.score - refRaw[i]!.score) < 1e-12, `raw mismatch: ${gotRaw[i]!.score} vs ${refRaw[i]!.score}`);
    }

    const refStem = index.rankStemmed(q.query, 10);
    const gotStem = stemMap.get(q.query_id)!;
    assert.equal(gotStem.length, refStem.length);
    for (let i = 0; i < refStem.length; i++) {
      assert.equal(gotStem[i]!.docid, refStem[i]!.passage.id);
      assert.ok(Math.abs(gotStem[i]!.score - refStem[i]!.score) < 1e-12, `stem mismatch: ${gotStem[i]!.score} vs ${refStem[i]!.score}`);
    }
  }
});

// 7. Parallel shard export/merge equivalence
check('StreamingBM25Evaluator exportShard + mergeShard produces identical scores to single-pass indexing', () => {
  const docs = [
    { docid: 'd1', text: 'Detecting training serving skew in machine learning pipelines. '.repeat(25) },
    { docid: 'd2', text: 'Automated detection of pipeline failures and feature logging. '.repeat(25) },
    { docid: 'd3', text: 'Serving time feature logging prevents training serving skew. '.repeat(25) },
  ];
  const queries = [
    { query_id: 'q1', query: 'detecting pipeline failures' },
    { query_id: 'q2', query: 'training serving skew' },
  ];

  const single = new StreamingBM25Evaluator(queries);
  for (const d of docs) single.addDocument(d);

  const shardA = new StreamingBM25Evaluator(queries);
  shardA.addDocument(docs[0]!);
  const shardB = new StreamingBM25Evaluator(queries);
  shardB.addDocument(docs[1]!);
  shardB.addDocument(docs[2]!);

  const merged = new StreamingBM25Evaluator(queries);
  merged.mergeShard(shardA.exportShard());
  merged.mergeShard(shardB.exportShard());

  assert.deepEqual(merged.stats, single.stats);
  for (const stemOpt of [false, true]) {
    const sDoc = single.rankWholeDocuments({ stem: stemOpt });
    const mDoc = merged.rankWholeDocuments({ stem: stemOpt });
    const sPass = single.rankPassagesMaxDoc({ stem: stemOpt });
    const mPass = merged.rankPassagesMaxDoc({ stem: stemOpt });
    for (const q of queries) {
      assert.deepEqual(mDoc.get(q.query_id), sDoc.get(q.query_id));
      assert.deepEqual(mPass.get(q.query_id), sPass.get(q.query_id));
    }
  }
});

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall BrowseComp-Plus adapter checks passed');
}
