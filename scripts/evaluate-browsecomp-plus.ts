/**
 * BrowseComp-Plus retrieval benchmark adapter for Pi Research.
 *
 * Reuses Pi Research's exact tokenization (`tokenize`, `keyTerms`, `STOPWORDS`),
 * Porter stemming (`stem`), passage segmentation (`segment`), BM25 formula
 * (`K1 = 1.2`, `B = 0.75`), and paired statistical test (`pairedTTest`).
 *
 * Evaluates three configurations on the BrowseComp-Plus corpus (100,195 docs):
 *   1. pi_whole_doc_bm25         — Whole-document BM25 (k1=1.2, b=0.75, unstemmed)
 *   2. pi_passage_bm25           — Passage BM25 (segment() + max-passage aggregation)
 *   3. pi_stemmed_passage_bm25   — Stemmed passage BM25 (segment() + stem() + max-passage)
 *
 * Also generates a diagnostic whole-document stemmed BM25 run with
 * Pyserini/Lucene default parameters (k1=0.9, b=0.4) to check baseline alignment
 * without altering Pi Research's production BM25 defaults.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { B, K1, keyTerms, segment, stem } from '../src/core-ir.js';
import type { Passage, Snapshot } from '../src/types.js';
import { pairedTTest, type SignificanceResult } from './evaluate.js';

export interface BenchmarkQuery {
  query_id: string;
  query: string;
}

export interface BenchmarkDocument {
  docid: string;
  text: string;
  url?: string;
}

export interface ScoredDoc {
  docid: string;
  score: number;
}

export interface PassageHit {
  passageId: string;
  score: number;
}

interface ShardSnapshot {
  docIds: string[];
  docLengths: number[];
  totalDocTokens: number;
  docPostings: Record<string, number[]>;
  docStemPostings: Record<string, number[]>;
  passageCount: number;
  passageParentDocIdx: number[];
  passageLengths: number[];
  totalPassageTokens: number;
  passagePostings: Record<string, number[]>;
  passageStemPostings: Record<string, number[]>;
}

const stemCache = new Map<string, string>();
function cachedStem(term: string): string {
  let s = stemCache.get(term);
  if (s === undefined) {
    s = stem(term);
    stemCache.set(term, s);
  }
  return s;
}

/** Deterministic descending score, ascending docid tie-breaker. */
export function compareScoredDocs(a: ScoredDoc, b: ScoredDoc): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.docid < b.docid ? -1 : a.docid > b.docid ? 1 : 0;
}

/**
 * Convert a BrowseComp-Plus document into Pi Research passages via `segment()`,
 * preserving the mapping `passage.id -> parent docid`.
 */
export function documentToPassages(doc: BenchmarkDocument): {
  passages: Passage[];
  passageToDoc: Map<string, string>;
} {
  const url = doc.url ?? `https://browsecomp-plus.local/doc/${doc.docid}`;
  const snapshot: Snapshot = {
    id: doc.docid,
    requestedUrl: url,
    finalUrl: url,
    canonicalUrl: url,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    contentHash: doc.docid,
    textHash: doc.docid,
    rawBlob: '',
    textBlob: '',
    mime: 'text/plain',
    status: 200,
    title: '',
    text: doc.text,
    extraction: 'plain',
    extractionVersion: 'browsecomp-plus-adapter',
  };
  const passages = segment(snapshot);
  const passageToDoc = new Map<string, string>();
  for (const p of passages) {
    passageToDoc.set(p.id, doc.docid);
  }
  return { passages, passageToDoc };
}

/**
 * Aggregate passage scores to parent documents using max-passage score:
 *   document_score = max(score of all passages belonging to that document)
 * Deduplicates parent documents, sorts deterministically, and truncates to `topK`.
 */
export function aggregateMaxPassage(
  passageHits: PassageHit[],
  passageToDoc: Map<string, string>,
  topK = 1000,
): ScoredDoc[] {
  const maxByDoc = new Map<string, number>();
  for (const hit of passageHits) {
    const docid = passageToDoc.get(hit.passageId);
    if (docid === undefined) continue;
    const prev = maxByDoc.get(docid);
    if (prev === undefined || hit.score > prev) {
      maxByDoc.set(docid, hit.score);
    }
  }
  const docs: ScoredDoc[] = [];
  for (const [docid, score] of maxByDoc) {
    docs.push({ docid, score });
  }
  docs.sort(compareScoredDocs);
  return docs.slice(0, topK);
}

