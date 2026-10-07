import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Branch, Concept, Contribution, Feedback, Investigation, Objective, Passage, Report, Snapshot, SourceCandidate, Span } from './types.js';

/**
 * Immutable storage: deduplicated content-addressed blobs, snapshot records keyed by an
 * acquisition-chosen SHA id, and validation of the active-path investigation manifest.
 * Blobs are written before snapshot manifests; corpus membership comes only from a
 * manifest's snapshotIds, never from scanning the store.
 */

const STATE_TYPE = 'pi-research/state';
const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ACTION_KINDS = ['retrieve', 'fetch', 'search'] as const;

/** Scalar/field length bounds. Generous defensive limits, not design targets. */
const LIMIT = {
  id: 256, url: 8192, time: 64, root: 4096, title: 4000, short: 4000,
  question: 16_000, prose: 16_000, snippet: 16_000, input: 100_000,
  passage: 400_000, statement: 400_000, markdown: 4_000_000, extracted: 16_000_000,
} as const;
/** Collection-size bounds for persisted manifests. */
const COUNT = {
  constraints: 10_000, objectives: 10_000, branches: 100_000, needs: 10_000, spans: 10_000,
  aliases: 10_000, queries: 10_000, candidates: 1_000_000, snapshotIds: 1_000_000,
  passages: 1_000_000, concepts: 100_000, contributions: 1_000_000, actions: 100_000,
  feedback: 100_000, reports: 10_000, sections: 10_000, statements: 100_000, citations: 10_000,
  candidateIds: 10_000, lists: 10_000, pages: 100_000, unresolved: 100_000, changes: 100_000,
} as const;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`);
  return value as Record<string, unknown>;
};

const list = (value: unknown, path: string, max: number): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array`);
  if (value.length > max) throw new Error(`${path}: exceeds ${max} entries`);
  return value;
};

/** Control-free metadata string; empty only when explicitly allowed. */
const str = (value: unknown, path: string, max: number, allowEmpty = false): string => {
  if (typeof value !== 'string') throw new Error(`${path}: expected a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`${path}: must not be empty`);
  if (value.length > max) throw new Error(`${path}: exceeds ${max} characters`);
  if (CONTROL.test(value)) throw new Error(`${path}: contains control characters`);
  return value;
};

/** Source/user-derived text; extracted bodies may legally contain control characters. */
const body = (value: unknown, path: string, max: number, allowEmpty = true): string => {
  if (typeof value !== 'string') throw new Error(`${path}: expected a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`${path}: must not be empty`);
  if (value.length > max) throw new Error(`${path}: exceeds ${max} characters`);
  return value;
};

const finite = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path}: expected a finite number`);
  return value;
};

const nonNegative = (value: unknown, path: string): number => {
  const n = finite(value, path);
  if (n < 0) throw new Error(`${path}: must not be negative`);
  return n;
};

const integer = (value: unknown, path: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path}: expected an integer between ${min} and ${max}`);
  }
  return value;
};

const choice = <T extends string>(value: unknown, path: string, allowed: readonly T[]): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${path}: expected ${allowed.join(' | ')}`);
  return value as T;
};

const time = (value: unknown, path: string): string => {
  const s = str(value, path, LIMIT.time);
  if (Number.isNaN(Date.parse(s))) throw new Error(`${path}: not a parseable timestamp`);
  return s;
};

/** Snapshot URLs stay byte-exact; only scheme and credential-free authority are enforced. */
const httpUrl = (value: unknown, path: string): string => {
  const s = str(value, path, LIMIT.url);
  let parsed: URL;
  try { parsed = new URL(s); } catch { throw new Error(`${path}: not an absolute URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${path}: only http(s) URLs may be stored`);
  if (parsed.username || parsed.password) throw new Error(`${path}: URL must not carry credentials`);
  return s;
};

const sha256Id = (value: unknown, path: string): string => {
  const s = str(value, path, 64);
  if (!SHA256.test(s)) throw new Error(`${path}: expected a lowercase SHA-256 hex digest`);
  return s;
};

const digest = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => deepEqual(left[key], right[key]));
  }
  return false;
};

const readBytes = (path: string, what: string): Buffer => {
  try { return readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${what} is missing (${path})`);
    throw new Error(`${what} cannot be read: ${message(error)}`, { cause: error });
  }
};

