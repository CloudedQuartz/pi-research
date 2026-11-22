#!/usr/bin/env node
/**
 * Prepare the BrowseComp-Plus benchmark subset for Pi Research retrieval evaluation.
 *
 * Source:
 *   Paper: Chen et al. (2026), BrowseComp-Plus: A Fair and Disentangled Evaluation Benchmark
 *          for Deep Search Agents (ACL 2026, https://aclanthology.org/2026.acl-long.1023/)
 *   Repo:  https://github.com/texttron/BrowseComp-Plus
 *   HF Datasets:
 *     - Tevatron/browsecomp-plus (830 obfuscated queries, decrypted with official canary)
 *     - Tevatron/browsecomp-plus-corpus (100,195 documents)
 *
 * Usage:
 *   node scripts/prepare-browsecomp-plus.mjs [--seed 42] [--subset 100]
 *     [--repo-dir benchmark-data/BrowseComp-Plus]
 *     [--queries benchmark-data/raw/queries.json]
 *     [--corpus-dir benchmark-data/raw/corpus]
 *     [--out-dir benchmark-data/prepared]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_SEED = 42;
const DEFAULT_SUBSET = 100;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const expect = (cond, msg) => { if (!cond) fail(msg); };

/** Deterministic Mulberry32 PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic query subset selection (seeded Fisher-Yates on canonically sorted IDs). */
export function selectQuerySubset(queries, count, seed = DEFAULT_SEED) {
  const sorted = [...queries].sort((a, b) => {
    const na = Number(a.query_id);
    const nb = Number(b.query_id);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.query_id).localeCompare(String(b.query_id));
  });
  if (count >= sorted.length) return sorted;
  const rng = mulberry32(seed);
  const copy = [...sorted];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count).sort((a, b) => {
    const na = Number(a.query_id);
    const nb = Number(b.query_id);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.query_id).localeCompare(String(b.query_id));
  });
}

/** Parse standard 4-column TREC qrels (`qid Q0 docid rel`). */
export function parseTrecQrels(text) {
  const qrels = new Map();
  let lineCount = 0;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    expect(cols.length === 4, `Expected 4-column TREC qrel line, got: ${line}`);
    const [qid, iter, docid, relStr] = cols;
    const rel = Number(relStr);
    expect(Number.isInteger(rel) && rel >= 0, `Invalid relevance grade in line: ${line}`);
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(docid, rel);
    lineCount++;
  }
  return { qrels, lineCount };
}

export function formatFilteredQrels(qrelsMap, selectedIds) {
  const lines = [];
  let pairCount = 0;
  for (const qid of selectedIds) {
    const docs = qrelsMap.get(qid);
    if (!docs) continue;
    const sortedDocs = [...docs.entries()].sort(([a], [b]) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    });
    for (const [docid, rel] of sortedDocs) {
      lines.push(`${qid} Q0 ${docid} ${rel}`);
      pairCount++;
    }
  }
  return { text: `${lines.join('\n')}\n`, pairCount };
}

function parseArgs(argv) {
  const opts = {
    seed: DEFAULT_SEED,
    subset: DEFAULT_SUBSET,
    repoDir: 'benchmark-data/BrowseComp-Plus',
    queries: 'benchmark-data/raw/queries.json',
    corpusDir: 'benchmark-data/raw/corpus',
    outDir: 'benchmark-data/prepared',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`${arg} requires a value`);
      return v;
    };
    if (arg === '--seed') opts.seed = Number(next());
    else if (arg === '--subset') {
      const v = next();
      opts.subset = v === 'all' ? Infinity : Number(v);
    } else if (arg === '--repo-dir') opts.repoDir = next();
    else if (arg === '--queries') opts.queries = next();
    else if (arg === '--corpus-dir') opts.corpusDir = next();
    else if (arg === '--out-dir') opts.outDir = next();
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/prepare-browsecomp-plus.mjs [--seed 42] [--subset 100|all]\n' +
        '  [--repo-dir benchmark-data/BrowseComp-Plus] [--queries benchmark-data/raw/queries.json]\n' +
        '  [--corpus-dir benchmark-data/raw/corpus] [--out-dir benchmark-data/prepared]\n'
      );
      process.exit(0);
    } else fail(`Unknown option: ${arg}`);
  }
  expect(Number.isInteger(opts.seed), '--seed must be an integer');
  expect(opts.subset === Infinity || (Number.isInteger(opts.subset) && opts.subset > 0), '--subset must be a positive integer or "all"');
  return opts;
}

function gitCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function listParquetFiles(corpusDir) {
  const dataDir = join(corpusDir, 'data');
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter(f => f.endsWith('.parquet'))
    .sort()
    .map(f => ({
      name: f,
      bytes: statSync(join(dataDir, f)).size,
    }));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoDir = resolve(opts.repoDir);
  const queriesPath = resolve(opts.queries);
  const corpusDir = resolve(opts.corpusDir);
  const outDir = resolve(opts.outDir);

  expect(existsSync(queriesPath), `Queries file not found: ${queriesPath}`);
  const evidencePath = join(repoDir, 'topics-qrels', 'qrel_evidence.txt');
  const goldPath = join(repoDir, 'topics-qrels', 'qrel_golds.txt');
  expect(existsSync(evidencePath), `Evidence qrels not found: ${evidencePath}`);
  expect(existsSync(goldPath), `Gold qrels not found: ${goldPath}`);

  const allQueries = JSON.parse(readFileSync(queriesPath, 'utf8'));
  expect(Array.isArray(allQueries) && allQueries.length > 0, 'queries.json must be a non-empty array');

  const evidenceRaw = readFileSync(evidencePath, 'utf8');
  const goldRaw = readFileSync(goldPath, 'utf8');
  const evidence = parseTrecQrels(evidenceRaw);
  const gold = parseTrecQrels(goldRaw);

  const selected = selectQuerySubset(allQueries, opts.subset, opts.seed);
  const selectedIds = selected.map(q => String(q.query_id));
  const tag = opts.subset === Infinity || opts.subset >= allQueries.length ? `all-${selected.length}` : String(selected.length);

  const evFiltered = formatFilteredQrels(evidence.qrels, selectedIds);
  const goldFiltered = formatFilteredQrels(gold.qrels, selectedIds);

  mkdirSync(outDir, { recursive: true });
  const queriesOut = join(outDir, `queries-${tag}.json`);
  const evidenceOut = join(outDir, `qrel_evidence-${tag}.txt`);
  const goldOut = join(outDir, `qrel_golds-${tag}.txt`);
  const manifestOut = join(outDir, `manifest-${tag}.json`);

  writeFileSync(queriesOut, `${JSON.stringify(selected, null, 2)}\n`);
  writeFileSync(evidenceOut, evFiltered.text);
  writeFileSync(goldOut, goldFiltered.text);

  const manifest = {
    benchmark: 'BrowseComp-Plus (Chen et al., 2026)',
    paper: 'https://aclanthology.org/2026.acl-long.1023/',
    repository: {
      url: 'https://github.com/texttron/BrowseComp-Plus',
      commit: gitCommit(repoDir),
    },
    datasets: {
      queries: 'https://huggingface.co/datasets/Tevatron/browsecomp-plus (split=test, decrypted with official canary)',
      corpus: 'https://huggingface.co/datasets/Tevatron/browsecomp-plus-corpus (split=train)',
      corpusShards: listParquetFiles(corpusDir),
    },
    qrels: {
      evidenceFile: 'topics-qrels/qrel_evidence.txt',
      evidenceSha256: sha256(evidenceRaw),
      evidenceTotalLines: evidence.lineCount,
      evidenceTotalQueries: evidence.qrels.size,
      goldFile: 'topics-qrels/qrel_golds.txt',
      goldSha256: sha256(goldRaw),
      goldTotalLines: gold.lineCount,
      goldTotalQueries: gold.qrels.size,
    },
    selection: {
      method: 'Deterministic seeded Fisher-Yates sample (Mulberry32) over numerically sorted query IDs',
      seed: opts.seed,
      requestedCount: opts.subset === Infinity ? 'all' : opts.subset,
      totalAvailableQueries: allQueries.length,
      selectedQueryCount: selected.length,
      selectedEvidenceQrelPairs: evFiltered.pairCount,
      selectedGoldQrelPairs: goldFiltered.pairCount,
      selectedQueryIds: selectedIds,
    },
    outputs: {
      queries: queriesOut,
      evidenceQrels: evidenceOut,
      goldQrels: goldOut,
    },
    preparedAt: new Date().toISOString(),
  };

  writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write([
    `BrowseComp-Plus preparation complete (subset=${tag}, seed=${opts.seed})`,
    `Repo commit: ${manifest.repository.commit}`,
    `Total queries: ${allQueries.length} -> Selected: ${selected.length}`,
    `Evidence qrels: ${evidence.lineCount} total -> ${evFiltered.pairCount} selected`,
    `Gold qrels: ${gold.lineCount} total -> ${goldFiltered.pairCount} selected`,
    `Outputs written to: ${outDir}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main();
}
