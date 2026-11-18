/**
 * Permanent offline coverage regression for changed-key evidence re-evaluation.
 * Cache keys hash the actual weighted query, including unclassified concepts;
 * PRF expansion therefore leaves one legitimate follow-up evaluation pending. Real core-ir/ObjectStore/Ledger; fake model hosts only.
 * A same-key partial->adequate update yields 0 with one row; B a changed-key
 * zero-deficit contradiction earns yield without downgrading; C an explicit
 * downgrade reopens coverage with its witness; D one real PRF follow-up then a
 * stable key with no repeats; E fetch-allowance exhaustion truncates an episode
 * without skipping evaluation or certifying saturation.
 * Run: npx tsx test/engine-coverage.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchEngine, newInvestigation } from '../src/engine.js';
import type { EngineOptions } from '../src/engine.js';
import { Ledger } from '../src/allowance.js';
import { ObjectStore, validateInvestigation } from '../src/object-store.js';
import { PassageIndex, segment } from '../src/core-ir.js';
import { retrievalKey, unmetMass } from '../src/controller.js';
import type { DiscoveryResult, EngineHost, Investigation, Passage, Snapshot } from '../src/types.js';

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const OWNER = 'coverage-owner';
const USAGE = { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, costKind: 'model-estimate' as const };
const LIMITS = { searches: 40, fetches: 40, http: 80, modelCalls: 60, modelTokens: 300_000, elapsedMs: 900_000 };
const SYNTHESIS = { modelCalls: 10, modelTokens: 60_000 };

/** Deterministic long paragraph (~170 tokens) with the branch anchor woven in. */
function longParagraph(seed: string): string {
  const words: string[] = [];
  for (let i = 0; i < 180; i++) {
    if (i % 34 === 0) { words.push('quantum', 'foxberry', 'taxonomy'); i += 2; continue; }
    words.push(`${seed}w${i}`);
  }
  return words.join(' ');
}

interface Ctx {
  root: string; store: ObjectStore; ledger: Ledger; requestId: string; state: Investigation;
  commits: number; modelCalls: Record<string, number>; assessInputs: any[];
  assess: (input: any) => unknown;
  acquire: (url: string) => Snapshot;
  discover: (query: string) => Promise<DiscoveryResult>;
}

function fixtureSnapshot(store: ObjectStore, url: string, text: string): Snapshot {
  const raw = `<html><head><title>Fixture</title></head><body><pre>${text}</pre></body></html>`;
  const rawBlob = store.put(raw); const textBlob = store.put(text);
  const snapshot: Snapshot = {
    id: rawBlob, requestedUrl: url, finalUrl: url, canonicalUrl: url, fetchedAt: new Date().toISOString(),
    contentHash: rawBlob, textHash: textBlob, rawBlob, textBlob, mime: 'text/html', status: 200,
    title: 'Coverage fixture', extraction: 'fixture', extractionVersion: '1', text,
  };
  store.saveSnapshot(snapshot);
  return snapshot;
}

function createCtx(limits = LIMITS): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'engine-coverage-perm-'));
  const store = new ObjectStore(root);
  const ledger = new Ledger(join(root, 'ledger.sqlite'));
  const allowanceId = ledger.authorize(limits, SYNTHESIS, `auth-${randomUUID()}`);
  const requestId = randomUUID();
  const state = newInvestigation({ id: `inv-${randomUUID()}`, allowanceId, storageRoot: root, question: 'Quantum foxberry taxonomy survey methods' });
  ledger.authorizeRequest({ id: requestId, allowanceId, investigationId: state.id, sessionId: `session-${requestId}`,
    kind: 'report', question: state.originalQuestion, provider: 'brave', searchTool: 'web', storageRoot: root });
  ledger.claimRequest(requestId, OWNER);
  return { root, store, ledger, requestId, state, commits: 0, modelCalls: {}, assessInputs: [],
    assess: () => ({ relevantPassageIds: [], contributions: [] }),
    acquire: url => fixtureSnapshot(store, url, longParagraph('beta')),
    discover: async query => ({ query, provider: 'brave', rankingKind: 'ranked', results: [] }) };
}