/** Exclusive create via hard link; a crash leaves only an unreferenced temp file. */
const createFile = (path: string, bytes: Buffer): 'created' | 'exists' => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, bytes);
  try {
    linkSync(temp, path);
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw new Error(`cannot write ${path}: ${message(error)}`, { cause: error });
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best-effort temp cleanup */ }
  }
};

// ---------------------------------------------------------------- manifest records

const spanOf = (raw: unknown, path: string): Span => {
  const v = object(raw, path);
  const start = integer(v.start, `${path}.start`, 0, Number.MAX_SAFE_INTEGER);
  const end = integer(v.end, `${path}.end`, 0, Number.MAX_SAFE_INTEGER);
  if (end <= start) throw new Error(`${path}: span end must exceed span start`);
  return { passageId: str(v.passageId, `${path}.passageId`, LIMIT.id), start, end };
};

const objective = (raw: unknown, path: string): Objective => {
  const v = object(raw, path);
  const result: Objective = {
    id: str(v.id, `${path}.id`, LIMIT.id),
    input: body(v.input, `${path}.input`, LIMIT.input),
    question: str(v.question, `${path}.question`, LIMIT.question),
    constraints: list(v.constraints, `${path}.constraints`, COUNT.constraints)
      .map((c, i) => str(c, `${path}.constraints[${i}]`, LIMIT.short, true)),
    createdAt: time(v.createdAt, `${path}.createdAt`),
  };
  if (v.parentId !== undefined) result.parentId = str(v.parentId, `${path}.parentId`, LIMIT.id);
  return result;
};

const branch = (raw: unknown, path: string): Branch => {
  const v = object(raw, path);
  const stats: Branch['stats'] = {};
  const rawStats = object(v.stats, `${path}.stats`);
  for (const key of Object.keys(rawStats)) {
    if (!(ACTION_KINDS as readonly string[]).includes(key)) throw new Error(`${path}.stats: unknown action kind "${key}"`);
    const s = object(rawStats[key], `${path}.stats.${key}`);
    stats[key as (typeof ACTION_KINDS)[number]] = {
      completed: integer(s.completed, `${path}.stats.${key}.completed`, 0, Number.MAX_SAFE_INTEGER),
      successful: integer(s.successful, `${path}.stats.${key}.successful`, 0, Number.MAX_SAFE_INTEGER),
    };
  }
  const result: Branch = {
    id: str(v.id, `${path}.id`, LIMIT.id),
    objectiveId: str(v.objectiveId, `${path}.objectiveId`, LIMIT.id),
    question: str(v.question, `${path}.question`, LIMIT.question),
    anchor: str(v.anchor, `${path}.anchor`, LIMIT.short, true),
    origin: choice(v.origin, `${path}.origin`, ['initial', 'evidence'] as const),
    introducing: list(v.introducing, `${path}.introducing`, COUNT.spans).map((s, i) => spanOf(s, `${path}.introducing[${i}]`)),
    priority: nonNegative(v.priority, `${path}.priority`),
    status: choice(v.status, `${path}.status`, ['active', 'cooldown', 'backlog', 'rejected', 'archived'] as const),
    needs: list(v.needs, `${path}.needs`, COUNT.needs).map((n, i) => {
      const need = object(n, `${path}.needs[${i}]`);
      const needStatus = need.status;
      if (needStatus !== 0 && needStatus !== 0.5 && needStatus !== 1) throw new Error(`${path}.needs[${i}].status: expected 0 | 0.5 | 1`);
      return {
        id: str(need.id, `${path}.needs[${i}].id`, LIMIT.id),
        question: str(need.question, `${path}.needs[${i}].question`, LIMIT.question),
        weight: nonNegative(need.weight, `${path}.needs[${i}].weight`),
        status: needStatus,
      };
    }),
    aliases: list(v.aliases, `${path}.aliases`, COUNT.aliases).map((a, i) => str(a, `${path}.aliases[${i}]`, LIMIT.short, true)),
    queries: list(v.queries, `${path}.queries`, COUNT.queries).map((q, i) => str(q, `${path}.queries[${i}]`, LIMIT.short, true)),
    zeroYieldEpisodes: integer(v.zeroYieldEpisodes, `${path}.zeroYieldEpisodes`, 0, Number.MAX_SAFE_INTEGER),
    stats,
  };
  if (v.parentId !== undefined) result.parentId = str(v.parentId, `${path}.parentId`, LIMIT.id);
  if (v.retrievalKey !== undefined) result.retrievalKey = str(v.retrievalKey, `${path}.retrievalKey`, LIMIT.short);
  if (v.nextAction !== undefined) {
    const n = object(v.nextAction, `${path}.nextAction`);
    result.nextAction = {
      kind: choice(n.kind, `${path}.nextAction.kind`, ACTION_KINDS),
      score: finite(n.score, `${path}.nextAction.score`),
      reason: str(n.reason, `${path}.nextAction.reason`, LIMIT.prose, true),
    };
  }
  return result;
};

