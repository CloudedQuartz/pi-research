/**
 * Permanent offline coverage regression for changed-key evidence re-evaluation.
 * Cache keys hash the actual weighted query, including unclassified concepts;
 * PRF expansion therefore leaves one legitimate follow-up evaluation pending. Real core-ir/ObjectStore/Ledger; fake model hosts only.
 * A same-key partial->adequate update yields 0 with one row; B a changed-key
 * zero-deficit contradiction earns yield without downgrading; C an explicit
 * downgrade reopens coverage with its witness; D one real PRF follow-up then a
 * stable key with no repeats; E fetch-allowance exhaustion truncates an episode
 * without skipping evaluation or certifying saturation; F start holds a work-lane
 * follow-up reserve, refuses to spend it and continue uses it; G synthesis sends a
 * compact packet that keeps priority witnesses and still rejects citations outside it.
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
import { isBotChallenge, isThinContent, normalizeUrl, shouldSkipCandidateUrl } from '../src/acquisition.js';
import { classifyFailure, formatAcquisitionSummary, sourceList, summarizeAcquisition } from '../src/views.js';
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
  commits: number; modelCalls: Record<string, number>; assessInputs: any[]; reportInputs: any[];
  /** Usage the fake host reports per call; case F uses realistic per-call cost, default is negligible. */
  usage: typeof USAGE;
  assess: (input: any) => unknown;
  report: (input: any) => unknown;
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

function createCtx(limits = LIMITS, synthesis: Parameters<Ledger['authorize']>[1] = SYNTHESIS): Ctx {
  const root = mkdtempSync(join(tmpdir(), 'engine-coverage-perm-'));
  const store = new ObjectStore(root);
  const ledger = new Ledger(join(root, 'ledger.sqlite'));
  const allowanceId = ledger.authorize(limits, synthesis, `auth-${randomUUID()}`);
  const requestId = randomUUID();
  const state = newInvestigation({ id: `inv-${randomUUID()}`, allowanceId, storageRoot: root, question: 'Quantum foxberry taxonomy survey methods' });
  ledger.authorizeRequest({ id: requestId, allowanceId, investigationId: state.id, sessionId: `session-${requestId}`,
    kind: 'report', question: state.originalQuestion, provider: 'brave', searchTool: 'web', storageRoot: root });
  ledger.claimRequest(requestId, OWNER);
  return { root, store, ledger, requestId, state, commits: 0, modelCalls: {}, assessInputs: [], reportInputs: [], usage: USAGE,
    assess: () => ({ relevantPassageIds: [], contributions: [] }),
    report: () => ({ sections: [] }),
    acquire: url => fixtureSnapshot(store, url, longParagraph('beta')),
    discover: async query => ({ query, provider: 'brave', rankingKind: 'ranked', results: [] }) };
}