function engineFor(ctx: Ctx, state: Investigation = ctx.state, options: EngineOptions = { maxActions: 12 }): ResearchEngine {
  const host: EngineHost = {
    model: {
      async complete(task, input) {
        ctx.modelCalls[task] = (ctx.modelCalls[task] ?? 0) + 1;
        if (task === 'assess') { ctx.assessInputs.push(input); return { value: ctx.assess(input), usage: USAGE, usageComplete: true }; }
        if (task === 'classify' || task === 'report') return { value: task === 'classify' ? { decisions: [] } : { sections: [] }, usage: USAGE, usageComplete: true };
        throw new Error(`unexpected model task ${task}`);
      },
    },
    discover: async query => ctx.discover(query), acquire: async url => ctx.acquire(url),
    commit: state => { ctx.state = state; ctx.commits += 1; },
    isCurrent: () => true,
    progress: () => { /* progress not under test */ },
  };
  return new ResearchEngine({ state, ledger: ctx.ledger, store: ctx.store, host, requestId: ctx.requestId,
    owner: OWNER, signal: new AbortController().signal, options });
}

function makeFixture(seed: string, limits = LIMITS) {
  const ctx = createCtx(limits);
  const snapshot = fixtureSnapshot(ctx.store, `https://example.org/${seed}`, longParagraph(seed));
  const objective = { id: `obj-${seed}`, input: ctx.state.originalQuestion, question: ctx.state.originalQuestion, constraints: [], createdAt: new Date().toISOString() };
  const branch: Investigation['branches'][number] = {
    id: `branch-${seed}`, objectiveId: objective.id, question: 'Which survey methods repeat?', anchor: 'quantum foxberry taxonomy',
    origin: 'initial', introducing: [], priority: 0.7, status: 'active',
    needs: [{ id: `need-${seed}`, question: 'identify survey methods', weight: 1, status: 0 }],
    aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
  };
  const index = new PassageIndex(); index.add(segment(snapshot));
  const passages = index.all();
  const groupOf = new Map(passages.map(p => [p.id, p.duplicateGroup]));
  const state: Investigation = { ...ctx.state, objectives: [objective], activeObjectiveId: objective.id, branches: [branch] };
  return { ctx, objective, branch, snapshot, passages, groupOf, representative: passages[0]!, state };
}

type Fixture = ReturnType<typeof makeFixture>;

/** Adds a second snapshot to the corpus and bumps the revision, leaving the stamped key stale. */
function extendCorpus(f: Fixture, url: string): Passage[] {
  const snapshot = fixtureSnapshot(f.ctx.store, url, longParagraph('beta'));
  const index = new PassageIndex(); index.add(segment(snapshot));
  const added = index.all();
  f.state = { ...f.state, snapshotIds: [...f.state.snapshotIds, snapshot.id], passages: [...f.state.passages, ...added],
    corpusRevision: f.state.corpusRevision + 1 };
  return added;
}

function supportRow(f: Fixture, assessment: string): Investigation['contributions'][number] {
  return { objectiveId: f.objective.id, branchId: f.branch.id, needId: f.branch.needs[0]!.id,
    passageId: f.representative.id, duplicateGroup: f.groupOf.get(f.representative.id)!, role: 'support', assessment };
}

/** Closed branch with a revision-1 stamped key, then a new revision-2 snapshot. */
function closedWithLaterCorpus(seed: string): { f: Fixture; witness: Passage } {
  const f = makeFixture(seed);
  f.branch.needs[0]!.status = 1;
  const covered: Investigation = { ...f.state, snapshotIds: [f.snapshot.id], passages: f.passages, corpusRevision: 1, contributions: [supportRow(f, 'closing support')] };
  f.branch.retrievalKey = retrievalKey(covered, f.branch);
  f.state = covered;
  const added = extendCorpus(f, `https://example.org/${seed}-later`);
  validateInvestigation(f.state);
  f.ctx.state = f.state;
  return { f, witness: added[0]! };
}