const candidate = (raw: unknown, path: string): SourceCandidate => {
  const v = object(raw, path);
  const result: SourceCandidate = {
    id: str(v.id, `${path}.id`, LIMIT.id),
    branchId: str(v.branchId, `${path}.branchId`, LIMIT.id),
    query: str(v.query, `${path}.query`, LIMIT.short, true),
    url: httpUrl(v.url, `${path}.url`),
    title: str(v.title, `${path}.title`, LIMIT.title, true),
    snippet: body(v.snippet, `${path}.snippet`, LIMIT.snippet),
    provider: str(v.provider, `${path}.provider`, LIMIT.short, true),
    rankingKind: choice(v.rankingKind, `${path}.rankingKind`, ['ranked', 'citation-list', 'unknown'] as const),
    discoveredAt: time(v.discoveredAt, `${path}.discoveredAt`),
    status: choice(v.status, `${path}.status`, ['unread', 'fetched', 'blocked', 'failed'] as const),
  };
  if (v.rank !== undefined) result.rank = integer(v.rank, `${path}.rank`, 0, Number.MAX_SAFE_INTEGER);
  if (v.snapshotId !== undefined) result.snapshotId = sha256Id(v.snapshotId, `${path}.snapshotId`);
  if (v.error !== undefined) result.error = str(v.error, `${path}.error`, LIMIT.prose, true);
  return result;
};

const passage = (raw: unknown, path: string): Passage => {
  const v = object(raw, path);
  const start = integer(v.start, `${path}.start`, 0, Number.MAX_SAFE_INTEGER);
  const end = integer(v.end, `${path}.end`, 0, Number.MAX_SAFE_INTEGER);
  const text = body(v.text, `${path}.text`, LIMIT.passage, false);
  if (end <= start) throw new Error(`${path}: passage span is empty`);
  if (end - start !== text.length) throw new Error(`${path}: span ${start}-${end} does not match text length ${text.length}`);
  const result: Passage = {
    id: str(v.id, `${path}.id`, LIMIT.id),
    snapshotId: sha256Id(v.snapshotId, `${path}.snapshotId`),
    start, end, text,
    duplicateGroup: str(v.duplicateGroup, `${path}.duplicateGroup`, LIMIT.short),
  };
  if (v.section !== undefined) result.section = str(v.section, `${path}.section`, LIMIT.short, true);
  if (v.page !== undefined) result.page = integer(v.page, `${path}.page`, 1, 1_000_000);
  return result;
};

const concept = (raw: unknown, path: string): Concept => {
  const v = object(raw, path);
  const result: Concept = {
    id: str(v.id, `${path}.id`, LIMIT.id),
    branchId: str(v.branchId, `${path}.branchId`, LIMIT.id),
    term: str(v.term, `${path}.term`, LIMIT.short),
    score: finite(v.score, `${path}.score`),
    anchorRelevance: finite(v.anchorRelevance, `${path}.anchorRelevance`),
    introducing: list(v.introducing, `${path}.introducing`, COUNT.spans).map((s, i) => spanOf(s, `${path}.introducing[${i}]`)),
  };
  if (v.classification !== undefined) {
    result.classification = choice(v.classification, `${path}.classification`, ['alias', 'branch', 'boilerplate', 'tangent', 'unclear'] as const);
  }
  if (v.decision !== undefined) result.decision = str(v.decision, `${path}.decision`, LIMIT.prose, true);
  if (v.proposedQuestion !== undefined) result.proposedQuestion = str(v.proposedQuestion, `${path}.proposedQuestion`, LIMIT.question);
  if (v.admittedBranchId !== undefined) result.admittedBranchId = str(v.admittedBranchId, `${path}.admittedBranchId`, LIMIT.id);
  return result;
};