function engineFor(ctx: Ctx, state: Investigation = ctx.state, options: EngineOptions = { maxActions: 12 }): ResearchEngine {
  const host: EngineHost = {
    model: {
      async complete(task, input) {
        ctx.modelCalls[task] = (ctx.modelCalls[task] ?? 0) + 1;
        if (task === 'assess') { ctx.assessInputs.push(input); return { value: ctx.assess(input), usage: ctx.usage, usageComplete: true }; }
        if (task === 'classify') return { value: { decisions: [] }, usage: ctx.usage, usageComplete: true };
        if (task === 'report') { ctx.reportInputs.push(input); return { value: ctx.report(input), usage: ctx.usage, usageComplete: true }; }
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

// ------------------------------ F: work-lane reserve for the first follow-up
// Work-lane cap 70,000 tokens / 50 calls ⇒ a 17,500-token, 3-call hold (24,000 ceiling, 25% share).
const RESERVE_LIMITS = { ...LIMITS, modelTokens: 100_000 };
const RESERVE_SYNTHESIS = { modelCalls: 10, modelTokens: 30_000 };

/** Eight unmet branches over one small corpus, so every retrieve is exactly one assess call. */
function makeWideFixture(seed: string, limits = RESERVE_LIMITS, synthesis = RESERVE_SYNTHESIS) {
  const ctx = createCtx(limits, synthesis);
  const snapshot = fixtureSnapshot(ctx.store, `https://example.org/${seed}`, longParagraph(seed));
  const index = new PassageIndex(); index.add(segment(snapshot));
  const passages = index.all();
  const objective = { id: `obj-${seed}`, input: ctx.state.originalQuestion, question: ctx.state.originalQuestion, constraints: [], createdAt: new Date().toISOString() };
  const branches: Investigation['branches'] = Array.from({ length: 8 }, (_, i) => ({
    id: `branch-${seed}-${i}`, objectiveId: objective.id, question: `Which ${seed} survey method repeats (${i})?`,
    anchor: `${seed} quantum foxberry ${i}`, origin: 'initial' as const, introducing: [],
    priority: 0.7 - i * 0.01, status: 'active' as const,
    needs: [{ id: `need-${seed}-${i}`, question: `identify survey method ${i}`, weight: 1, status: 0 as const }],
    aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
  }));
  const state: Investigation = { ...ctx.state, objectives: [objective], activeObjectiveId: objective.id, branches,
    snapshotIds: [snapshot.id], passages, corpusRevision: 1 };
  validateInvestigation(state);
  ctx.state = state;
  // Observed per-call usage close to the reserved amount, as a real provider reports it.
  ctx.usage = { input: 8_500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 9_000, costKind: 'model-estimate' };
  ctx.assess = () => ({ relevantPassageIds: [], contributions: [] });
  return { ctx, state };
}

/** Assess operations the ledger actually reserved during the run. */
const assessOps = (ledger: Ledger, allowanceId: string) =>
  ledger.snapshot(allowanceId).operations.filter(op => (op.payload as { task?: string } | undefined)?.task === 'assess');

async function caseFollowUpReserve(): Promise<void> {
  const { ctx, state } = makeWideFixture('reserve');
  const allowanceId = state.allowanceId;
  try {
    const start = await engineFor(ctx, state).run();
    const afterStart = ctx.ledger.snapshot(allowanceId);
    const startAssess = ctx.modelCalls.assess ?? 0;
    const callCost = Math.max(0, ...assessOps(ctx.ledger, allowanceId).map(op => op.amount.modelTokens ?? 0));
    const remaining = afterStart.lanes.work.remaining.modelTokens;
    check('F start dispatches real assessments before the hold blocks it', startAssess >= 2, `assess=${startAssess}`);
    check('F start stops on the follow-up hold, not exhaustion',
      start.status === 'complete' && /held for the first follow-up/.test(start.stopReason ?? '') && !/exhausted/.test(start.stopReason ?? ''), String(start.stopReason));
    check('F the hold keeps one full assessment of the work lane available',
      callCost > 0 && remaining >= callCost, `call=${callCost} remaining=${remaining}`);
    check('F the hold is headroom, not a ledger reservation',
      afterStart.lanes.work.reserved.modelTokens === 0 && afterStart.lanes.synthesis.reserved.modelTokens === 0,
      `work=${afterStart.lanes.work.reserved.modelTokens} synthesis=${afterStart.lanes.synthesis.reserved.modelTokens}`);
    check('F accounting confirms only observed usage, never the hold',
      afterStart.confirmed.modelTokens === startAssess * ctx.usage.totalTokens, `confirmed=${afterStart.confirmed.modelTokens} expected=${startAssess * ctx.usage.totalTokens}`);

    const second = await engineFor(ctx).run();
    check('F a repeated start cannot spend the held capacity',
      (ctx.modelCalls.assess ?? 0) === startAssess && /held for the first follow-up/.test(second.stopReason ?? ''),
      `assess=${ctx.modelCalls.assess} stop=${String(second.stopReason)}`);

    const continuation = await engineFor(ctx).run('', 'continue');
    const continueAssess = (ctx.modelCalls.assess ?? 0) - startAssess;
    check('F continue releases the reserve and dispatches the follow-up assessment',
      continueAssess >= 1, `assess=${ctx.modelCalls.assess}`);
    check('F continue is no longer stopped by the hold',
      !/held for the first follow-up/.test(continuation.stopReason ?? ''), String(continuation.stopReason));
  } finally { retire(ctx); }
}

async function caseSmallLaneReserve(): Promise<void> {
  // 40,000-token work lane: the hold is 10,000 (25%), not the 24,000 ceiling.
  const { ctx, state } = makeWideFixture('smallreserve', { ...LIMITS, modelTokens: 70_000 });
  try {
    const start = await engineFor(ctx, state).run();
    const afterStart = ctx.ledger.snapshot(state.allowanceId);
    const remaining = afterStart.lanes.work.remaining.modelTokens;
    check('F a small lane caps the hold proportionally instead of starving start',
      (ctx.modelCalls.assess ?? 0) >= 3 && remaining < 24_000, `assess=${ctx.modelCalls.assess} remaining=${remaining}`);
    check('F the small-lane stop still explains the hold', /held for the first follow-up/.test(start.stopReason ?? ''), String(start.stopReason));
  } finally { retire(ctx); }
}

async function caseFollowUpCallReserve(): Promise<void> {
  // Work-lane call cap 6 ⇒ a one-call hold (25% of six), not the three-call ceiling.
  const { ctx, state } = makeWideFixture('callreserve', { ...LIMITS, modelCalls: 8 }, { modelCalls: 2, modelTokens: 30_000 });
  try {
    const start = await engineFor(ctx, state).run();
    const startAssess = ctx.modelCalls.assess ?? 0;
    check('F the call hold is proportional, so start keeps most of its calls',
      startAssess >= 4 && /held for the first follow-up/.test(start.stopReason ?? '') && /modelCalls/.test(start.stopReason ?? ''),
      `assess=${startAssess} stop=${String(start.stopReason)}`);
    check('F the call hold keeps one call for the follow-up',
      ctx.ledger.snapshot(state.allowanceId).lanes.work.remaining.modelCalls === 1,
      `remainingCalls=${ctx.ledger.snapshot(state.allowanceId).lanes.work.remaining.modelCalls}`);
    await engineFor(ctx).run('', 'continue');
    check('F continue spends the protected call', (ctx.modelCalls.assess ?? 0) > startAssess, `assess=${ctx.modelCalls.assess}`);
  } finally { retire(ctx); }
}

// ------------------------- G: compact synthesis packet and packet-bound citations
/** Twelve need-audit witnesses (priority) plus four ordinary support passages, in corpus order. */
function makePacketFixture(seed: string) {
  const ctx = createCtx();
  const text = Array.from({ length: 16 }, (_, i) => longParagraph(`${seed}p${i}`)).join('\n\n');
  const snapshot = fixtureSnapshot(ctx.store, `https://example.org/${seed}-packet`, text);
  const index = new PassageIndex(); index.add(segment(snapshot));
  const passages = index.all();
  if (passages.length !== 16) throw new Error(`packet fixture expected 16 passages, got ${passages.length}`);
  const objective = { id: `obj-${seed}`, input: ctx.state.originalQuestion, question: ctx.state.originalQuestion, constraints: [], createdAt: new Date().toISOString() };
  const needs = passages.slice(0, 12).map((passage, i) => ({
    id: `need-${seed}-${i}`, question: `addressed question ${i}`, weight: 1 / 12, status: 1 as const,
    assessment: { passageIds: [passage.id], reason: `audit witness ${i}`, corpusRevision: 1, createdAt: new Date().toISOString() },
  }));
  const branch: Investigation['branches'][number] = {
    id: `branch-${seed}`, objectiveId: objective.id, question: 'Which survey methods repeat?', anchor: 'quantum foxberry taxonomy',
    origin: 'initial', introducing: [], priority: 0.7, status: 'active', needs, aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
  };
  const contributions = passages.slice(12).map(passage => ({
    objectiveId: objective.id, branchId: branch.id, needId: needs[0]!.id, passageId: passage.id,
    duplicateGroup: passage.duplicateGroup, role: 'support' as const, assessment: 'ordinary supporting evidence',
  }));
  const state: Investigation = { ...ctx.state, objectives: [objective], activeObjectiveId: objective.id, branches: [branch],
    snapshotIds: [snapshot.id], passages, contributions, corpusRevision: 1 };
  branch.retrievalKey = retrievalKey(state, branch); // unchanged key: no refresh assessment before synthesis
  validateInvestigation(state);
  ctx.state = state;
  return { ctx, state, passages, witnesses: passages.slice(0, 12), ordinary: passages.slice(12) };
}

async function caseCompactReportPacket(): Promise<void> {
  const f = makePacketFixture('compact');
  try {
    f.ctx.report = input => {
      const packet = input.evidence as { passageId: string }[];
      return { sections: [{ title: 'Answer', statements: [
        { text: 'The earliest witness supports the answer.', citations: [{ passageId: packet[0]!.passageId, start: 0, end: 20 }] },
        { text: 'The latest witness qualifies it.', citations: [{ passageId: packet.at(-1)!.passageId, start: 5, end: 30 }] },
      ] }] };
    };
    const final = await engineFor(f.ctx).run('', 'report');
    const packet = f.ctx.reportInputs[0]?.evidence as { passageId: string; text: string }[] | undefined;
    const report = final.reports.at(-1)!;
    const ids = new Set((packet ?? []).map(p => p.passageId));
    const chars = (packet ?? []).reduce((sum, p) => sum + p.text.length, 0);
    check('G synthesis is called once with a packet under the hard maximum',
      f.ctx.modelCalls.report === 1 && !!packet && packet.length <= 40 && chars <= 48_000, `calls=${f.ctx.modelCalls.report} packet=${packet?.length} chars=${chars}`);
    check('G every need-audit witness is kept past the compact target',
      f.witnesses.every(p => ids.has(p.id)) && (packet?.length ?? 0) > 10 && chars > 16_000, `packet=${packet?.length} chars=${chars}`);
    check('G ordinary evidence beyond the compact target is omitted and disclosed',
      f.ordinary.every(p => !ids.has(p.id)) && f.ctx.reportInputs[0]?.evidenceOmitted === 4
      && /compact target 10 passages \/ 16000 characters/.test(String(f.ctx.reportInputs[0]?.packetNote)),
      `omitted=${f.ctx.reportInputs[0]?.evidenceOmitted} note=${String(f.ctx.reportInputs[0]?.packetNote).slice(0, 120)}`);
    check('G packet citations resolve without the fallback',
      report.fallback === false && report.sections[0]?.statements.length === 2
      && report.sections[0]!.statements.every(s => ids.has(s.citations[0]!.passageId)), JSON.stringify(report.sections.map(s => s.statements.length)));
  } finally { retire(f.ctx); }
}

async function caseReportPacketCitationBound(): Promise<void> {
  const f = makePacketFixture('bound');
  try {
    // Cite an eligible passage that the compact packet omitted: provenance must fail closed.
    f.ctx.report = () => ({ sections: [{ title: 'Answer', statements: [
      { text: 'Omitted evidence supports this claim.', citations: [{ passageId: f.ordinary[0]!.id, start: 0, end: 20 }] },
    ] }] });
    const final = await engineFor(f.ctx).run('', 'report');
    const report = final.reports.at(-1)!;
    check('G a citation outside the packet falls back instead of publishing', report.fallback === true, `fallback=${report.fallback}`);
    check('G the invalid report gets exactly one bounded repair attempt', f.ctx.modelCalls.report === 2, `calls=${f.ctx.modelCalls.report}`);
    check('G the fallback is explicitly extractive',
      /Extractive evidence outline/.test(report.markdown) && report.sections.every(s => s.statements.every(t => !t.text.includes('Omitted evidence supports this claim.'))));
  } finally { retire(f.ctx); }
}

async function caseCandidateFilteringAndDedup(): Promise<void> {
  const url1 = 'https://Example.org:443/article/amp/?utm_source=twitter&fbclid=123#header';
  const url2 = 'https://example.org/article';
  const url3 = 'http://example.org:80/article?ref=homepage';
  check('H normalizeUrl strips tracking parameters, ports, amp, trailing slash',
    normalizeUrl(url1) === 'https://example.org/article' &&
    normalizeUrl(url2) === 'https://example.org/article' &&
    normalizeUrl(url3) === 'http://example.org/article');

  check('H shouldSkipCandidateUrl flags non-article video/social/login and binary extensions',
    shouldSkipCandidateUrl('https://www.youtube.com/watch?v=123').skip === true &&
    shouldSkipCandidateUrl('https://twitter.com/user/status/123').skip === true &&
    shouldSkipCandidateUrl('https://example.org/path/login').skip === true &&
    shouldSkipCandidateUrl('https://example.org/image.png').skip === true &&
    shouldSkipCandidateUrl('https://example.org/paper.pdf').skip === false &&
    shouldSkipCandidateUrl('https://example.org/research-article').skip === false);

  const seed = 'filtering-test';
  const f = makeFixture(seed, { ...LIMITS, searches: 5, fetches: 10 });
  const fetchedUrls: string[] = [];
  f.ctx.assess = () => ({ relevantPassageIds: [], contributions: [] });
  f.ctx.acquire = url => {
    fetchedUrls.push(url);
    return fixtureSnapshot(f.ctx.store, url, longParagraph(`${seed}-${url}`));
  };
  f.ctx.discover = async query => ({
    query, provider: 'brave', rankingKind: 'ranked',
    results: [
      { url: `https://example.org/${seed}/article-a?utm_source=feed`, title: `Article A ${seed}`, snippet: 'quantum foxberry taxonomy survey', rank: 1 },
      { url: `https://example.org/${seed}/article-a/`, title: `Article A duplicate ${seed}`, snippet: 'quantum foxberry taxonomy survey', rank: 2 },
      { url: 'https://youtube.com/watch?v=quantumfoxberry', title: `Video on quantum foxberry ${seed}`, snippet: 'quantum foxberry video', rank: 3 },
      { url: `https://example.org/${seed}/unrelated`, title: 'Cooking recipes and kitchen tips', snippet: 'baking cakes and bread recipes', rank: 4 },
      { url: `https://example.org/${seed}/article-b`, title: `Article B survey methods ${seed}`, snippet: 'quantum foxberry taxonomy notes', rank: 5 },
    ],
  });

  const final = await engineFor(f.ctx, f.state, { maxActions: 1, maxFetchesPerEpisode: 3 }).run();
  try {
    const candidates = final.candidates;
    const articleACands = candidates.filter(c => c.url.includes('article-a'));
    check('H tracking-param duplicate is deduped to one candidate', articleACands.length === 1, `count=${articleACands.length}`);

    const videoCand = candidates.find(c => c.url.includes('youtube.com'));
    check('H non-article video candidate is marked blocked with reason',
      videoCand !== undefined && videoCand.status === 'blocked' && /skipped: non-article/.test(videoCand.error ?? ''), `status=${videoCand?.status} error=${videoCand?.error}`);

    const offTopicCand = candidates.find(c => c.url.includes('unrelated'));
    check('H off-topic candidate with zero overlap was not fetched in this episode',
      offTopicCand !== undefined && offTopicCand.status === 'unread', `status=${offTopicCand?.status}`);

    check('H only relevant article candidates were fetched',
      fetchedUrls.some(u => u.includes('article-a')) &&
      fetchedUrls.some(u => u.includes('article-b')) &&
      !fetchedUrls.some(u => u.includes('youtube') || u.includes('unrelated')),
      `fetched=${fetchedUrls.join(', ')}`);
  } finally { retire(f.ctx); }
}

async function caseBotChallengeAndCircuitBreaker(): Promise<void> {
  // 1. isBotChallenge and isThinContent tests
  check('I isBotChallenge detects Cloudflare challenge title',
    isBotChallenge('<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>') === true);
  check('I isBotChallenge detects challenge-platform and verification markers',
    isBotChallenge('<div class="cf-browser-verification"><script src="/cdn-cgi/challenge-platform/h/b/scripts/alpha.js"></script></div>') === true &&
    isBotChallenge('<html><head><title>Verify</title></head><body><div id="px-captcha"></div></body></html>') === true);
  check('I isBotChallenge exempts pages with <article> tags',
    isBotChallenge('<html><body><article><h1>Quantum Foxberry Challenges</h1><p>Full article text about challenge-platform research.</p></article></body></html>') === false);
  check('I isBotChallenge exempts pages with schema.org NewsArticle / Article',
    isBotChallenge('<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"Browser Verification"}</script></head><body><p>Article body</p></body></html>') === false);
  check('I isThinContent flags thin text under 80 characters',
    isThinContent('Please enable cookies to continue.') === true &&
    isThinContent('A'.repeat(85)) === false);

  // 2. Circuit breaker in engine
  const seed = 'circuit-breaker-test';
  const f = makeFixture(seed, { ...LIMITS, searches: 5, fetches: 10 });
  const acquireCalls: string[] = [];
  f.ctx.assess = () => ({ relevantPassageIds: [], contributions: [] });
  f.ctx.acquire = url => {
    acquireCalls.push(url);
    if (url.includes('blocked-host.example.org/item-1')) {
      throw new Error('bot-challenge detected (Cloudflare/CAPTCHA challenge screen)');
    }
    if (url.includes('blocked-host.example.org/item-2')) {
      throw new Error('should not be called due to circuit breaker');
    }
    return fixtureSnapshot(f.ctx.store, url, longParagraph(`${seed}-${url}`));
  };
  f.ctx.discover = async query => ({
    query, provider: 'brave', rankingKind: 'ranked',
    results: [
      { url: 'https://blocked-host.example.org/item-1', title: `Survey item 1 ${seed}`, snippet: 'quantum foxberry taxonomy survey', rank: 1 },
      { url: 'https://blocked-host.example.org/item-2', title: `Survey item 2 ${seed}`, snippet: 'quantum foxberry taxonomy survey', rank: 2 },
      { url: 'https://good-host.example.org/item-3', title: `Survey item 3 ${seed}`, snippet: 'quantum foxberry taxonomy survey', rank: 3 },
    ],
  });

  const final = await engineFor(f.ctx, f.state, { maxActions: 1, maxFetchesPerEpisode: 3 }).run();
  try {
    const cand1 = final.candidates.find(c => c.url.includes('blocked-host.example.org/item-1'));
    const cand2 = final.candidates.find(c => c.url.includes('blocked-host.example.org/item-2'));
    const cand3 = final.candidates.find(c => c.url.includes('good-host.example.org/item-3'));

    check('I item 1 was attempted and marked blocked with challenge error',
      cand1 !== undefined && cand1.status === 'blocked' && /bot-challenge/i.test(cand1.error ?? ''),
      `status=${cand1?.status} error=${cand1?.error}`);

    check('I item 2 was skipped by circuit breaker without making an acquire call',
      cand2 !== undefined && cand2.status === 'blocked' && /previously blocked/i.test(cand2.error ?? ''),
      `status=${cand2?.status} error=${cand2?.error}`);

    check('I good host item 3 was successfully fetched',
      cand3 !== undefined && cand3.status === 'fetched',
      `status=${cand3?.status} error=${cand3?.error}`);

    check('I acquire was only called for item 1 and item 3',
      acquireCalls.length === 2 &&
      acquireCalls.some(u => u.includes('item-1')) &&
      acquireCalls.some(u => u.includes('item-3')) &&
      !acquireCalls.some(u => u.includes('item-2')),
      `calls=${acquireCalls.join(', ')}`);
  } finally { retire(f.ctx); }
}

async function caseAcquisitionSummaryView(): Promise<void> {
  // 1. classifyFailure
  check('J classifyFailure classifies known failure modes',
    classifyFailure('bot-challenge detected (Cloudflare)') === 'Bot challenge / CAPTCHA' &&
    classifyFailure('HTTP 403 for https://example.org') === 'HTTP 403 Forbidden' &&
    classifyFailure('HTTP 429 for https://example.org') === 'HTTP 429 Rate limited' &&
    classifyFailure('HTTP 503 Service Unavailable') === 'HTTP 5xx Server error' &&
    classifyFailure('HTTP 404 for https://example.org') === 'HTTP 404 Not found' &&
    classifyFailure('timeout after 15000ms') === 'Timeout' &&
    classifyFailure('Readability produced thin text (30 chars)') === 'Extraction failure / thin content' &&
    classifyFailure('getaddrinfo ENOTFOUND') === 'DNS / Network error' &&
    classifyFailure('skipped: host foo.com previously blocked requests') === 'Host circuit-broken' &&
    classifyFailure('skipped: non-article video/social route') === 'Non-article route filter' &&
    classifyFailure('Robots.txt denies /path') === 'Robots.txt policy');

  // 2. summarizeAcquisition and formatAcquisitionSummary
  const mockState: Investigation = {
    schema: 1,
    id: 'test-inv',
    revisionId: 'rev-1',
    originalQuestion: 'test question',
    activeObjectiveId: 'obj-1',
    storageRoot: '',
    allowanceId: '',
    objectives: [],
    branches: [],
    passages: [],
    concepts: [],
    contributions: [],
    actions: [],
    feedback: [],
    reports: [],
    corpusRevision: 1,
    status: 'complete',
    snapshotIds: ['snap-1', 'snap-2'],
    candidates: [
      { id: 'c1', branchId: 'b1', query: 'q', url: 'https://site-a.com/page1', title: 'Page 1', snippet: '', provider: 'brave', rankingKind: 'ranked', discoveredAt: '2026-01-01', status: 'fetched', snapshotId: 'snap-1' },
      { id: 'c2', branchId: 'b1', query: 'q', url: 'https://site-a.com/page2', title: 'Page 2', snippet: '', provider: 'brave', rankingKind: 'ranked', discoveredAt: '2026-01-01', status: 'fetched', snapshotId: 'snap-2' },
      { id: 'c3', branchId: 'b1', query: 'q', url: 'https://site-b.com/page3', title: 'Page 3', snippet: '', provider: 'brave', rankingKind: 'ranked', discoveredAt: '2026-01-01', status: 'failed', error: 'HTTP 403 Forbidden' },
      { id: 'c4', branchId: 'b1', query: 'q', url: 'https://site-b.com/page4', title: 'Page 4', snippet: '', provider: 'brave', rankingKind: 'ranked', discoveredAt: '2026-01-01', status: 'blocked', error: 'skipped: host site-b.com previously blocked requests' },
      { id: 'c5', branchId: 'b1', query: 'q', url: 'https://site-c.com/video', title: 'Video', snippet: '', provider: 'brave', rankingKind: 'ranked', discoveredAt: '2026-01-01', status: 'blocked', error: 'skipped: non-article video/social route' },
      { id: 'c6', branchId: 'b1', query: 'q', url: 'https://site-d.com/page5', title: 'Page 5', snippet: '', provider: 'brave', rankingKind: 'ranked', discoveredAt: '2026-01-01', status: 'unread' },
    ],
  };

  const summary = summarizeAcquisition(mockState);
  check('J summarizeAcquisition counts total candidates and yields correctly',
    summary.totalDiscovered === 6 &&
    summary.fetched === 2 &&
    summary.failed === 1 &&
    summary.blocked === 2 &&
    summary.unread === 1 &&
    summary.attempts === 3 &&
    Math.round(summary.yieldPct) === 67,
    `summary=${JSON.stringify(summary)}`);

  check('J summarizeAcquisition tracks failures by cause and host outcomes',
    summary.failuresByCause['HTTP 403 Forbidden'] === 1 &&
    summary.failuresByCause['Host circuit-broken'] === 1 &&
    summary.failuresByCause['Non-article route filter'] === 1 &&
    summary.hostOutcomes['site-a.com']?.fetched === 2 &&
    summary.hostOutcomes['site-b.com']?.circuitBroken === true &&
    summary.hostOutcomes['site-b.com']?.failed === 1,
    `causes=${JSON.stringify(summary.failuresByCause)} hosts=${JSON.stringify(summary.hostOutcomes)}`);

  const formatted = formatAcquisitionSummary(summary);
  check('J formatAcquisitionSummary includes sections and host flags',
    formatted.includes('=== Acquisition Summary ===') &&
    formatted.includes('Yield: 2/3 attempt(s) (66.7%)') &&
    formatted.includes('Failures and policy exclusions:') &&
    formatted.includes('Host outcomes:') &&
    formatted.includes('site-b.com: 2 discovered, 0 fetched, 1 failed, 1 blocked [circuit-broken]'));

  const renderedList = sourceList(mockState);
  check('J sourceList integrates acquisition summary at the end',
    renderedList.includes('=== Acquisition Summary ===') &&
    renderedList.includes('Page 1') &&
    renderedList.indexOf('Page 1') < renderedList.indexOf('=== Acquisition Summary ==='));
}

async function main(): Promise<void> {
  await casePartialToAdequate(); await caseChangedKeyContradiction();
  await caseExplicitDowngrade(); await casePrfFollowUp();
  await caseEpisodeFetchExhaustion();
  await caseFollowUpReserve(); await caseSmallLaneReserve(); await caseFollowUpCallReserve();
  await caseCompactReportPacket(); await caseReportPacketCitationBound();
  await caseCandidateFilteringAndDedup();
  await caseBotChallengeAndCircuitBreaker();
  await caseAcquisitionSummaryView();
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log('\nall permanent coverage checks passed');
}

main().catch(error => {
  console.error('permanent coverage regression crashed:', error);
  process.exitCode = 1;
});