const retire = (ctx: Ctx): void => { try { ctx.ledger.close(); } catch { /* closed */ } rmSync(ctx.root, { recursive: true, force: true }); };

// ------------------------------ A: partial -> adequate on the same contribution key
async function casePartialToAdequate(): Promise<void> {
  const f = makeFixture('one');
  try {
    f.branch.needs[0]!.status = 0.5;
    f.state = { ...f.state, snapshotIds: [f.snapshot.id], passages: f.passages, corpusRevision: 1, contributions: [supportRow(f, 'earlier partial justification')] };
    validateInvestigation(f.state);
    f.ctx.state = f.state;
    f.ctx.assess = () => ({ relevantPassageIds: [f.representative.id],
      contributions: [{ passageId: f.representative.id, needId: f.branch.needs[0]!.id, role: 'support', status: 1, assessment: 'later evidence strengthens the earlier answer' }],
      coverageUpdates: [{ needId: f.branch.needs[0]!.id, status: 1, passageIds: [f.representative.id], assessment: 'answer now adequate with direct contextual support' }],
    });
    const final = await engineFor(f.ctx).run('', 'report');
    const need = final.branches[0]!.needs[0]!;
    const support = final.contributions.filter(c => c.needId === need.id && c.role === 'support');
    const retrieve = final.actions.filter(a => a.kind === 'retrieve');
    check('A explicit update closes the need from 0.5', need.status === 1, `status=${need.status}`);
    check('A same contribution key keeps exactly one support row', support.length === 1, `rows=${support.length}`);
    check('A repeated evidence earns no yield', retrieve.length === 1 && retrieve[0]!.yield === 0, JSON.stringify(retrieve.map(a => a.yield)));
    check('A the explicit update owns the audit',
      need.assessment?.reason === 'answer now adequate with direct contextual support' && need.assessment.passageIds[0] === f.representative.id, JSON.stringify(need.assessment));
  } finally { retire(f.ctx); }
}

// ---------------------------- B: changed key at zero deficit, new contradiction yields
async function caseChangedKeyContradiction(): Promise<void> {
  const { f, witness } = closedWithLaterCorpus('closed');
  try {
    f.ctx.assess = () => ({ relevantPassageIds: [witness.id],
      contributions: [{ passageId: witness.id, needId: f.branch.needs[0]!.id, role: 'contradiction', status: 0.5, assessment: 'later evidence contradicts the closed answer' }],
    });
    const final = await engineFor(f.ctx).run('', 'report');
    const need = final.branches[0]!.needs[0]!;
    const contradictions = final.contributions.filter(c => c.role === 'contradiction');
    const retrieve = final.actions.filter(a => a.kind === 'retrieve');
    check('B changed key evaluates the zero-deficit branch once', f.ctx.assessInputs.length === 1, `assess=${f.ctx.assessInputs.length}`);
    check('B the new contradiction lands exactly once', contradictions.length === 1 && contradictions[0]!.passageId === witness.id, JSON.stringify(contradictions.map(c => c.passageId)));
    check('B contradiction never downgrades coverage by itself', need.status === 1, `status=${need.status}`);
    check('B the new contradiction earns yield', retrieve.length === 1 && retrieve[0]!.yield === 1, JSON.stringify(retrieve.map(a => [a.status, a.yield])));
  } finally { retire(f.ctx); }
}