const contribution = (raw: unknown, path: string): Contribution => {
  const v = object(raw, path);
  return {
    objectiveId: str(v.objectiveId, `${path}.objectiveId`, LIMIT.id),
    branchId: str(v.branchId, `${path}.branchId`, LIMIT.id),
    needId: str(v.needId, `${path}.needId`, LIMIT.id),
    passageId: str(v.passageId, `${path}.passageId`, LIMIT.id),
    duplicateGroup: str(v.duplicateGroup, `${path}.duplicateGroup`, LIMIT.short),
    role: choice(v.role, `${path}.role`, ['support', 'qualification', 'contradiction'] as const),
    assessment: str(v.assessment, `${path}.assessment`, LIMIT.prose, true),
  };
};

const action = (raw: unknown, path: string): import('./types.js').Action => {
  const v = object(raw, path);
  const result: import('./types.js').Action = {
    id: str(v.id, `${path}.id`, LIMIT.id),
    objectiveId: str(v.objectiveId, `${path}.objectiveId`, LIMIT.id),
    branchId: str(v.branchId, `${path}.branchId`, LIMIT.id),
    kind: choice(v.kind, `${path}.kind`, ACTION_KINDS),
    score: finite(v.score, `${path}.score`),
    reason: str(v.reason, `${path}.reason`, LIMIT.prose, true),
    status: choice(v.status, `${path}.status`, ['running', 'completed', 'blocked', 'interrupted'] as const),
    startedAt: time(v.startedAt, `${path}.startedAt`),
    yield: nonNegative(v.yield, `${path}.yield`),
  };
  if (v.query !== undefined) result.query = str(v.query, `${path}.query`, LIMIT.short, true);
  if (v.candidateId !== undefined) result.candidateId = str(v.candidateId, `${path}.candidateId`, LIMIT.id);
  if (v.completedAt !== undefined) result.completedAt = time(v.completedAt, `${path}.completedAt`);
  if (v.error !== undefined) result.error = str(v.error, `${path}.error`, LIMIT.prose, true);
  if (v.candidateIds !== undefined) {
    result.candidateIds = list(v.candidateIds, `${path}.candidateIds`, COUNT.candidateIds)
      .map((c, i) => str(c, `${path}.candidateIds[${i}]`, LIMIT.id));
  }
  return result;
};

const feedback = (raw: unknown, path: string): Feedback => {
  const v = object(raw, path);
  return {
    id: str(v.id, `${path}.id`, LIMIT.id),
    targetId: str(v.targetId, `${path}.targetId`, LIMIT.id),
    kind: choice(v.kind, `${path}.kind`, ['useful', 'irrelevant', 'accept', 'reject', 'prioritize'] as const),
    createdAt: time(v.createdAt, `${path}.createdAt`),
  };
};

const report = (raw: unknown, path: string): Report => {
  const v = object(raw, path);
  if (typeof v.fallback !== 'boolean') throw new Error(`${path}.fallback: expected a boolean`);
  return {
    id: str(v.id, `${path}.id`, LIMIT.id),
    objectiveId: str(v.objectiveId, `${path}.objectiveId`, LIMIT.id),
    corpusRevision: integer(v.corpusRevision, `${path}.corpusRevision`, 0, Number.MAX_SAFE_INTEGER),
    createdAt: time(v.createdAt, `${path}.createdAt`),
    sections: list(v.sections, `${path}.sections`, COUNT.sections).map((s, i) => {
      const section = object(s, `${path}.sections[${i}]`);
      return {
        title: str(section.title, `${path}.sections[${i}].title`, LIMIT.title, true),
        statements: list(section.statements, `${path}.sections[${i}].statements`, COUNT.statements).map((st, j) => {
          const statementPath = `${path}.sections[${i}].statements[${j}]`;
          const statement = object(st, statementPath);
          const citations = list(statement.citations, `${statementPath}.citations`, COUNT.citations)
            .map((c, k) => spanOf(c, `${statementPath}.citations[${k}]`));
          if (citations.length === 0) throw new Error(`${statementPath}.citations: every statement must cite evidence`);
          return { text: body(statement.text, `${statementPath}.text`, LIMIT.statement, false), citations };
        }),
      };
    }),
    unresolved: list(v.unresolved, `${path}.unresolved`, COUNT.unresolved)
      .map((u, i) => str(u, `${path}.unresolved[${i}]`, LIMIT.prose, true)),
    changes: list(v.changes, `${path}.changes`, COUNT.changes)
      .map((c, i) => str(c, `${path}.changes[${i}]`, LIMIT.prose, true)),
    markdown: body(v.markdown, `${path}.markdown`, LIMIT.markdown, false),
    fallback: v.fallback,
  };
};

