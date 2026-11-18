#!/usr/bin/env node
/**
 * Reproduce the classic CISI human-judged retrieval benchmark for
 * `scripts/evaluate.ts` without adding dependencies.
 *
 * Source: the canonical Glasgow IDOM CISI archive
 *   https://ir.dcs.gla.ac.uk/resources/test_collections/cisi/
 *   https://ir.dcs.gla.ac.uk/resources/test_collections/cisi/cisi.tar.gz
 *
 * ir_datasets note: CISI is not part of ir_datasets 0.6.3 or its master tree
 * (checked the PyPI wheel, the repository tree, and https://ir-datasets.com/cisi.html,
 * which returns 404). The Glasgow archive is the public upstream source that
 * CISI dataset descriptions cite, so this script uses it and records the
 * mismatch rather than silently substituting a third-party CSV copy.
 *
 * What this script establishes:
 * - one document per passage (CISI has document-level judgments only);
 * - the native judged query set: the 76 queries that actually have qrels;
 * - the classic CISI qrels are binary in practice: the four-column all-zero
 *   layout lists relevant query/document pairs, not graded relevance. Presence
 *   is mapped to grade 1. No grades are invented and no unlisted passage is
 *   labelled "irrelevant" by a human;
 * - exact-body aliases are removed before scoring. An alias qrel is remapped to
 *   the retained canonical document only when it is not already present; a
 *   conflicting label aborts. Nothing is silently dropped or folded;
 * - the retained query set contains no zero-positive qrel query;
 * - the 36 native queries with no judgments are excluded and listed, and the
 *   unjudged documents remain in the corpus (the evaluator treats them as 0).
 *
 * The output dataset contains source text. Do not redistribute it unless the
 * source licensing is clear. The optional manifest contains provenance and
 * counts only; it is the safe artifact to keep with evaluation results.
 *
 * Usage:
 *   node scripts/prepare-cisi.mjs [--archive <cisi.tar.gz> | --dir <extracted>]
 *     [--out <dataset.json|->] [--manifest <manifest.json>]
 *     [--allow-different-source] [--force-download]
 *
 * With no input option the archive is downloaded once to the system temp
 * directory, bounded by timeout and byte count, and reused only if its SHA-256
 * matches the observed canonical archive. `--dir` expects CISI.ALL, CISI.QRY
 * and CISI.REL (case-insensitive) from that archive.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SOURCE_PAGE = 'https://ir.dcs.gla.ac.uk/resources/test_collections/cisi/';
const SOURCE_URL = 'https://ir.dcs.gla.ac.uk/resources/test_collections/cisi/cisi.tar.gz';
const SOURCE_ARCHIVE_SHA256 = 'bddb284e19369d153dad90770ae897e19221b0bc50e1329b5a702aa56f5e8483';
const SOURCE_FILE_SHA256 = {
  'CISI.ALL': 'df5af339fa4623ef33e315f39f3e13c050d17535c18360c727bf3c96ce60ba40',
  'CISI.QRY': 'a5ffad2b39445ca5f4091351466b3d70dad9b4eb9a713b8334d46abb291ffd3c',
  'CISI.REL': 'deb203a0dc07628d14dbcbc9a9803bf3c1f86e855570edb29d907663de8d6ea9',
};
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_TAR_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const USER_AGENT = 'pi-research-cisi-eval/0.1 (coursework evaluation; local use)';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const expect = (condition, message) => { if (!condition) fail(message); };
const numericCompare = (a, b) => Number(a) - Number(b);

function parseArgs(argv) {
  const options = {
    archive: undefined,
    dir: undefined,
    out: join(tmpdir(), 'cisi-dataset.json'),
    manifest: undefined,
    allowDifferentSource: false,
    forceDownload: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) fail(`${arg} requires a value`);
      return next;
    };
    if (arg === '--archive') options.archive = value();
    else if (arg === '--dir') options.dir = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--manifest') options.manifest = value();
    else if (arg === '--allow-different-source') options.allowDifferentSource = true;
    else if (arg === '--force-download') options.forceDownload = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node scripts/prepare-cisi.mjs ' +
        '[--archive <cisi.tar.gz> | --dir <extracted>] [--out <dataset.json|->] ' +
        '[--manifest <manifest.json>] [--allow-different-source] [--force-download]\n');
      process.exit(0);
    } else fail(`Unknown option ${JSON.stringify(arg)}; use --help`);
  }
  if (options.archive && options.dir) fail('Use --archive or --dir, not both');
  return options;
}

/** One bounded HTTPS GET. `fetch` is avoided because it transparently decodes
 * `Content-Encoding: gzip`, which would change the exact archive bytes/hash. */