/** Format ranked documents for one query as TREC run lines (rank 1..topK, no passage IDs). */
export function formatTrecRun(
  queryId: string,
  rankedDocs: ScoredDoc[],
  runName: string,
  topK = 1000,
): string[] {
  const lines: string[] = [];
  const limit = Math.min(rankedDocs.length, topK);
  for (let i = 0; i < limit; i++) {
    const item = rankedDocs[i]!;
    lines.push(`${queryId} Q0 ${item.docid} ${i + 1} ${item.score.toFixed(6)} ${runName}`);
  }
  return lines;
}

/** Build query term weight maps (exact equivalent of core-ir.ts queryWeights). */
function buildQueryWeights(query: string, useStem: boolean): Map<string, number> {
  const weights = new Map<string, number>();
  for (const term of keyTerms(query)) {
    const key = useStem ? cachedStem(term) : term;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return weights;
}

/**
 * Memory-efficient streaming exact BM25 evaluator over large corpora.
 *
 * Computes exact BM25 scores mathematically identical to `PassageIndex.rank()`
 * and `PassageIndex.rankStemmed()` by retaining postings only for terms present
 * in the benchmark query set while tracking exact corpus-wide N, df(t), and avgdl.
 */
export class StreamingBM25Evaluator {
  private readonly queries: BenchmarkQuery[];
  private readonly rawQueryTerms = new Set<string>();
  private readonly stemQueryTerms = new Set<string>();

  // Whole-document index state
  private docIds: string[] = [];
  private docLengths: number[] = [];
  private totalDocTokens = 0;
  private docPostings = new Map<string, number[]>();
  private docStemPostings = new Map<string, number[]>();

  // Passage index state
  private passageCount = 0;
  private passageParentDocIdx: number[] = [];
  private passageLengths: number[] = [];
  private totalPassageTokens = 0;
  private passagePostings = new Map<string, number[]>();
  private passageStemPostings = new Map<string, number[]>();

  constructor(queries: BenchmarkQuery[]) {
    this.queries = queries;
    for (const q of queries) {
      for (const t of keyTerms(q.query)) {
        this.rawQueryTerms.add(t);
        this.stemQueryTerms.add(cachedStem(t));
      }
    }
    for (const t of this.rawQueryTerms) {
      this.docPostings.set(t, []);
      this.passagePostings.set(t, []);
    }
    for (const st of this.stemQueryTerms) {
      this.docStemPostings.set(st, []);
      this.passageStemPostings.set(st, []);
    }
  }

  /** Index one document for both whole-document and passage-level retrieval. */
  addDocument(doc: BenchmarkDocument): void {
    const docIdx = this.docIds.length;
    this.docIds.push(doc.docid);

    // 1. Whole-document content terms (exact keyTerms = tokenize minus STOPWORDS)
    const docTerms = keyTerms(doc.text);
    this.docLengths.push(docTerms.length);
    this.totalDocTokens += docTerms.length;

    const docRawTf = new Map<string, number>();
    const docStemTf = new Map<string, number>();
    for (let i = 0; i < docTerms.length; i++) {
      const term = docTerms[i]!;
      if (this.rawQueryTerms.has(term)) {
        docRawTf.set(term, (docRawTf.get(term) ?? 0) + 1);
      }
      const st = cachedStem(term);
      if (this.stemQueryTerms.has(st)) {
        docStemTf.set(st, (docStemTf.get(st) ?? 0) + 1);
      }
    }
    for (const [term, tf] of docRawTf) {
      this.docPostings.get(term)!.push(docIdx, tf);
    }
    for (const [st, tf] of docStemTf) {
      this.docStemPostings.get(st)!.push(docIdx, tf);
    }

    // 2. Passage segmentation via Pi Research's exact `segment()`
    const { passages } = documentToPassages(doc);
    for (let pi = 0; pi < passages.length; pi++) {
      const p = passages[pi]!;
      const pIdx = this.passageCount++;
      this.passageParentDocIdx.push(docIdx);
      const pTerms = keyTerms(p.text);
      this.passageLengths.push(pTerms.length);
      this.totalPassageTokens += pTerms.length;

      const pRawTf = new Map<string, number>();
      const pStemTf = new Map<string, number>();
      for (let i = 0; i < pTerms.length; i++) {
        const term = pTerms[i]!;
        if (this.rawQueryTerms.has(term)) {
          pRawTf.set(term, (pRawTf.get(term) ?? 0) + 1);
        }
        const st = cachedStem(term);
        if (this.stemQueryTerms.has(st)) {
          pStemTf.set(st, (pStemTf.get(st) ?? 0) + 1);
        }
      }
      for (const [term, tf] of pRawTf) {
        this.passagePostings.get(term)!.push(pIdx, tf);
      }
      for (const [st, tf] of pStemTf) {
        this.passageStemPostings.get(st)!.push(pIdx, tf);
      }
    }
  }

  exportShard(): ShardSnapshot {
    const toObj = (m: Map<string, number[]>) => {
      const out: Record<string, number[]> = {};
      for (const [k, v] of m) if (v.length) out[k] = v;
      return out;
    };
    return {
      docIds: this.docIds,
      docLengths: this.docLengths,
      totalDocTokens: this.totalDocTokens,
      docPostings: toObj(this.docPostings),
      docStemPostings: toObj(this.docStemPostings),
      passageCount: this.passageCount,
      passageParentDocIdx: this.passageParentDocIdx,
      passageLengths: this.passageLengths,
      totalPassageTokens: this.totalPassageTokens,
      passagePostings: toObj(this.passagePostings),
      passageStemPostings: toObj(this.passageStemPostings),
    };
  }

  mergeShard(shard: ShardSnapshot): void {
    const docOffset = this.docIds.length;
    const pOffset = this.passageCount;

    for (let i = 0; i < shard.docIds.length; i++) {
      this.docIds.push(shard.docIds[i]!);
      this.docLengths.push(shard.docLengths[i]!);
    }
    this.totalDocTokens += shard.totalDocTokens;

    for (const [term, list] of Object.entries(shard.docPostings)) {
      const dest = this.docPostings.get(term);
      if (!dest) continue;
      for (let i = 0; i < list.length; i += 2) {
        dest.push(list[i]! + docOffset, list[i + 1]!);
      }
    }
    for (const [st, list] of Object.entries(shard.docStemPostings)) {
      const dest = this.docStemPostings.get(st);
      if (!dest) continue;
      for (let i = 0; i < list.length; i += 2) {
        dest.push(list[i]! + docOffset, list[i + 1]!);
      }
    }

    this.passageCount += shard.passageCount;
    for (let i = 0; i < shard.passageParentDocIdx.length; i++) {
      this.passageParentDocIdx.push(shard.passageParentDocIdx[i]! + docOffset);
      this.passageLengths.push(shard.passageLengths[i]!);
    }
    this.totalPassageTokens += shard.totalPassageTokens;

    for (const [term, list] of Object.entries(shard.passagePostings)) {
      const dest = this.passagePostings.get(term);
      if (!dest) continue;
      for (let i = 0; i < list.length; i += 2) {
        dest.push(list[i]! + pOffset, list[i + 1]!);
      }
    }
    for (const [st, list] of Object.entries(shard.passageStemPostings)) {
      const dest = this.passageStemPostings.get(st);
      if (!dest) continue;
      for (let i = 0; i < list.length; i += 2) {
        dest.push(list[i]! + pOffset, list[i + 1]!);
      }
    }
  }

  get stats() {
    const nDocs = this.docIds.length;
    const nPassages = this.passageCount;
    return {
      documents: nDocs,
      passages: nPassages,
      avgDocContentTokens: nDocs > 0 ? this.totalDocTokens / nDocs : 0,
      avgPassageContentTokens: nPassages > 0 ? this.totalPassageTokens / nPassages : 0,
      avgPassagesPerDoc: nDocs > 0 ? nPassages / nDocs : 0,
      uniqueRawQueryTerms: this.rawQueryTerms.size,
      uniqueStemQueryTerms: this.stemQueryTerms.size,
    };
  }

  /** Score whole-document BM25 for all queries. */
  rankWholeDocuments(options: { stem?: boolean; k1?: number; b?: number; topK?: number } = {}): Map<string, ScoredDoc[]> {
    const useStem = Boolean(options.stem);
    const k1 = options.k1 ?? K1;
    const b = options.b ?? B;
    const topK = options.topK ?? 1000;
    const n = this.docIds.length;
    const avg = n > 0 ? this.totalDocTokens / n : 0;
    const postingsMap = useStem ? this.docStemPostings : this.docPostings;

    const scores = new Float64Array(n);
    const touched: number[] = [];
    const results = new Map<string, ScoredDoc[]>();

    for (const q of this.queries) {
      const weights = buildQueryWeights(q.query, useStem);
      for (const [term, weight] of weights) {
        const list = postingsMap.get(term);
        if (!list || !list.length) continue;
        const df = list.length / 2;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        for (let i = 0; i < list.length; i += 2) {
          const docIdx = list[i]!;
          const tf = list[i + 1]!;
          if (scores[docIdx] === 0) touched.push(docIdx);
          const length = this.docLengths[docIdx]!;
          const norm = avg > 0 ? k1 * (1 - b + b * (length / avg)) : k1;
          scores[docIdx] = scores[docIdx]! + weight * idf * ((tf * (k1 + 1)) / (tf + norm));
        }
      }

      const ranked: ScoredDoc[] = new Array(touched.length);
      for (let i = 0; i < touched.length; i++) {
        const docIdx = touched[i]!;
        ranked[i] = { docid: this.docIds[docIdx]!, score: scores[docIdx]! };
        scores[docIdx] = 0;
      }
      touched.length = 0;
      ranked.sort(compareScoredDocs);
      results.set(q.query_id, ranked.slice(0, topK));
    }

    return results;
  }

  /**
   * Score passage-level BM25 and aggregate to parent documents using exact
   * max-passage score across all passages in the corpus.
   */
  rankPassagesMaxDoc(options: { stem?: boolean; k1?: number; b?: number; topK?: number } = {}): Map<string, ScoredDoc[]> {
    const useStem = Boolean(options.stem);
    const k1 = options.k1 ?? K1;
    const b = options.b ?? B;
    const topK = options.topK ?? 1000;
    const nPassages = this.passageCount;
    const nDocs = this.docIds.length;
    const avg = nPassages > 0 ? this.totalPassageTokens / nPassages : 0;
    const postingsMap = useStem ? this.passageStemPostings : this.passagePostings;

    const pScores = new Float64Array(nPassages);
    const touchedPassages: number[] = [];
    const docMaxScores = new Float64Array(nDocs);
    const touchedDocs: number[] = [];
    const results = new Map<string, ScoredDoc[]>();

    for (const q of this.queries) {
      const weights = buildQueryWeights(q.query, useStem);
      for (const [term, weight] of weights) {
        const list = postingsMap.get(term);
        if (!list || !list.length) continue;
        const df = list.length / 2;
        const idf = Math.log(1 + (nPassages - df + 0.5) / (df + 0.5));
        for (let i = 0; i < list.length; i += 2) {
          const pIdx = list[i]!;
          const tf = list[i + 1]!;
          if (pScores[pIdx] === 0) touchedPassages.push(pIdx);
          const length = this.passageLengths[pIdx]!;
          const norm = avg > 0 ? k1 * (1 - b + b * (length / avg)) : k1;
          pScores[pIdx] = pScores[pIdx]! + weight * idf * ((tf * (k1 + 1)) / (tf + norm));
        }
      }

      for (let i = 0; i < touchedPassages.length; i++) {
        const pIdx = touchedPassages[i]!;
        const score = pScores[pIdx]!;
        pScores[pIdx] = 0;
        const docIdx = this.passageParentDocIdx[pIdx]!;
        if (docMaxScores[docIdx] === 0) {
          touchedDocs.push(docIdx);
          docMaxScores[docIdx] = score;
        } else if (score > docMaxScores[docIdx]!) {
          docMaxScores[docIdx] = score;
        }
      }
      touchedPassages.length = 0;

      const ranked: ScoredDoc[] = new Array(touchedDocs.length);
      for (let i = 0; i < touchedDocs.length; i++) {
        const docIdx = touchedDocs[i]!;
        ranked[i] = { docid: this.docIds[docIdx]!, score: docMaxScores[docIdx]! };
        docMaxScores[docIdx] = 0;
      }
      touchedDocs.length = 0;
      ranked.sort(compareScoredDocs);
      results.set(q.query_id, ranked.slice(0, topK));
    }

    return results;
  }
}

/** Stream documents from a single Parquet shard using Python pyarrow. */
async function streamSingleParquetShard(
  shardPath: string,
  onDoc: (doc: BenchmarkDocument) => void,
): Promise<number> {
  const pyCode = [
    'import json, sys',
    'import pyarrow.parquet as pq',
    'pf = pq.ParquetFile(sys.argv[1])',
    'out = sys.stdout',
    'for batch in pf.iter_batches(batch_size=2000, columns=["docid", "text", "url"]):',
    '    docids = batch["docid"].to_pylist()',
    '    texts = batch["text"].to_pylist()',
    '    urls = batch["url"].to_pylist()',
    '    for d, t, u in zip(docids, texts, urls):',
    '        out.write(json.dumps({"docid": str(d), "text": t or "", "url": u or ""}, ensure_ascii=False) + "\\n")',
    'out.flush()',
  ].join('\n');

  const child = spawn('python', ['-c', pyCode, shardPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  let count = 0;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const doc = JSON.parse(line) as BenchmarkDocument;
    onDoc(doc);
    count++;
  }

  const exitCode: number = await new Promise(resolveExit => {
    child.on('close', code => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`Parquet shard reader failed (${shardPath}): ${stderr}`);
  }
  return count;
}

/** Run 7 shard worker processes in parallel across available CPU cores. */
async function indexShardsInParallel(
  scriptPath: string,
  queriesPath: string,
  corpusDir: string,
  cacheDir: string,
): Promise<string[]> {
  const dataDir = join(corpusDir, 'data');
  const shards = readdirSync(dataDir)
    .filter(f => f.endsWith('.parquet'))
    .sort()
    .map(f => join(dataDir, f));
  if (!shards.length) throw new Error(`No parquet shards in ${dataDir}`);

  mkdirSync(cacheDir, { recursive: true });
  const shardOutPaths = shards.map((_, i) => join(cacheDir, `shard-${i}.json`));

  // Spawn all shard workers in parallel
  const workers = shards.map((shardPath, i) => {
    const outPath = shardOutPaths[i]!;
    if (existsSync(outPath)) {
      process.stderr.write(`Reusing cached shard ${i}: ${outPath}\n`);
      return Promise.resolve();
    }
    return new Promise<void>((resolveWorker, rejectWorker) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', scriptPath, '--worker-shard', shardPath, '--queries', queriesPath, '--worker-out', outPath],
        { stdio: ['ignore', 'inherit', 'inherit'] },
      );
      child.on('close', code => {
        if (code === 0) resolveWorker();
        else rejectWorker(new Error(`Worker for shard ${i} exited with code ${code}`));
      });
    });
  });

  await Promise.all(workers);
  return shardOutPaths;
}

function writeTrecRunFile(
  path: string,
  queries: BenchmarkQuery[],
  rankings: Map<string, ScoredDoc[]>,
  runName: string,
): void {
  const lines: string[] = [];
  for (const q of queries) {
    const docs = rankings.get(q.query_id) ?? [];
    lines.push(...formatTrecRun(q.query_id, docs, runName, 1000));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function parseCliArgs(argv: string[]) {
  const opts = {
    queries: 'benchmark-data/prepared/queries-100.json',
    corpusDir: 'benchmark-data/raw/corpus',
    evidenceQrels: 'benchmark-data/prepared/qrel_evidence-100.txt',
    goldQrels: 'benchmark-data/prepared/qrel_golds-100.txt',
    outDir: 'evaluation/browsecomp-plus',
    cacheDir: 'benchmark-data/cache-100',
    workerShard: '',
    workerOut: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${arg} requires a value`);
      return v;
    };
    if (arg === '--queries') opts.queries = next();
    else if (arg === '--corpus-dir') opts.corpusDir = next();
    else if (arg === '--evidence-qrels') opts.evidenceQrels = next();
    else if (arg === '--gold-qrels') opts.goldQrels = next();
    else if (arg === '--out-dir') opts.outDir = next();
    else if (arg === '--cache-dir') opts.cacheDir = next();
    else if (arg === '--worker-shard') opts.workerShard = next();
    else if (arg === '--worker-out') opts.workerOut = next();
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const queriesPath = resolve(opts.queries);
  const queries = JSON.parse(readFileSync(queriesPath, 'utf8')) as BenchmarkQuery[];

  // Worker mode: index a single Parquet shard and write compact shard postings JSON
  if (opts.workerShard && opts.workerOut) {
    const t0 = Date.now();
    const ev = new StreamingBM25Evaluator(queries);
    const count = await streamSingleParquetShard(resolve(opts.workerShard), doc => ev.addDocument(doc));
    writeFileSync(resolve(opts.workerOut), JSON.stringify(ev.exportShard()));
    process.stderr.write(`Worker finished ${opts.workerShard} (${count} docs, ${ev.stats.passages} passages) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    return;
  }

  const corpusDir = resolve(opts.corpusDir);
  const evidenceQrels = resolve(opts.evidenceQrels);
  const goldQrels = resolve(opts.goldQrels);
  const outDir = resolve(opts.outDir);
  const cacheDir = resolve(opts.cacheDir);

  if (!existsSync(queriesPath)) throw new Error(`Queries file not found: ${queriesPath}`);
  if (!existsSync(corpusDir)) throw new Error(`Corpus directory not found: ${corpusDir}`);
  mkdirSync(outDir, { recursive: true });

  process.stderr.write(`Loaded ${queries.length} queries from ${queriesPath}\n`);

  const t0 = Date.now();
  const scriptPath = fileURLToPath(import.meta.url);
  const shardFiles = await indexShardsInParallel(scriptPath, queriesPath, corpusDir, cacheDir);

  const evaluator = new StreamingBM25Evaluator(queries);
  for (const sf of shardFiles) {
    const shard = JSON.parse(readFileSync(sf, 'utf8')) as ShardSnapshot;
    evaluator.mergeShard(shard);
  }

  const indexMs = Date.now() - t0;
  const stats = evaluator.stats;
  const peakRssMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
  process.stderr.write(
    `Parallel indexing + merge complete in ${(indexMs / 1000).toFixed(1)}s: ` +
    `${stats.documents} docs, ${stats.passages} passages ` +
    `(avg ${stats.avgPassagesPerDoc.toFixed(2)} passages/doc), RSS=${peakRssMB} MB\n`
  );

  // 1. Whole-document BM25 (Pi Research default k1=1.2, b=0.75, unstemmed)
  const t1 = Date.now();
  const wholeDocRankings = evaluator.rankWholeDocuments({ stem: false, k1: K1, b: B, topK: 1000 });
  const wholeDocFile = join(outDir, 'pi_whole_doc_bm25.trec');
  writeTrecRunFile(wholeDocFile, queries, wholeDocRankings, 'pi_whole_doc_bm25');

  // 1b. Diagnostic: Whole-document stemmed BM25 with Pyserini/Lucene defaults (k1=0.9, b=0.4)
  const luceneDiagRankings = evaluator.rankWholeDocuments({ stem: true, k1: 0.9, b: 0.4, topK: 1000 });
  const luceneDiagFile = join(outDir, 'pi_whole_doc_bm25_lucene_params.trec');
  writeTrecRunFile(luceneDiagFile, queries, luceneDiagRankings, 'pi_whole_doc_bm25_lucene_params');

  // 2. Passage BM25 with max-passage parent-document aggregation
  const passageRankings = evaluator.rankPassagesMaxDoc({ stem: false, k1: K1, b: B, topK: 1000 });
  const passageFile = join(outDir, 'pi_passage_bm25.trec');
  writeTrecRunFile(passageFile, queries, passageRankings, 'pi_passage_bm25');

  // 3. Stemmed passage BM25 with max-passage parent-document aggregation
  const stemmedPassageRankings = evaluator.rankPassagesMaxDoc({ stem: true, k1: K1, b: B, topK: 1000 });
  const stemmedPassageFile = join(outDir, 'pi_stemmed_passage_bm25.trec');
  writeTrecRunFile(stemmedPassageFile, queries, stemmedPassageRankings, 'pi_stemmed_passage_bm25');
  const rankMs = Date.now() - t1;
  process.stderr.write(`Ranking + TREC writing complete in ${(rankMs / 1000).toFixed(2)}s\n`);

  // Score with official NIST trec_eval via pytrec_eval
  const rawMetricsPath = join(outDir, 'trec_eval_raw.json');
  const scoreScript = resolve('scripts/score-browsecomp-plus.py');
  execFileSync('python', [
    scoreScript,
    '--evidence-qrels', evidenceQrels,
    '--gold-qrels', goldQrels,
    '--run', `pi_whole_doc_bm25=${wholeDocFile}`,
    '--run', `pi_whole_doc_bm25_lucene_params=${luceneDiagFile}`,
    '--run', `pi_passage_bm25=${passageFile}`,
    '--run', `pi_stemmed_passage_bm25=${stemmedPassageFile}`,
    '--out', rawMetricsPath,
  ], { stdio: 'inherit' });

  const scored = JSON.parse(readFileSync(rawMetricsPath, 'utf8')) as Record<string, {
    runFile: string;
    evidence: { queryCount: number; aggregate: Record<string, number>; aggregatePercent: Record<string, number>; perQuery: Record<string, Record<string, number>> };
    gold: { queryCount: number; aggregate: Record<string, number>; aggregatePercent: Record<string, number>; perQuery: Record<string, Record<string, number>> };
  }>;

  // Paired statistical significance using Pi Research's existing pairedTTest
  const METRIC_KEYS = ['recall_5', 'recall_100', 'recall_1000', 'ndcg_cut_10'] as const;
  const runPaired = (
    qrelSet: 'evidence' | 'gold',
    methodA: string,
    methodB: string,
  ): Record<string, SignificanceResult> => {
    const pqA = scored[methodA]![qrelSet].perQuery;
    const pqB = scored[methodB]![qrelSet].perQuery;
    const qids = Object.keys(pqA).sort();
    const out: Record<string, SignificanceResult> = {};
    for (const m of METRIC_KEYS) {
      const sampleA = qids.map(id => pqA[id]![m]!);
      const sampleB = qids.map(id => pqB[id]![m]!);
      out[m] = pairedTTest(sampleA, sampleB, methodA, methodB, m);
    }
    return out;
  };

  const significance = {
    evidence: {
      passageVsWholeDoc: runPaired('evidence', 'pi_passage_bm25', 'pi_whole_doc_bm25'),
      stemmedPassageVsPassage: runPaired('evidence', 'pi_stemmed_passage_bm25', 'pi_passage_bm25'),
      stemmedPassageVsWholeDoc: runPaired('evidence', 'pi_stemmed_passage_bm25', 'pi_whole_doc_bm25'),
    },
    gold: {
      passageVsWholeDoc: runPaired('gold', 'pi_passage_bm25', 'pi_whole_doc_bm25'),
      stemmedPassageVsPassage: runPaired('gold', 'pi_stemmed_passage_bm25', 'pi_passage_bm25'),
      stemmedPassageVsWholeDoc: runPaired('gold', 'pi_stemmed_passage_bm25', 'pi_whole_doc_bm25'),
    },
  };

  const summary = {
    benchmark: 'BrowseComp-Plus (Chen et al., 2026)',
    subsetQueryCount: queries.length,
    corpusStats: stats,
    timing: {
      indexingSeconds: Number((indexMs / 1000).toFixed(2)),
      rankingSeconds: Number((rankMs / 1000).toFixed(2)),
      peakRssMB,
    },
    publishedFullSetReferencePercent: {
      note: 'Published full-benchmark (830 queries) Pyserini Lucene BM25 reference values from Chen et al. (2026), NOT measured on the 100-query subset.',
      evidence: { recall_5: 1.2, recall_100: 4.7, recall_1000: 13.7, ndcg_cut_10: 1.6 },
      gold: { recall_5: 1.4, recall_100: 6.1, recall_1000: 17.3, ndcg_cut_10: 1.7 },
    },
    subsetResults: Object.fromEntries(
      Object.entries(scored).map(([name, res]) => [
        name,
        {
          runFile: res.runFile,
          evidence: {
            queryCount: res.evidence.queryCount,
            aggregate: res.evidence.aggregate,
            aggregatePercent: res.evidence.aggregatePercent,
          },
          gold: {
            queryCount: res.gold.queryCount,
            aggregate: res.gold.aggregate,
            aggregatePercent: res.gold.aggregatePercent,
          },
        },
      ]),
    ),
    significance,
    evaluatedAt: new Date().toISOString(),
  };

  const summaryPath = join(outDir, 'metrics.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