/** Structural validation of a persisted snapshot record (no store access). */
const snapshotRecord = (raw: unknown, path: string): Snapshot => {
  const v = object(raw, path);
  const text = body(v.text, `${path}.text`, LIMIT.extracted);
  const pages = v.pages === undefined ? undefined : list(v.pages, `${path}.pages`, COUNT.pages).map((p, i) => {
    const page = object(p, `${path}.pages[${i}]`);
    const record = {
      page: integer(page.page, `${path}.pages[${i}].page`, 1, 1_000_000),
      start: integer(page.start, `${path}.pages[${i}].start`, 0, text.length),
      end: integer(page.end, `${path}.pages[${i}].end`, 0, text.length),
    };
    if (record.end <= record.start) throw new Error(`${path}.pages[${i}]: span end must exceed span start`);
    return record;
  });
  for (let i = 1; pages && i < pages.length; i++) {
    const previous = pages[i - 1]!;
    const current = pages[i]!;
    if (current.page <= previous.page) throw new Error(`${path}.pages[${i}]: page numbers must increase`);
    if (current.start < previous.start) throw new Error(`${path}.pages[${i}]: spans must follow extracted-text order`);
  }
  const result: Snapshot = {
    id: sha256Id(v.id, `${path}.id`),
    requestedUrl: httpUrl(v.requestedUrl, `${path}.requestedUrl`),
    finalUrl: httpUrl(v.finalUrl, `${path}.finalUrl`),
    canonicalUrl: httpUrl(v.canonicalUrl, `${path}.canonicalUrl`),
    fetchedAt: time(v.fetchedAt, `${path}.fetchedAt`),
    contentHash: sha256Id(v.contentHash, `${path}.contentHash`),
    textHash: sha256Id(v.textHash, `${path}.textHash`),
    rawBlob: sha256Id(v.rawBlob, `${path}.rawBlob`),
    textBlob: sha256Id(v.textBlob, `${path}.textBlob`),
    mime: str(v.mime, `${path}.mime`, LIMIT.short),
    status: integer(v.status, `${path}.status`, 100, 599),
    title: str(v.title, `${path}.title`, LIMIT.title, true),
    extraction: str(v.extraction, `${path}.extraction`, LIMIT.short),
    extractionVersion: str(v.extractionVersion, `${path}.extractionVersion`, LIMIT.short),
    text,
  };
  if (pages !== undefined) result.pages = pages;
  return result;
};