// ------------------------------------ C: explicit downgrade reopens with its witness
async function caseExplicitDowngrade(): Promise<void> {
  const { f, witness } = closedWithLaterCorpus('reopen');
  try {
    f.ctx.assess = () => ({ relevantPassageIds: [witness.id],
      contributions: [{ passageId: witness.id, needId: f.branch.needs[0]!.id, role: 'contradiction', status: 0.5, assessment: 'later source qualifies the closed answer' }],
      coverageUpdates: [{ needId: f.branch.needs[0]!.id, status: 0.5, passageIds: [witness.id], assessment: 'reopened: qualification reduces adequacy' }],
    });
    const final = await engineFor(f.ctx).run('', 'report');
    const need = final.branches[0]!.needs[0]!;
    const unclassified = final.concepts.filter(c => c.branchId === f.branch.id && c.classification === undefined);
    check('C changed key evaluates the covered branch once', f.ctx.assessInputs.length === 1, `assess=${f.ctx.assessInputs.length}`);
    check('C explicit downgrade reopens coverage to 0.5', need.status === 0.5 && unmetMass(final.branches[0]!) > 0, `status=${need.status} unmet=${unmetMass(final.branches[0]!)}`);
    check('C audit names the qualifying witness',
      need.assessment?.reason === 'reopened: qualification reduces adequacy' && need.assessment.passageIds[0] === witness.id, JSON.stringify(need.assessment));
    check('C expansion leaves the weighted query key pending',
      unclassified.length > 0 && final.branches[0]!.retrievalKey !== retrievalKey(final, final.branches[0]!), `unclassified=${unclassified.length}`);
  } finally { retire(f.ctx); }
}

// -------------------------- D: one real PRF follow-up, then a stable key (no repeats)
async function casePrfFollowUp(): Promise<void> {
  const f = makeFixture('prf');
  try {
    f.state = { ...f.state, snapshotIds: [f.snapshot.id], passages: f.passages, corpusRevision: 1 };
    validateInvestigation(f.state); f.ctx.state = f.state;
    f.ctx.assess = () => ({ relevantPassageIds: [f.representative.id],
      contributions: [{ passageId: f.representative.id, needId: f.branch.needs[0]!.id, role: 'support', status: 1, assessment: 'full support' }] });
    const first = await engineFor(f.ctx).run('', 'report');
    const firstBranch = first.branches[0]!;
    const unclassified = first.concepts.filter(c => c.branchId === f.branch.id && c.classification === undefined);
    check('D first evaluation closes the need once', f.ctx.modelCalls.assess === 1 && firstBranch.needs[0]!.status === 1,
      `assess=${f.ctx.modelCalls.assess} status=${firstBranch.needs[0]!.status}`);
    check('D PRF expansion leaves the stamped weighted query key stale',
      firstBranch.retrievalKey !== undefined && unclassified.length > 0 && firstBranch.retrievalKey !== retrievalKey(first, firstBranch), `concepts=${first.concepts.length} unclassified=${unclassified.length}`);
    const retrievesAfterFirst = first.actions.filter(a => a.kind === 'retrieve').length;
    const followup = await engineFor(f.ctx).run('', 'report');
    const followupBranch = followup.branches[0]!;
    const followupRetrieves = followup.actions.filter(a => a.kind === 'retrieve');
    check('D exactly one follow-up evaluation runs at zero deficit',
      f.ctx.modelCalls.assess === 2 && followupRetrieves.length === retrievesAfterFirst + 1 && followupRetrieves.at(-1)!.yield === 0, `assess=${f.ctx.modelCalls.assess} retrieves=${followupRetrieves.length} yield=${followupRetrieves.at(-1)?.yield}`);
    check('D the follow-up re-stamps the expanded key',
      followupBranch.retrievalKey === retrievalKey(followup, followupBranch), `stampMatches=${followupBranch.retrievalKey === retrievalKey(followup, followupBranch)}`);
    const third = await engineFor(f.ctx).run('', 'report');
    const thirdRetrieves = third.actions.filter(a => a.kind === 'retrieve').length;
    check('D stable key causes no further assessment or retrieval',
      f.ctx.modelCalls.assess === 2 && thirdRetrieves === followupRetrieves.length, `assess=${f.ctx.modelCalls.assess} retrieves=${thirdRetrieves}`);
  } finally { retire(f.ctx); }
}