function getBytes(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, {
      headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' },
      timeout: DOWNLOAD_TIMEOUT_MS,
    }, response => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectsLeft <= 0) { reject(new Error(`Too many redirects for ${url}`)); return; }
        const next = new URL(location, url);
        if (next.protocol !== 'https:') { reject(new Error(`Refusing non-HTTPS redirect ${next.href}`)); return; }
        getBytes(next.href, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`GET ${url} returned HTTP ${status}`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_ARCHIVE_BYTES) {
          response.destroy(new Error(
            `GET ${url} exceeded the ${MAX_ARCHIVE_BYTES}-byte cap; refusing to continue`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        bytes: Buffer.concat(chunks),
        finalUrl: url,
        contentType: response.headers['content-type'],
      }));
      response.on('error', reject);
    });
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error(`GET ${url} timed out after ${DOWNLOAD_TIMEOUT_MS} ms`));
    });
    request.on('error', reject);
  });
}

async function downloadArchive(destination) {
  const result = await getBytes(SOURCE_URL);
  const bytes = result.bytes;
  expect(bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b,
    'Downloaded source is not gzip data');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  return { ...result, bytes };
}

function cString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

function octal(buffer, offset, length) {
  const value = cString(buffer, offset, length);
  if (!value) return 0;
  expect(/^[0-7]+$/.test(value), `Invalid tar octal field ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

function extractTarGz(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    expect(dataEnd <= tar.length, `Tar entry ${path} runs past the archive end`);
    if (type === '0' || type === '\0') files.set(path, tar.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function findFile(files, wanted) {
  const matches = [...files.keys()].filter(path => basename(path).toLowerCase() === wanted.toLowerCase());
  expect(matches.length === 1, `Expected exactly one ${wanted} in the archive, found ${matches.length}`);
  return files.get(matches[0]);
}

function readExtracted(dir) {
  const entries = readdirSync(dir);
  const byName = new Map(entries.map(name => [name.toLowerCase(), name]));
  const read = wanted => {
    const actual = byName.get(wanted.toLowerCase());
    expect(actual, `${dir} is missing ${wanted}`);
    const path = join(dir, actual);
    expect(statSync(path).isFile(), `${path} is not a regular file`);
    return readFileSync(path);
  };
  return { 'CISI.ALL': read('CISI.ALL'), 'CISI.QRY': read('CISI.QRY'), 'CISI.REL': read('CISI.REL') };
}

const FIELD = /^\.([A-Z])(?:[ \t]+(.*))?$/;

/** Parse CISI's `.I`-delimited records, preserving field lines and line structure. */
function parseRecords(text, label) {
  const records = [];
  const preamble = [];
  let current = null;
  let field = undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const [index, line] of lines.entries()) {
    const marker = FIELD.exec(line);
    if (marker && marker[1] === 'I') {
      if (current) records.push(current);
      const id = (marker[2] ?? '').trim();
      current = { id, fields: Object.create(null), line: index + 1 };
      field = 'I';
      continue;
    }
    if (!current) {
      if (line.trim()) preamble.push(`${index + 1}: ${line}`);
      continue;
    }
    if (marker) {
      field = marker[1];
      const inline = marker[2];
      if (inline !== undefined && inline !== '') (current.fields[field] ??= []).push(inline);
      else current.fields[field] ??= [];
    } else if (field !== undefined) {
      (current.fields[field] ??= []).push(line);
    }
  }
  if (current) records.push(current);
  if (preamble.length) fail(`${label} has text before the first .I record: ${preamble[0]}`);
  return records;
}

function fieldText(record, field) {
  return (record.fields[field] ?? []).join('\n').trim();
}

function canonicalId(raw, label, source) {
  const value = String(raw).trim();
  expect(/^\d+$/.test(value), `${label} in ${source} is not a decimal ID: ${JSON.stringify(raw)}`);
  const number = Number(value);
  expect(Number.isSafeInteger(number) && number >= 1,
    `${label} in ${source} is outside the safe positive integer range: ${JSON.stringify(raw)}`);
  return String(number);
}

function parseDocuments(bytes) {
  const records = parseRecords(bytes.toString('utf8'), 'CISI.ALL');
  const documents = new Map();
  for (const record of records) {
    const id = canonicalId(record.id, 'document id', 'CISI.ALL');
    expect(!documents.has(id), `CISI.ALL repeats document id ${id}`);
    const title = fieldText(record, 'T');
    const abstract = fieldText(record, 'W');
    expect(title, `CISI.ALL document ${id} has no .T title`);
    expect(abstract, `CISI.ALL document ${id} has no .W abstract`);
    // One document = one passage. Keep internal line breaks (some CISI records
    // differ only in line wrapping; collapsing whitespace would create aliases).
    documents.set(id, `${title}\n${abstract}`);
  }
  expect(documents.size > 0, 'CISI.ALL contains no documents');
  return documents;
}

function parseQueries(bytes) {
  const records = parseRecords(bytes.toString('utf8'), 'CISI.QRY');
  const queries = new Map();
  for (const record of records) {
    const id = canonicalId(record.id, 'query id', 'CISI.QRY');
    expect(!queries.has(id), `CISI.QRY repeats query id ${id}`);
    const text = fieldText(record, 'W').replace(/\s+/g, ' ').trim();
    expect(text, `CISI.QRY query ${id} has no .W text`);
    queries.set(id, text);
  }
  expect(queries.size > 0, 'CISI.QRY contains no queries');
  return queries;
}

/**
 * Parse the Glasgow CISI.REL layout. It has four columns
 * `query document 0 0.000000`; every line is a relevant pair, and the zeros are
 * placeholders. A plain three-column graded qrels file is also accepted, but a
 * four-column file with nonzero relevance/score columns is refused instead of
 * guessed.
 */
function parseQrels(bytes) {
  const lines = bytes.toString('utf8').replace(/\r\n?/g, '\n').split('\n');
  let format;
  const pairs = new Map();
  let lineCount = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    lineCount++;
    const columns = line.trim().split(/\s+/);
    let query;
    let document;
    let grade;
    if (columns.length === 4) {
      if (format === undefined) format = 'glasgow-presence-4col';
      expect(format === 'glasgow-presence-4col',
        `CISI.REL mixes four-column and three-column lines at line ${index + 1}`);
      const [qid, did, relevance, score] = columns;
      expect(relevance === '0' && Number(score) === 0,
        `CISI.REL line ${index + 1} has nonzero placeholder columns (${relevance}, ${score}); ` +
        'this script only understands the Glasgow all-zero layout and will not invent grades');
      query = canonicalId(qid, 'query id', 'CISI.REL');
      document = canonicalId(did, 'document id', 'CISI.REL');
      // In the Glasgow file, appearing at all is the binary relevance judgment.
      grade = 1;
    } else if (columns.length === 3) {
      if (format === undefined) format = 'trec-3col';
      expect(format === 'trec-3col',
        `CISI.REL mixes four-column and three-column lines at line ${index + 1}`);
      query = canonicalId(columns[0], 'query id', 'CISI.REL');
      document = canonicalId(columns[1], 'document id', 'CISI.REL');
      grade = Number(columns[2]);
      expect(Number.isInteger(grade) && grade >= 0 && grade <= 3,
        `CISI.REL line ${index + 1} has an invalid grade ${JSON.stringify(columns[2])}`);
    } else {
      fail(`CISI.REL line ${index + 1} has ${columns.length} columns; expected 3 or 4`);
    }
    if (!pairs.has(query)) pairs.set(query, new Map());
    const queryPairs = pairs.get(query);
    expect(!queryPairs.has(document),
      `CISI.REL repeats the pair query ${query}, document ${document}`);
    queryPairs.set(document, grade);
  }
  expect(lineCount > 0, 'CISI.REL contains no judgments');
  expect(format, 'CISI.REL contains no parsable judgments');
  return { pairs, format, lineCount };
}

function qrelCount(pairs) {
  let count = 0;
  for (const queryPairs of pairs.values()) count += queryPairs.size;
  return count;
}

async function main(options) {
  let archiveBytes;
  let archiveDescription;
  let sourceFiles;

  if (options.dir) {
    const dir = resolve(options.dir);
    expect(existsSync(dir), `--dir path does not exist: ${dir}`);
    sourceFiles = readExtracted(dir);
    archiveDescription = `extracted files from ${dir}`;
    archiveBytes = undefined;
  } else {
    const archivePath = options.archive
      ? resolve(options.archive)
      : join(tmpdir(), 'cisi.tar.gz');
    let downloaded = false;
    if (options.archive && existsSync(archivePath) && !options.forceDownload) {
      archiveBytes = readFileSync(archivePath);
      archiveDescription = archivePath;
    } else if (!options.archive && existsSync(archivePath) && !options.forceDownload) {
      const cached = readFileSync(archivePath);
      if (sha256(cached) === SOURCE_ARCHIVE_SHA256) {
        archiveBytes = cached;
        archiveDescription = archivePath;
      }
    }
    if (!archiveBytes) {
      const result = await downloadArchive(archivePath);
      archiveBytes = result.bytes;
      archiveDescription = `${archivePath} (GET ${result.finalUrl}${result.contentType ? `, ${result.contentType}` : ''})`;
      downloaded = true;
    }
    const archiveHash = sha256(archiveBytes);
    if (archiveHash !== SOURCE_ARCHIVE_SHA256 && !options.allowDifferentSource) {
      fail(`Archive SHA-256 ${archiveHash} does not match the recorded Glasgow archive ` +
        `${SOURCE_ARCHIVE_SHA256}. Re-check the exact source, or pass ` +
        '--allow-different-source to accept a different archive explicitly.');
    }
    const files = extractTarGz(archiveBytes);
    sourceFiles = {
      'CISI.ALL': findFile(files, 'CISI.ALL'),
      'CISI.QRY': findFile(files, 'CISI.QRY'),
      'CISI.REL': findFile(files, 'CISI.REL'),
    };
    if (downloaded) process.stderr.write(`Downloaded ${SOURCE_URL}\n`);
  }

  const fileHashes = {};
  for (const [name, bytes] of Object.entries(sourceFiles)) {
    fileHashes[name] = { sha256: sha256(bytes), bytes: bytes.length };
    const recorded = SOURCE_FILE_SHA256[name];
    if (recorded && fileHashes[name].sha256 !== recorded && !options.allowDifferentSource) {
      fail(`${name} SHA-256 ${fileHashes[name].sha256} does not match the recorded Glasgow file ` +
        `${recorded}. Re-check the exact source, or pass --allow-different-source explicitly.`);
    }
  }
  if (archiveBytes) fileHashes.archive = { sha256: sha256(archiveBytes), bytes: archiveBytes.length };

  const documents = parseDocuments(sourceFiles['CISI.ALL']);
  const queries = parseQueries(sourceFiles['CISI.QRY']);
  const { pairs, format, lineCount } = parseQrels(sourceFiles['CISI.REL']);
  const nativeDocumentCount = documents.size;
  const nativeQueryCount = queries.size;
  const nativePairCount = qrelCount(pairs);

  // Every native judgment must point at a real document and query. Never drop an
  // unresolvable judgment silently; report the first broken references and abort.
  const missingQueries = [...pairs.keys()].filter(qid => !queries.has(qid)).sort(numericCompare);
  const missingDocuments = [];
  for (const [qid, queryPairs] of pairs) {
    for (const did of queryPairs.keys()) if (!documents.has(did)) missingDocuments.push(`${qid}:${did}`);
  }
  expect(missingQueries.length === 0,
    `CISI.REL references queries absent from CISI.QRY: ${missingQueries.slice(0, 10).join(', ')}`);
  expect(missingDocuments.length === 0,
    `CISI.REL references documents absent from CISI.ALL: ${missingDocuments.slice(0, 10).join(', ')}`);

  // Remove exact-body aliases before scoring. The evaluator refuses a corpus
  // whose index folds aliases; we retain the lowest numeric id and explicitly
  // account for every alias judgment.
  const byText = new Map();
  for (const [id, text] of documents) {
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(id);
  }
  const aliasDocuments = [];
  const excluded = new Map();
  for (const ids of byText.values()) {
    if (ids.length < 2) continue;
    ids.sort(numericCompare);
    const canonical = ids[0];
    for (const alias of ids.slice(1)) {
      excluded.set(alias, canonical);
      aliasDocuments.push({ id: alias, canonical, reason: 'exact body text' });
    }
  }

  let aliasQrelsRemapped = 0;
  let aliasQrelsDeduplicated = 0;
  const aliasQrelDetails = [];
  for (const alias of [...excluded.keys()].sort(numericCompare)) {
    const canonical = excluded.get(alias);
    for (const [qid, queryPairs] of pairs) {
      if (!queryPairs.has(alias)) continue;
      const grade = queryPairs.get(alias);
      if (queryPairs.has(canonical)) {
        expect(queryPairs.get(canonical) === grade,
          `Exact alias ${alias}->${canonical} has conflicting grades for query ${qid} ` +
          `(${queryPairs.get(canonical)} vs ${grade}); refusing to guess`);
        queryPairs.delete(alias);
        aliasQrelsDeduplicated++;
        aliasQrelDetails.push({ query: qid, alias, canonical, disposition: 'deduplicated', grade });
      } else {
        queryPairs.set(canonical, grade);
        queryPairs.delete(alias);
        aliasQrelsRemapped++;
        aliasQrelDetails.push({ query: qid, alias, canonical, disposition: 'remapped', grade });
      }
    }
    documents.delete(alias);
  }

  // Re-check every judgment after alias handling. Nothing may point at a
  // removed document, and no selected query may lose all of its positives.
  const dangling = [];
  for (const [qid, queryPairs] of pairs) {
    for (const did of queryPairs.keys()) if (!documents.has(did)) dangling.push(`${qid}:${did}`);
  }
  expect(dangling.length === 0,
    `Alias handling left judgments for removed documents: ${dangling.slice(0, 10).join(', ')}`);

  // Refuse to emit a corpus that the evaluator would reject as aliased.
  const retainedBodies = new Map();
  for (const [id, text] of documents) {
    expect(!retainedBodies.has(text), `Retained corpus still has exact aliases: ${retainedBodies.get(text)} and ${id}`);
    retainedBodies.set(text, id);
  }

  const judgedQueryIds = [...pairs.keys()]
    .filter(qid => (pairs.get(qid)?.size ?? 0) > 0)
    .sort(numericCompare);
  const zeroPositive = judgedQueryIds.filter(qid => ![...pairs.get(qid).values()].some(grade => grade > 0));
  expect(zeroPositive.length === 0,
    `Judged queries have no positive grade after preparation: ${zeroPositive.join(', ')}`);
  expect(judgedQueryIds.length > 0, 'No judged queries remain');
  const unjudgedQueryIds = [...queries.keys()]
    .filter(qid => !pairs.has(qid))
    .sort(numericCompare);

  const passages = [...documents.entries()]
    .sort(([left], [right]) => numericCompare(left, right))
    .map(([id, text]) => ({
      id,
      snapshotId: 'cisi:glasgow',
      start: 0,
      end: text.length,
      text,
    }));
  const judgedQueries = judgedQueryIds.map(id => {
    const judgments = {};
    for (const did of [...pairs.get(id).keys()].sort(numericCompare)) judgments[did] = pairs.get(id).get(did);
    return { id, text: queries.get(id), judgments };
  });
  const dataset = { passages, queries: judgedQueries };
  const datasetJson = `${JSON.stringify(dataset, null, 2)}\n`;
  const datasetHash = sha256(datasetJson);

  const retainedPairCount = qrelCount(pairs);
  const manifest = {
    source: {
      name: 'CISI (Centre for Inventions and Scientific Information)',
      page: SOURCE_PAGE,
      archive: SOURCE_URL,
      archiveInput: archiveDescription,
      archiveSha256: archiveBytes ? sha256(archiveBytes) : null,
      expectedArchiveSha256: SOURCE_ARCHIVE_SHA256,
      files: fileHashes,
      downloadMethod: {
        method: 'bounded HTTPS GET via node:https; transparent fetch decoding is avoided so the ' +
          'archive bytes and SHA-256 are exact',
        maxBytes: MAX_ARCHIVE_BYTES,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        redirects: 3,
        userAgent: USER_AGENT,
      },
      irDatasets: 'CISI is absent from ir_datasets 0.4.0, 0.5.5, 0.5.11 and 0.6.3 ' +
        '(PyPI wheels checked) and from the master tree; https://ir-datasets.com/cisi.html ' +
        'returns HTTP 404. The Glasgow IDOM archive is the public upstream source named by ' +
        'CISI dataset descriptions.',
      license: 'No license is asserted here. The Glasgow page does not state one; do not ' +
        'redistribute the corpus without checking.',
      retrievedAt: new Date().toISOString(),
    },
    dataset: {
      path: options.out === '-' ? 'stdout' : resolve(options.out),
      sha256: datasetHash,
    },
    counts: {
      nativeDocuments: nativeDocumentCount,
      retainedDocuments: documents.size,
      exactAliasDocumentsExcluded: aliasDocuments.length,
      nativeQueries: nativeQueryCount,
      judgedQueriesUsed: judgedQueryIds.length,
      unjudgedQueriesExcluded: unjudgedQueryIds.length,
      nativeQrelLines: lineCount,
      nativeQrelPairs: nativePairCount,
      retainedQrelPairs: retainedPairCount,
      aliasQrelsRemapped,
      aliasQrelsDeduplicated,
      positiveJudgments: retainedPairCount,
    },
    labelMapping: {
      qrelsFormat: format,
      mapping: format === 'glasgow-presence-4col'
        ? 'The Glasgow CISI.REL four-column layout lists relevant query/document pairs; ' +
          'the third and fourth columns are all zero placeholders. Presence is mapped to grade 1. ' +
          'No graded or negative human labels are invented.'
        : 'Three-column qrels grades were retained as supplied (0..3).',
      unlisted: 'Documents not listed for a query are treated by the evaluator as grade 0. ' +
        'That is a benchmark convention, not a human judgment that they are irrelevant.',
    },
    proxy: 'One CISI document is one evaluator passage. The human judgments are document-level; ' +
      'these are document retrieval metrics used as a document-level proxy, not passage-label ' +
      'judgments or conversational evaluation.',
    exclusions: {
      unjudgedQueryIds,
      aliasDocuments,
      aliasQrels: aliasQrelDetails,
    },
    warnings: [
      'The CISI source text is not redistributed by this manifest; the dataset output contains it.',
      'Do not publish the dataset unless the source licensing is clear.',
      'This is a classic test collection, not a frozen corpus produced by the live Pi system.',
    ],
  };

  if (options.manifest) {
    mkdirSync(dirname(resolve(options.manifest)), { recursive: true });
    writeFileSync(resolve(options.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (options.out === '-') {
    process.stdout.write(datasetJson);
    process.stderr.write(JSON.stringify(manifest, null, 2) + '\n');
  } else {
    const output = resolve(options.out);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, datasetJson);
    process.stdout.write([
      `Source: ${SOURCE_PAGE}`,
      `Archive: ${SOURCE_URL}`,
      archiveBytes ? `Archive SHA-256: ${sha256(archiveBytes)}` : 'Archive SHA-256: n/a (extracted files)',
      ...Object.entries(sourceFiles).map(([name, bytes]) =>
        `${name}: ${bytes.length} bytes, SHA-256 ${sha256(bytes)}`),
      '',
      `Documents: ${nativeDocumentCount} native, ${documents.size} retained, ` +
        `${aliasDocuments.length} exact alias(es) excluded`,
      `Queries: ${nativeQueryCount} native, ${judgedQueryIds.length} judged used, ` +
        `${unjudgedQueryIds.length} unjudged excluded (${unjudgedQueryIds.join(', ')})`,
      `Qrels: ${nativePairCount} native pairs, ${retainedPairCount} retained ` +
        `(${aliasQrelsRemapped} alias pair(s) remapped, ${aliasQrelsDeduplicated} deduplicated)`,
      `Labels: ${format}; binary presence mapped to grade 1`,
      `Dataset: ${output}`,
      `Dataset SHA-256: ${datasetHash}`,
      '',
      `Next: npm run --silent evaluate -- ${output}`,
      '',
    ].join('\n'));
  }
}

try {
  await main(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