/** Read a snapshot record file and parse it into a validated domain record. */
const readSnapshotJson = (path: string, what: string): Snapshot => {
  const bytes = readBytes(path, what);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${what} is not valid JSON: ${message(error)}`, { cause: error }); }
  return snapshotRecord(raw, what);
};

const uniqueIds = (ids: string[], label: string): Set<string> => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`investigation.${label}: duplicate id "${id}"`);
    seen.add(id);
  }
  return seen;
};

const acyclic = (parents: Map<string, string | undefined>, label: string): void => {
  for (const [id, parent] of parents) {
    if (parent !== undefined && !parents.has(parent)) throw new Error(`investigation.${label}: "${id}" references unknown parent "${parent}"`);
    const seen = new Set<string>([id]);
    for (let cur = parent; cur !== undefined; cur = parents.get(cur)) {
      if (seen.has(cur)) throw new Error(`investigation.${label}: parent chain of "${id}" cycles through "${cur}"`);
      seen.add(cur);
    }
  }
};

/**
 * Full structural, numeric, identifier and reference validation of a persisted
 * investigation manifest. Returns a fresh deep copy; unknown fields are dropped.
 * Reference checks stay inside the manifest: corpus membership is snapshotIds,
 * never a scan of the object store.
 */
export function validateInvestigation(value: unknown): Investigation {
  const v = object(value, 'investigation');
  if (v.schema !== 1) throw new Error('investigation.schema: expected schema 1');
  const id = str(v.id, 'investigation.id', LIMIT.id);
  const revisionId = str(v.revisionId, 'investigation.revisionId', LIMIT.id);
  const allowanceId = str(v.allowanceId, 'investigation.allowanceId', LIMIT.id);
  const storageRoot = str(v.storageRoot, 'investigation.storageRoot', LIMIT.root);
  const originalQuestion = body(v.originalQuestion, 'investigation.originalQuestion', LIMIT.input, false);
  // The initial newInvestigation manifest legitimately has no objective yet.
  const activeObjectiveId = str(v.activeObjectiveId, 'investigation.activeObjectiveId', LIMIT.id, true);
  const corpusRevision = integer(v.corpusRevision, 'investigation.corpusRevision', 0, Number.MAX_SAFE_INTEGER);
  const status = choice(v.status, 'investigation.status', ['paused', 'running', 'complete'] as const);
  const stopReason = v.stopReason === undefined ? undefined : str(v.stopReason, 'investigation.stopReason', LIMIT.prose, true);

  const objectives = list(v.objectives, 'investigation.objectives', COUNT.objectives)
    .map((o, i) => objective(o, `objectives[${i}]`));
  const branches = list(v.branches, 'investigation.branches', COUNT.branches)
    .map((b, i) => branch(b, `branches[${i}]`));
  const candidates = list(v.candidates, 'investigation.candidates', COUNT.candidates)
    .map((c, i) => candidate(c, `candidates[${i}]`));
  const snapshotIds = list(v.snapshotIds, 'investigation.snapshotIds', COUNT.snapshotIds)
    .map((s, i) => sha256Id(s, `snapshotIds[${i}]`));
  const passages = list(v.passages, 'investigation.passages', COUNT.passages)
    .map((p, i) => passage(p, `passages[${i}]`));
  const concepts = list(v.concepts, 'investigation.concepts', COUNT.concepts)
    .map((c, i) => concept(c, `concepts[${i}]`));
  const contributions = list(v.contributions, 'investigation.contributions', COUNT.contributions)
    .map((c, i) => contribution(c, `contributions[${i}]`));
  const actions = list(v.actions, 'investigation.actions', COUNT.actions)
    .map((a, i) => action(a, `actions[${i}]`));
  const feedbackEntries = list(v.feedback, 'investigation.feedback', COUNT.feedback)
    .map((f, i) => feedback(f, `feedback[${i}]`));
  const reports = list(v.reports, 'investigation.reports', COUNT.reports)
    .map((r, i) => report(r, `reports[${i}]`));

  const objectiveIds = uniqueIds(objectives.map(o => o.id), 'objectives');
  const branchIds = uniqueIds(branches.map(b => b.id), 'branches');
  const candidateIds = uniqueIds(candidates.map(c => c.id), 'candidates');
  const corpus = uniqueIds(snapshotIds, 'snapshotIds');
  const passageIds = uniqueIds(passages.map(p => p.id), 'passages');
  uniqueIds(concepts.map(c => c.id), 'concepts');
  uniqueIds(actions.map(a => a.id), 'actions');
  uniqueIds(feedbackEntries.map(f => f.id), 'feedback');
  uniqueIds(reports.map(r => r.id), 'reports');
  if (activeObjectiveId !== '' && !objectiveIds.has(activeObjectiveId)) throw new Error(`investigation.activeObjectiveId: unknown objective "${activeObjectiveId}"`);
  acyclic(new Map(objectives.map(o => [o.id, o.parentId])), 'objectives');
  acyclic(new Map(branches.map(b => [b.id, b.parentId])), 'branches');

  const passagesById = new Map(passages.map(p => [p.id, p]));
  const needsById = new Map(branches.map(b => [b.id, new Set(b.needs.map(n => n.id))]));
  const checkSpans = (spans: Span[], label: string): void => {
    spans.forEach((s, i) => {
      const target = passagesById.get(s.passageId);
      if (!target) throw new Error(`investigation.${label}[${i}]: unknown passage "${s.passageId}"`);
      if (s.end > target.text.length) throw new Error(`investigation.${label}[${i}]: span exceeds passage "${target.id}" text`);
    });
  };

  branches.forEach((b, i) => {
    if (!objectiveIds.has(b.objectiveId)) throw new Error(`branches[${i}].objectiveId: unknown objective "${b.objectiveId}"`);
    checkSpans(b.introducing, `branches[${i}].introducing`);
  });
  candidates.forEach((c, i) => {
    if (!branchIds.has(c.branchId)) throw new Error(`candidates[${i}].branchId: unknown branch "${c.branchId}"`);
    if (c.snapshotId !== undefined && !corpus.has(c.snapshotId)) {
      throw new Error(`candidates[${i}].snapshotId: snapshot "${c.snapshotId}" is not in the manifest corpus`);
    }
  });
  passages.forEach((p, i) => {
    if (!corpus.has(p.snapshotId)) throw new Error(`passages[${i}].snapshotId: snapshot "${p.snapshotId}" is not in the manifest corpus`);
  });
  concepts.forEach((c, i) => {
    if (!branchIds.has(c.branchId)) throw new Error(`concepts[${i}].branchId: unknown branch "${c.branchId}"`);
    if (c.admittedBranchId !== undefined && !branchIds.has(c.admittedBranchId)) {
      throw new Error(`concepts[${i}].admittedBranchId: unknown branch "${c.admittedBranchId}"`);
    }
    checkSpans(c.introducing, `concepts[${i}].introducing`);
  });
  contributions.forEach((c, i) => {
    if (!objectiveIds.has(c.objectiveId)) throw new Error(`contributions[${i}].objectiveId: unknown objective "${c.objectiveId}"`);
    if (!branchIds.has(c.branchId)) throw new Error(`contributions[${i}].branchId: unknown branch "${c.branchId}"`);
    if (!needsById.get(c.branchId)?.has(c.needId)) {
      throw new Error(`contributions[${i}].needId: branch "${c.branchId}" has no need "${c.needId}"`);
    }
    if (!passageIds.has(c.passageId)) throw new Error(`contributions[${i}].passageId: unknown passage "${c.passageId}"`);
  });
  actions.forEach((a, i) => {
    if (!objectiveIds.has(a.objectiveId)) throw new Error(`actions[${i}].objectiveId: unknown objective "${a.objectiveId}"`);
    if (!branchIds.has(a.branchId)) throw new Error(`actions[${i}].branchId: unknown branch "${a.branchId}"`);
    if (a.candidateId !== undefined && !candidateIds.has(a.candidateId)) {
      throw new Error(`actions[${i}].candidateId: unknown candidate "${a.candidateId}"`);
    }
    a.candidateIds?.forEach((c, j) => {
      if (!candidateIds.has(c)) throw new Error(`actions[${i}].candidateIds[${j}]: unknown candidate "${c}"`);
    });
  });
  reports.forEach((r, i) => {
    if (!objectiveIds.has(r.objectiveId)) throw new Error(`reports[${i}].objectiveId: unknown objective "${r.objectiveId}"`);
    r.sections.forEach((s, j) => s.statements.forEach((t, k) => checkSpans(t.citations, `reports[${i}].sections[${j}].statements[${k}].citations`)));
  });

  return {
    schema: 1, id, revisionId, allowanceId, storageRoot, originalQuestion,
    objectives, activeObjectiveId, branches, candidates, snapshotIds, passages, concepts,
    contributions, actions, feedback: feedbackEntries, reports, corpusRevision, status,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

/**
 * Rehydrate the investigation from the chronological active path. Only the latest
 * `pi-research/state` entry is authoritative: an invalid latest entry fails loudly
 * instead of silently falling back to an older manifest. Restored state is paused
 * and previously running actions are marked interrupted; no store is consulted.
 */
export function rehydrate(entries: { type: string; customType?: string; data?: unknown }[]): Investigation | undefined {
  if (!Array.isArray(entries)) throw new Error('rehydrate: expected an array of active-path entries');
  let latest: { type: string; customType?: string; data?: unknown } | undefined;
  let index = -1;
  entries.forEach((entry, i) => {
    if (entry && typeof entry === 'object' && entry.customType === STATE_TYPE) {
      latest = entry;
      index = i;
    }
  });
  if (!latest) return undefined;
  const raw = latest.data;
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); }
    catch (error) { throw new Error(`rehydrate: ${STATE_TYPE} entry ${index} is not valid JSON: ${message(error)}`, { cause: error }); }
  }
  let state: Investigation;
  try {
    state = validateInvestigation(parsed);
  } catch (error) {
    throw new Error(`rehydrate: invalid ${STATE_TYPE} manifest at active-path entry ${index}: ${message(error)}`, { cause: error });
  }
  if (state.status === 'running') state.status = 'paused';
  for (const item of state.actions) if (item.status === 'running') item.status = 'interrupted';
  return state;
}

/**
 * Content-addressed blob and snapshot storage under one root:
 * `blobs/<aa>/<hash>` for deduplicated bodies, `snapshots/<id>.json` for records.
 */
export class ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    if (typeof root !== 'string' || root.trim().length === 0) throw new Error('ObjectStore: storage root must be a non-empty path');
    if (CONTROL.test(root)) throw new Error('ObjectStore: storage root contains control characters');
    this.root = resolve(root);
  }

  private pathFor(relative: string, what: string): string {
    const full = resolve(join(this.root, relative));
    const bound = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (!full.startsWith(bound)) throw new Error(`${what}: path escapes the storage root`);
    return full;
  }

  /** Store bytes under their SHA-256; existing identical content is reused, never overwritten. */
  put(data: Uint8Array | string): string {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('put: expected a string or Uint8Array');
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const hash = digest(bytes);
    const path = this.pathFor(join('blobs', hash.slice(0, 2), hash), 'put');
    if (createFile(path, bytes) === 'exists') {
      const bytesOnDisk = readBytes(path, `put: blob ${hash}`);
      const actual = digest(bytesOnDisk);
      if (actual !== hash) throw new Error(`put: existing blob ${hash} does not match its content (hashes to ${actual})`);
    }
    return hash;
  }

  /** Read a blob by hash after validating hash format, path containment and content integrity. */
  read(hash: string): Buffer {
    const validated = sha256Id(hash, 'read: blob hash');
    const path = this.pathFor(join('blobs', validated.slice(0, 2), validated), 'read');
    const bytes = readBytes(path, `read: blob ${validated}`);
    const actual = digest(bytes);
    if (actual !== validated) throw new Error(`read: blob ${validated} is corrupt (content hashes to ${actual})`);
    return bytes;
  }

  /**
   * Persist an immutable snapshot record. Source identity must be credential-free
   * http(s); referenced blobs must already exist with matching content/text hashes
   * and byte-identical extracted text; page spans must lie inside that text. A record
   * id may never be rewritten with different metadata.
   */
  saveSnapshot(snapshot: Snapshot): void {
    const record = snapshotRecord(snapshot, 'saveSnapshot: snapshot');
    const raw = this.read(record.rawBlob);
    if (digest(raw) !== record.contentHash) {
      throw new Error(`saveSnapshot: snapshot ${record.id} contentHash ${record.contentHash} does not match raw blob ${record.rawBlob}`);
    }
    const text = this.read(record.textBlob);
    if (digest(text) !== record.textHash) {
      throw new Error(`saveSnapshot: snapshot ${record.id} textHash ${record.textHash} does not match text blob ${record.textBlob}`);
    }
    if (!text.equals(Buffer.from(record.text, 'utf8'))) {
      throw new Error(`saveSnapshot: snapshot ${record.id} text differs from its text blob; extracted-text offsets would be ambiguous`);
    }
    const path = this.pathFor(join('snapshots', `${record.id}.json`), 'saveSnapshot');
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    if (createFile(path, bytes) !== 'exists') return;
    const current = readSnapshotJson(path, `saveSnapshot: snapshot ${record.id}`);
    if (!deepEqual(current, record)) throw new Error(`saveSnapshot: snapshot ${record.id} already exists with different immutable metadata`);
  }

  /** Load and revalidate a snapshot record; the extracted text must match its textHash. */
  loadSnapshot(id: string): Snapshot {
    const validated = sha256Id(id, 'loadSnapshot: snapshot id');
    const path = this.pathFor(join('snapshots', `${validated}.json`), 'loadSnapshot');
    const what = `loadSnapshot: snapshot ${validated}`;
    const record = readSnapshotJson(path, what);
    if (record.id !== validated) throw new Error(`${what}: stored snapshot ID does not match the requested record`);
    const actual = digest(record.text);
    if (actual !== record.textHash) {
      throw new Error(`${what}: extracted text hashes to ${actual}, not textHash ${record.textHash}`);
    }
    return record;
  }
}