// ------------- E: fetch-allowance exhaustion truncates the episode, not the evaluation
interface ExhaustedEpisode { ctx: Ctx; final: Investigation; }

/**
 * Two credited fetches are all the allowance admits: the first fails at DNS (still
 * accounted), the second commits passages, and a third eligible source must never be
 * attempted. The episode must then evaluate committed evidence instead of unwinding.
 */
async function runExhaustedEpisode(seed: string, assess: (input: any) => unknown): Promise<ExhaustedEpisode> {
  const f = makeFixture(seed, { ...LIMITS, fetches: 2 });
  const traffic = [
    `https://dns-failure.example.org/${seed}`,
    `https://committed.example.org/${seed}`,
    `https://never-attempted.example.org/${seed}`,
  ];
  f.ctx.assess = assess;
  f.ctx.discover = async query => ({ query, provider: 'brave', rankingKind: 'ranked',
    results: traffic.map((url, rank) => ({ url, title: `result ${rank}`, snippet: `quantum foxberry taxonomy ${seed}`, rank })) });
  f.ctx.acquire = url => {
    if (url.includes('dns-failure')) throw new Error('getaddrinfo ENOTFOUND dns-failure.example.org');
    return fixtureSnapshot(f.ctx.store, url, longParagraph(`${seed}-source`));
  };
  const final = await engineFor(f.ctx, f.state, { maxActions: 1 }).run();
  return { ctx: f.ctx, final };
}

async function caseEpisodeFetchExhaustion(): Promise<void> {
  const zero = await runExhaustedEpisode('truncated-zero', () => ({ relevantPassageIds: [], contributions: [] }));
  try {
    const search = zero.final.actions.filter(a => a.kind === 'search');
    const fetches = zero.final.actions.filter(a => a.kind === 'fetch');
    const branch = zero.final.branches[0]!;
    check('E truncated episode still evaluates committed evidence once', zero.ctx.modelCalls.assess === 1, `assess=${zero.ctx.modelCalls.assess}`);
    check('E truncated episode closes as completed (not interrupted)', search.length === 1 && search[0]!.status === 'completed', JSON.stringify(search.map(a => a.status)));
    check('E action error states the fetch-allowance truncation', /fetch allowance exhausted/.test(search[0]!.error ?? '') && /2\/3/.test(search[0]!.error ?? ''), String(search[0]?.error));
    check('E no fetch is attempted without credit', fetches.length === 2, `fetches=${fetches.length}`);
    check('E zero-yield truncation earns no saturation credit or cooldown', branch.zeroYieldEpisodes === 0 && branch.status === 'active', `zeroYield=${branch.zeroYieldEpisodes} status=${branch.status}`);
  } finally { retire(zero.ctx); }

  const productive = await runExhaustedEpisode('truncated-yield', input => {
    const passageId = input.passages[0].passageId as string;
    return { relevantPassageIds: [passageId], contributions: [
      { passageId, needId: input.branch.needs[0].id as string, role: 'support', status: 1, assessment: 'committed evidence supports the need' }] };
  });
  try {
    const search = productive.final.actions.filter(a => a.kind === 'search');
    const branch = productive.final.branches[0]!;
    check('E assessed yield from committed evidence reaches the truncated episode', search.length === 1 && search[0]!.yield === 1, JSON.stringify(search.map(a => [a.status, a.yield])));
    check('E search credit records one completed, successful episode', branch.stats.search?.completed === 1 && branch.stats.search?.successful === 1, JSON.stringify(branch.stats.search));
  } finally { retire(productive.ctx); }
}

async function main(): Promise<void> {
  await casePartialToAdequate(); await caseChangedKeyContradiction();
  await caseExplicitDowngrade(); await casePrfFollowUp();
  await caseEpisodeFetchExhaustion();
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log('\nall permanent coverage checks passed');
}

main().catch(error => {
  console.error('permanent coverage regression crashed:', error);
  process.exitCode = 1;
});
