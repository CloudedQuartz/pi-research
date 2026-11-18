import { createHash, randomUUID } from 'node:crypto';
import { chooseAction, rankingQuery, retrievalKey, unmetMass } from './controller.js';
import type { ProposedAction } from './controller.js';
import { PassageIndex, concepts as deriveConcepts, mmr, segment } from './core-ir.js';
import { validateInvestigation } from './object-store.js';
import { ModelCallError } from './pi-model.js';
import { buildReport, reportEvidence } from './report.js';
import { parseAssessment, parseDecisions, parsePlan } from './task-validation.js';
import type { Ledger } from './allowance.js';
import type {
  Action, Branch, Concept, Contribution, DiscoveryResult, EvidenceAssessment, Investigation, ModelResponse, ModelUsage,
  Objective, Passage, PlanResult, Report, Resource, SearchHit, Snapshot, SourceCandidate, Span, Usage,
} from './types.js';

export { newInvestigation, feedback } from './engine-state.js';
export type { InvestigationSeed } from './engine-state.js';

/**
 * Host-independent research engine. Code controls dispatch, accounting, yield
 * and commits; the model only proposes structured interpretations. Invariants:
 * every logical commit is a cloned state with a fresh revision ID guarded by
 * `host.isCurrent() && ledger.owns(requestId, owner)`; stale completions settle
 * usage but never publish; the engine never authorizes or grants allowance.
 */

type TaskName = 'plan' | 'assess' | 'classify' | 'report';
export type RunKind = 'start' | 'continue' | 'report';

export interface EngineOptions {
  /** Dispatched actions per run (retrieve/fetch/search checkpoints). Default 40. */
  maxActions?: number;
  /** Eligible new sources evaluated per discovery episode. Default 3. */
  maxFetchesPerEpisode?: number;
  /** Active/cooldown branches per objective. Default 8. */
  maxActiveBranches?: number;
  mode?: 'adaptive' | 'round-robin';
  /** Grounded expansion (concepts, classification, new branches). Default true. */
  expand?: boolean;
}

/** Dependent store API; satisfied structurally by `./object-store.js`. */
export interface EngineStore {
  loadSnapshot(id: string): Snapshot | Promise<Snapshot>;
}

export interface ResearchEngineArgs {
  state: Investigation;
  ledger: Ledger;
  store: EngineStore;
  host: import('./types.js').EngineHost;
  requestId: string;
  owner: string;
  signal: AbortSignal;
  options?: EngineOptions;
}

const OUTPUT_TOKENS: Record<TaskName, number> = { plan: 3000, assess: 3000, classify: 2500, report: 5000 };
/** Framing allowance on top of estimated input bytes when reserving model capacity. */
const FRAMING_TOKENS = 512;
const REPORT_MAX_PASSAGES = 40;
const REPORT_MAX_CHARS = 48_000;
const MAX_EVAL_FAILURES = 2;
const BRANCHES_PER_EXPANSION_CYCLE = 2;
const DEFAULT_STOP = 'No eligible worthwhile action remains; unresolved needs stay visible. Answer coverage is not factual confidence.';

/** Controlled stop: reason becomes the factual stop reason, never a budget grant. */
class StopRun extends Error {
  constructor(message: string, readonly paused = false) { super(message); }
}
/** Lost writer generation/ownership: the result must not publish and cannot be unwound. */
class StaleError extends Error { constructor() { super('Stale research operation cannot publish state.'); } }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const short = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1500);
const normalizeQuery = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const terms = (text: string): Set<string> => new Set(normalizeQuery(text).split(' ').filter(Boolean));
const overlap = (a: Set<string>, b: Set<string>): number => {
  const shared = [...a].filter(t => b.has(t)).length;
  return shared / Math.max(1, a.size + b.size - shared);
};
const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const now = (): string => new Date().toISOString();
/** Near-duplicate variants supplied to assessment alongside MMR representatives. */
const NEAR_VARIANT_MAX = 8;
const contributionKey = (objectiveId: string, branchId: string, needId: string, group: string, role: string): string =>
  `${objectiveId}\0${branchId}\0${needId}\0${group}\0${role}`;

/**
 * Observed token count only; completeness is a separate fact and is never inferred
 * from positivity. A positive native total wins — a zero total can be an initialized
 * placeholder while the components are positive — otherwise sum the components when
 * every one is a valid safe non-negative integer. Genuine all-zero accounting still
 * observes 0; it simply never proves completeness by itself.
 */
function observedTokens(usage: ModelUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const { input, output, cacheRead, cacheWrite, totalTokens } = usage;
  if (totalTokens !== undefined && Number.isSafeInteger(totalTokens) && totalTokens > 0) return totalTokens;
  const components = [input, output, cacheRead, cacheWrite];
  if (!components.every(n => Number.isSafeInteger(n) && n >= 0)) return undefined;
  const sum = components.reduce((total, n) => total + n, 0);
  return Number.isSafeInteger(sum) ? sum : undefined;
}

/**
 * Bounded near-duplicate variants for contextual inspection: from the same top-30
 * ranking, at most one variant per MMR-selected duplicate group (max 8), with
 * passage IDs and text distinct from every selected and previously chosen variant.
 * Variants are evidence context only: they never feed PRF and never count as
 * independent corroboration of a representative.
 */
function nearVariants(ranked: SearchHit[], selected: SearchHit[]): { hit: SearchHit; representativeId: string }[] {
  const representativeOf = new Map<string, string>();
  const selectedIds = new Set<string>();
  const takenText = new Set<string>();
  for (const hit of selected) {
    const group = hit.passage.duplicateGroup || hit.passage.id;
    if (!representativeOf.has(group)) representativeOf.set(group, hit.passage.id);
    selectedIds.add(hit.passage.id);
    takenText.add(hit.passage.text);
  }
  const seenGroups = new Set<string>();
  const variants: { hit: SearchHit; representativeId: string }[] = [];
  for (const hit of ranked) {
    if (variants.length >= NEAR_VARIANT_MAX) break;
    const group = hit.passage.duplicateGroup || hit.passage.id;
    const representativeId = representativeOf.get(group);
    if (representativeId === undefined || seenGroups.has(group)) continue;
    if (selectedIds.has(hit.passage.id) || takenText.has(hit.passage.text)) continue;
    seenGroups.add(group);
    selectedIds.add(hit.passage.id);
    takenText.add(hit.passage.text);
    variants.push({ hit, representativeId });
  }
  return variants;
}

export class ResearchEngine {
  private readonly state: Investigation;
  private readonly ledger: Ledger;
  private readonly store: EngineStore;
  private readonly host: import('./types.js').EngineHost;
  private readonly requestId: string;
  private readonly owner: string;
  private readonly signal: AbortSignal;
  private readonly options: Required<EngineOptions>;
  private indexCache?: PassageIndex;
  private actions = 0;
  private evalFailures = 0;

  constructor(args: ResearchEngineArgs) {
    this.state = structuredClone(args.state);
    this.ledger = args.ledger;
    this.store = args.store;
    this.host = args.host;
    this.requestId = args.requestId;
    this.owner = args.owner;
    this.signal = args.signal;
    this.options = {
      maxActions: args.options?.maxActions ?? 40,
      maxFetchesPerEpisode: args.options?.maxFetchesPerEpisode ?? 3,
      maxActiveBranches: args.options?.maxActiveBranches ?? 8,
      mode: args.options?.mode ?? 'adaptive',
      expand: args.options?.expand ?? true,
    };
    for (const [key, value] of Object.entries({ maxActions: this.options.maxActions, maxFetchesPerEpisode: this.options.maxFetchesPerEpisode, maxActiveBranches: this.options.maxActiveBranches })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`Engine option ${key} must be a positive integer`);
    }
  }

  // ------------------------------------------------------------- commits/guards

  private guard(): boolean {
    try { return this.host.isCurrent() && this.ledger.owns(this.requestId, this.owner); }
    catch { return false; }
  }

  private assertGuard(): void { if (!this.guard()) throw new StaleError(); }

  private abortReason(): Error {
    return this.signal.reason instanceof Error ? this.signal.reason : new Error('Research run aborted');
  }

  /**
   * Every normal logical commit: clone, mutate, new revision, ownership guard,
   * publish, adopt. Denied once the run is aborted, so a late successful model
   * or fetch result can never publish a post-stop objective, contribution,
   * report, corpus member or completion.
   */
  private commit(mutate: (draft: Investigation) => void): Investigation {
    this.assertGuard();
    if (this.signal.aborted) throw this.abortReason();
    const draft = structuredClone(this.state);
    mutate(draft);
    draft.revisionId = randomUUID();
    const next = validateInvestigation(draft);
    if (this.signal.aborted) throw this.abortReason(); // recheck immediately before publication
    this.assertGuard();
    this.host.commit(next);
    const published = structuredClone(next);
    Object.assign(this.state, published);
    return this.state;
  }

  /**
   * The one cancellation disposition, and the only publication allowed after
   * abort: paused status, factual stop reason, new revision and running actions
   * closed as interrupted (never saturation). It takes no draft or mutator and
   * changes nothing else, so no caller can smuggle logical content past the stop
   * fence.
   */
  private pauseDisposition(reason: string): boolean {
    try {
      this.assertGuard();
      const draft = structuredClone(this.state);
      ResearchEngine.settleRunning(draft);
      draft.status = 'paused';
      draft.stopReason = short(reason);
      draft.revisionId = randomUUID();
      const next = validateInvestigation(draft);
      this.assertGuard();
      this.host.commit(next);
      const published = structuredClone(next);
      Object.assign(this.state, published);
      return true;
    } catch { return false; }
  }

  private progress(messageText: string): void { this.host.progress(short(messageText), this.state); }

  /** Running actions never survive a stop: interrupted, not saturated. */
  private static settleRunning(draft: Investigation): void {
    for (const action of draft.actions) if (action.status === 'running') { action.status = 'interrupted'; action.completedAt = now(); }
  }

  // ------------------------------------------------------------- dispatch checks

  private precheck(amount: Usage, lane: 'work' | 'synthesis' = 'work'): void {
    if (this.signal.aborted) throw this.signal.reason instanceof Error ? this.signal.reason : new Error('Research run aborted');
    const snapshot = this.ledger.snapshot(this.state.allowanceId);
    if (snapshot.remainingElapsedMs <= 0) throw new StopRun('Elapsed allowance exhausted; no new dispatch was started.');
    const remaining = lane === 'synthesis' ? snapshot.lanes.synthesis.remaining : snapshot.lanes.work.remaining;
    for (const [key, value] of Object.entries(amount)) {
      const resource = key as Resource;
      if ((remaining[resource] ?? 0) < (value ?? 0)) {
        throw new StopRun(`${resource} allowance exhausted (${remaining[resource] ?? 0} < ${value}); committed results are retained. Provider-hidden usage stays unknown.`);
      }
    }
  }

  /**
   * Settle one attempted model invocation. Completeness is passed separately by the
   * adapter: only proven-complete accounting closes as known usage. Incomplete or
   * missing accounting records the attempted call (always `modelCalls: 1`) plus any
   * partial observed tokens and keeps the residual reservation held as unresolved
   * exposure. Only provider-reported cost may enter reported cost; a native Pi cost
   * estimate never does.
   */
  private settleModelCall(operationId: string, usage: ModelUsage | undefined, usageComplete: boolean | undefined, error?: string): void {
    const tokens = observedTokens(usage);
    const cost = usage?.costKind === 'provider-reported' && usage.cost !== undefined && usage.cost >= 0 ? { cost: usage.cost } : {};
    const meta = { ...cost, ...(error ? { error: short(error) } : {}) };
    const observed: Usage = { modelCalls: 1, ...(tokens !== undefined ? { modelTokens: tokens } : {}) };
    if (usageComplete === true && tokens !== undefined) {
      this.ledger.settle(operationId, observed, meta);
      return;
    }
    // Zeros or unproven completeness never prove unbilled tokens: hold the residual as unresolved exposure.
    this.ledger.settle(operationId, observed, { unknown: true, ...meta });
  }

  // ------------------------------------------------------------- model tasks

  private async callModel(task: TaskName, input: unknown): Promise<unknown> {
    const maxOutputTokens = OUTPUT_TOKENS[task];
    const bytes = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
    const amount: Usage = { modelCalls: 1, modelTokens: Math.ceil(bytes / 4) + FRAMING_TOKENS + maxOutputTokens };
    const lane: 'work' | 'synthesis' = task === 'report' ? 'synthesis' : 'work';
    this.precheck(amount, lane);
    this.assertGuard();
    const operationId = randomUUID();
    if (!this.ledger.reserve(this.state.allowanceId, operationId, { requestId: this.requestId, task, lane }, amount, lane)) {
      throw new StopRun(`${lane === 'synthesis' ? 'Synthesis' : 'Model'} allowance exhausted before the ${task} call; no unreserved call was dispatched.`);
    }
    this.ledger.dispatched(operationId);
    if (!this.guard()) { this.ledger.settle(operationId, {}); throw new StaleError(); } // stale before any invocation: no external work
    let response: ModelResponse;
    try {
      response = await this.host.model.complete(task, input, { signal: this.signal, maxOutputTokens });
    } catch (error) {
      if (error instanceof ModelCallError && !error.attempted) {
        this.ledger.settle(operationId, {}); // true preflight rejection: no external work happened
      } else if (error instanceof ModelCallError) {
        this.settleModelCall(operationId, error.observedUsage, error.usageComplete, message(error));
      } else {
        this.ledger.settle(operationId, { modelCalls: 1 }, { unknown: true, error: short(message(error)) }); // invoked; tokens unknown
      }
      throw error;
    }
    this.settleModelCall(operationId, response.usage, response.usageComplete);
    // A late success is settled above but never returned for publication after a stop.
    if (this.signal.aborted) throw this.abortReason();
    return response.value;
  }

  /**
   * One bounded repair as a separate reserved operation, only for proven output-shape
   * failures: the adapter's invalid-JSON flag (`error.repairable`) or this task's own
   * schema validation. Transport/provider errors (with observed usage or not), preflight
   * rejection and cancellation never trigger a repair.
   */
  private async validated<T>(task: TaskName, input: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
    const repairInput = (reason: string): Record<string, unknown> =>
      ({ ...input, repairNote: `Previous response failed validation: ${reason}. Return one corrected JSON object only.` });
    let raw: unknown;
    let repaired = false;
    try {
      raw = await this.callModel(task, input);
    } catch (error) {
      if (error instanceof StopRun || error instanceof StaleError || this.signal.aborted) throw error;
      if (!(error instanceof ModelCallError) || !error.repairable) throw error;
      repaired = true;
      raw = await this.callModel(task, repairInput(short(message(error))));
    }
    try {
      return parse(raw);
    } catch (error) {
      if (repaired || this.signal.aborted) throw error;
      return parse(await this.callModel(task, repairInput(short(message(error)))));
    }
  }

  // ------------------------------------------------------------- run entry points

  async run(input = '', kind: RunKind = 'start'): Promise<Investigation> {
    try {
      this.commit(draft => { draft.status = 'running'; draft.stopReason = undefined; });
      this.progress(`Research run started (${kind}).`);
      if (!this.state.objectives.length) await this.planInitial(input);
      else if (kind === 'continue') await this.followUp(input);
      if (kind === 'report') await this.refreshEvidence();
      else await this.workLoop();
      await this.finish(kind === 'report' ? 'Evidence refreshed from the current corpus; report synthesized from current evidence.' : DEFAULT_STOP, false);
      return this.state;
    } catch (error) {
      if (error instanceof StopRun) {
        try { await this.finish(message(error), error.paused); return this.state; }
        catch (nested) { return this.unwind(nested); }
      }
      return this.unwind(error);
    }
  }

  /** Authorized standalone acquisition of one pending source candidate. */
  async fetchSource(candidateId: string): Promise<Investigation> {
    try {
      const candidate = this.state.candidates.find(c => c.id === candidateId);
      if (!candidate) throw new Error('Unknown source candidate');
      if (candidate.status !== 'unread') throw new Error('Source candidate is not a pending unread action');
      this.commit(draft => { draft.status = 'running'; draft.stopReason = undefined; });
      this.progress(`Fetching authorized source ${candidate.url}.`);
      const outcome = await this.fetchCandidate(candidate, { nextAction: undefined });
      let yieldCount = 0;
      if (outcome === 'fetched') {
        const evaluation = await this.evaluateBranch(candidate.branchId);
        yieldCount = evaluation.yield;
        this.creditFetch(candidate.branchId, evaluation, candidate);
        this.noteEvaluation(evaluation);
      }
      this.commit(draft => {
        ResearchEngine.settleRunning(draft);
        draft.status = 'paused';
        draft.stopReason = outcome === 'fetched'
          ? `Authorized source fetch completed${yieldCount ? ` with ${yieldCount} new evidence contribution(s)` : ''}; continue explicitly.`
          : 'Authorized source fetch failed; the failure is recorded and will not be retried automatically.';
      });
      this.progress(this.state.stopReason ?? 'Fetch finished.');
      return this.state;
    } catch (error) {
      if (error instanceof StopRun) {
        this.pauseDisposition(message(error));
        return this.state;
      }
      return this.unwind(error);
    }
  }

  private async unwind(error: unknown): Promise<never> {
    if (error instanceof StaleError) throw error;
    const cancelled = this.signal.aborted;
    const reason = cancelled
      ? 'Cancelled while running; committed results are retained and no uncertain dispatch was retried.'
      : `Run stopped: ${message(error)}`;
    this.pauseDisposition(reason);
    throw error;
  }

  private async finish(stopReason: string, paused: boolean): Promise<void> {
    this.assertGuard();
    if (this.signal.aborted) throw this.signal.reason instanceof Error ? this.signal.reason : new Error('Research run aborted');
    const report = this.state.objectives.length ? await this.synthesize() : undefined;
    this.commit(draft => {
      ResearchEngine.settleRunning(draft);
      if (report) draft.reports.push(report);
      draft.status = paused ? 'paused' : 'complete';
      draft.stopReason = short(stopReason);
    });
    this.progress(`Research ${this.state.status}: ${this.state.stopReason ?? ''}`);
  }

  // ------------------------------------------------------------- planning

  private async planInitial(input: string): Promise<void> {
    const question = input.trim() || this.state.originalQuestion;
    let plan: PlanResult;
    try {
      plan = await this.validated('plan', { question, originalQuestion: this.state.originalQuestion }, parsePlan);
    } catch (error) {
      if (error instanceof StopRun || error instanceof StaleError || this.signal.aborted) throw error;
      throw new StopRun(`Initial planning unavailable: ${short(message(error))}; no objective was created and no evidence was fabricated, paused for explicit continuation.`, true);
    }
    this.commit(draft => {
      const objective: Objective = { id: randomUUID(), input: question, question: plan.question, constraints: plan.constraints, createdAt: now() };
      draft.objectives.push(objective);
      draft.activeObjectiveId = objective.id;
      for (const facet of plan.facets) {
        const needs = facet.needs.map(text => ({ id: randomUUID(), question: text, weight: 1 / facet.needs.length, status: 0 as const }));
        draft.branches.push({
          id: randomUUID(), objectiveId: objective.id, question: facet.question, anchor: facet.anchor,
          origin: 'initial', introducing: [], priority: clamp01(facet.priority), status: 'active',
          needs, aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
        });
      }
    });
    this.progress(`Objective resolved: ${plan.question} (${plan.facets.length} facets; needs are frozen for this revision).`);
  }

  private async followUp(input: string): Promise<void> {
    const current = this.state.objectives.find(o => o.id === this.state.activeObjectiveId);
    if (!current) { await this.planInitial(input); return; }
    const question = input.trim();
    if (!question || normalizeQuery(question) === normalizeQuery(current.question) || question === current.input) {
      // Empty/current-question continuation resumes the same objective: no revision, no cooldown reset.
      this.progress('Continuation matches the current objective; resuming without revision or cooldown reset.');
      return;
    }
    let plan: PlanResult;
    try {
      plan = await this.validated('plan', {
        originalQuestion: this.state.originalQuestion,
        previousObjective: { question: current.question, constraints: current.constraints },
        followUp: question,
      }, parsePlan);
    } catch (error) {
      if (error instanceof StopRun || error instanceof StaleError || this.signal.aborted) throw error;
      throw new StopRun(`Follow-up resolution unavailable: ${short(message(error))}; the current objective is unchanged, paused for explicit continuation.`, true);
    }
    this.commit(draft => {
      const constraints = [...current.constraints];
      for (const constraint of plan.constraints) {
        if (!constraints.some(existing => normalizeQuery(existing) === normalizeQuery(constraint))) constraints.push(constraint);
      }
      const objective: Objective = { id: randomUUID(), parentId: current.id, input: question, question: plan.question, constraints, createdAt: now() };
      draft.objectives.push(objective);
      draft.activeObjectiveId = objective.id;
      // Original question, corpus, contributions and reports are retained; prior-objective branches are archived, not erased.
      for (const branch of draft.branches) if (branch.objectiveId !== objective.id && branch.status !== 'archived') branch.status = 'archived';
      for (const facet of plan.facets) {
        const needs = facet.needs.map(text => ({ id: randomUUID(), question: text, weight: 1 / facet.needs.length, status: 0 as const }));
        draft.branches.push({
          id: randomUUID(), objectiveId: objective.id, question: facet.question, anchor: facet.anchor,
          origin: 'initial', introducing: [], priority: clamp01(facet.priority), status: 'active',
          needs, aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
        });
      }
    });
    this.progress(`Objective revised: ${plan.question}. Previous branches archived; corpus and reports retained.`);
  }

  // ------------------------------------------------------------- controller loop

  private async workLoop(): Promise<void> {
    while (true) {
      const proposal = chooseAction(this.state, { mode: this.options.mode, expand: this.options.expand });
      if (!proposal) throw new StopRun(DEFAULT_STOP);
      if (this.actions >= this.options.maxActions) throw new StopRun(`Action limit of ${this.options.maxActions} reached; outstanding needs stay visible.`);
      if (proposal.kind === 'retrieve') await this.runRetrieve(proposal);
      else if (proposal.kind === 'fetch') await this.runFetchProposal(proposal);
      else await this.searchEpisode(proposal);
    }
  }

  /** Report requests refresh only local evidence; no external dispatch. */
  private async refreshEvidence(): Promise<void> {
    if (!this.state.objectives.length || !this.state.passages.length) return;
    // Changed context is the refresh trigger: an unchanged key skips, so a fully
    // covered branch is only re-evaluated when corpus, objective, expansion or
    // feedback actually changed.
    const branches = this.state.branches.filter(b => b.objectiveId === this.state.activeObjectiveId &&
      (b.status === 'active' || b.status === 'cooldown') && b.retrievalKey !== retrievalKey(this.state, b, this.options.expand));
    for (const branch of branches) {
      if (this.actions >= this.options.maxActions) throw new StopRun(`Action limit of ${this.options.maxActions} reached during evidence refresh.`);
      await this.runRetrieve({ branchId: branch.id, kind: 'retrieve', query: branch.anchor, score: 0, reason: 'Report request: evaluate current corpus evidence before synthesis.' });
    }
  }

  private actionCheckpoint(proposal: ProposedAction, extra: (draft: Investigation, action: Action) => void): string {
    const actionId = randomUUID();
    this.actions++;
    this.commit(draft => {
      const action: Action = {
        id: actionId, objectiveId: draft.activeObjectiveId, branchId: proposal.branchId, kind: proposal.kind,
        score: proposal.score, reason: short(proposal.reason), status: 'running', startedAt: now(), yield: 0,
      };
      if (proposal.query !== undefined) action.query = proposal.query;
      if (proposal.candidateId !== undefined) action.candidateId = proposal.candidateId;
      draft.actions.push(action);
      const branch = draft.branches.find(b => b.id === proposal.branchId);
      if (branch) branch.nextAction = { kind: proposal.kind, score: proposal.score, reason: short(proposal.reason) };
      extra(draft, action);
    });
    return actionId;
  }

  private finalizeAction(actionId: string, status: Action['status'], yieldCount: number, error?: string, credit?: { branchId: string; kind: Action['kind'] }): void {
    this.commit(draft => {
      const action = draft.actions.find(a => a.id === actionId);
      if (action) {
        action.status = status;
        action.completedAt = now();
        action.yield = yieldCount;
        if (error) action.error = short(error);
      }
      if (credit) ResearchEngine.credit(draft, credit.branchId, credit.kind, yieldCount);
      if (yieldCount > 0) ResearchEngine.reopen(draft, credit?.branchId ?? '');
    });
  }

  private static credit(draft: Investigation, branchId: string, kind: Action['kind'], yieldCount: number): void {
    const branch = draft.branches.find(b => b.id === branchId);
    if (!branch) return;
    const stats = branch.stats[kind] ?? { completed: 0, successful: 0 };
    stats.completed += 1;
    if (yieldCount > 0) stats.successful += 1;
    branch.stats[kind] = stats;
  }

  /** Grounded evidence reopens a cooled branch; saturation is only cleared by yield. */
  private static reopen(draft: Investigation, branchId: string): void {
    const branch = draft.branches.find(b => b.id === branchId);
    if (branch && (branch.status === 'cooldown' || branch.zeroYieldEpisodes > 0)) {
      branch.status = branch.status === 'cooldown' ? 'active' : branch.status;
      branch.zeroYieldEpisodes = 0;
    }
  }

  private noteEvaluation(result: { yield: number; ok: boolean }): void {
    if (result.ok) { this.evalFailures = 0; return; }
    this.evalFailures += 1;
    if (this.evalFailures >= MAX_EVAL_FAILURES) {
      throw new StopRun('Model evaluation unavailable; stopping instead of dispatching further unassessed work.', true);
    }
  }

  private async runRetrieve(proposal: ProposedAction): Promise<void> {
    this.precheck({});
    const actionId = this.actionCheckpoint(proposal, () => { /* local retrieval consumes no reserved resource */ });
    this.progress(`Retrieving existing corpus for: ${proposal.reason.slice(0, 120)}`);
    const result = await this.evaluateBranch(proposal.branchId);
    this.finalizeAction(actionId, 'completed', result.yield, result.ok ? undefined : 'contextual assessment failed', { branchId: proposal.branchId, kind: 'retrieve' });
    this.noteEvaluation(result);
  }

  private async runFetchProposal(proposal: ProposedAction): Promise<void> {
    const candidate = proposal.candidateId ? this.state.candidates.find(c => c.id === proposal.candidateId) : undefined;
    if (!candidate || candidate.status !== 'unread') return; // eligibility changed; controller will re-route.
    const outcome = await this.fetchCandidate(candidate, { nextAction: proposal });
    if (outcome !== 'fetched') { this.noteEvaluation({ yield: 0, ok: true }); return; }
    const evaluation = await this.evaluateBranch(proposal.branchId);
    this.creditFetch(proposal.branchId, evaluation, candidate);
    this.noteEvaluation(evaluation);
  }

  /** Standalone fetch attribution: the fetch action owns its own evaluation yield. */
  private creditFetch(branchId: string, evaluation: { yield: number; ok: boolean }, candidate: SourceCandidate): void {
    this.commit(draft => {
      // fetchCandidate already finalized this action; attach the evaluation outcome to it.
      const action = [...draft.actions].reverse().find(a => a.kind === 'fetch' && a.candidateId === candidate.id);
      if (action) {
        if (action.status === 'running') { action.status = 'completed'; action.completedAt = now(); }
        action.yield = evaluation.yield;
        if (!evaluation.ok) action.error = 'contextual assessment failed';
      }
      ResearchEngine.credit(draft, branchId, 'fetch', evaluation.yield);
      if (evaluation.yield > 0) ResearchEngine.reopen(draft, branchId);
    });
  }

  private priorAttempts(): Set<string> {
    const attempted = new Set<string>();
    for (const action of this.state.actions) if (action.kind === 'search' && action.query) attempted.add(normalizeQuery(action.query));
    for (const branch of this.state.branches) for (const query of branch.queries) attempted.add(normalizeQuery(query));
    return attempted;
  }

  /**
   * Whether the work lane can still reserve one fetch. Exhaustion is not a StopRun
   * inside an episode: committed evidence is evaluated before dispatch stops.
   */
  private hasFetchCredit(): boolean {
    return (this.ledger.snapshot(this.state.allowanceId).lanes.work.remaining.fetches ?? 0) >= 1;
  }

  private async searchEpisode(proposal: ProposedAction): Promise<void> {
    const query = proposal.query;
    if (!query) throw new StopRun('Discovery proposal carried no query.');
    // Global repetition ban includes uncertain (running/interrupted/blocked) prior attempts.
    if (this.priorAttempts().has(normalizeQuery(query))) {
      this.commit(draft => {
        const branch = draft.branches.find(b => b.id === proposal.branchId);
        if (branch && !branch.queries.includes(query)) branch.queries.push(query);
      });
      return;
    }
    const allowanceId = this.state.allowanceId;
    this.precheck({ searches: 1 });
    this.assertGuard();
    const operationId = randomUUID();
    if (!this.ledger.reserve(allowanceId, operationId, { requestId: this.requestId, kind: 'search', query, branchId: proposal.branchId }, { searches: 1 })) {
      throw new StopRun('Search allowance exhausted; no discovery episode was dispatched.');
    }
    const actionId = this.actionCheckpoint(proposal, draft => {
      const branch = draft.branches.find(b => b.id === proposal.branchId);
      if (branch && !branch.queries.includes(query)) branch.queries.push(query);
    });
    this.ledger.dispatched(operationId);
    if (!this.guard()) { this.ledger.settle(operationId, {}); throw new StaleError(); } // stale before invocation: no external work
    this.progress(`Discovery episode started: ${query}`);
    let result: DiscoveryResult;
    try {
      result = await this.host.discover(query, this.signal);
    } catch (error) {
      if (this.signal.aborted) {
        this.ledger.settle(operationId, {}, { unknown: true, error: 'cancelled' });
        this.finalizeAction(actionId, 'interrupted', 0, message(error));
        throw error;
      }
      // Whether the provider actually ran is uncertain: hold the reservation, mark the attempt blocked.
      this.ledger.settle(operationId, {}, { unknown: true, error: short(message(error)) });
      this.finalizeAction(actionId, 'blocked', 0, message(error));
      this.progress(`Discovery failed without saturation credit: ${short(message(error))}`);
      return;
    }
    this.ledger.settle(operationId, { searches: 1 });

    const knownUrls = new Set(this.state.candidates.map(c => c.url));
    const created: SourceCandidate[] = [];
    for (const hit of result.results) {
      if (knownUrls.has(hit.url)) continue;
      knownUrls.add(hit.url);
      created.push({
        id: createHash('sha256').update(`${proposal.branchId}\0${query}\0${hit.url}`).digest('hex').slice(0, 32),
        branchId: proposal.branchId, query, url: hit.url, title: hit.title, snippet: hit.snippet,
        provider: result.provider, rankingKind: result.rankingKind, ...(hit.rank !== undefined ? { rank: hit.rank } : {}),
        discoveredAt: now(), status: 'unread',
      });
    }
    this.commit(draft => {
      for (const candidate of created) if (!draft.candidates.some(c => c.id === candidate.id)) draft.candidates.push(structuredClone(candidate));
      const action = draft.actions.find(a => a.id === actionId);
      if (action) action.candidateIds = created.map(c => c.id);
    });

    // One query, then up to N eligible new sources, then evaluation — before rescheduling.
    const eligible = created
      .filter(c => c.status === 'unread')
      .sort((a, b) => (b.branchId === proposal.branchId ? 1 : 0) - (a.branchId === proposal.branchId ? 1 : 0) ||
        ((a.rankingKind === 'ranked' ? a.rank ?? Infinity : Infinity) - (b.rankingKind === 'ranked' ? b.rank ?? Infinity : Infinity)) ||
        a.discoveredAt.localeCompare(b.discoveredAt) || a.id.localeCompare(b.id))
      .slice(0, this.options.maxFetchesPerEpisode);
    let attempts = 0;
    let ingested = 0;
    let truncated = false;
    for (const candidate of eligible) {
      // Never dispatch a fetch without credit: the episode closes truncated and still
      // evaluates the evidence already committed by its successful attempts.
      if (!this.hasFetchCredit()) { truncated = true; break; }
      const outcome = await this.fetchCandidate(candidate, { nextAction: proposal });
      attempts += 1;
      if (outcome === 'fetched') ingested += 1;
    }

    const evaluation = await this.evaluateBranch(proposal.branchId);
    // A truncated episode did not explore its planned sources: it can never certify saturation.
    const saturated = evaluation.ok && !truncated && !(attempts > 0 && ingested === 0);
    this.commit(draft => {
      const branch = draft.branches.find(b => b.id === proposal.branchId);
      const action = draft.actions.find(a => a.id === actionId);
      if (action) {
        action.status = 'completed';
        action.completedAt = now();
        action.yield = evaluation.yield;
        const notes: string[] = [];
        if (!evaluation.ok) notes.push('contextual assessment failed');
        if (truncated) notes.push(`fetch allowance exhausted; episode truncated after ${attempts}/${eligible.length} planned source attempt(s)`);
        if (notes.length) action.error = short(notes.join('; '));
      }
      if (branch) {
        if (evaluation.yield > 0) { branch.zeroYieldEpisodes = 0; if (branch.status === 'cooldown') branch.status = 'active'; }
        else if (saturated) {
          // Only completed, evaluated, zero-yield episodes count; blocked/failed/interrupted ones never do.
          branch.zeroYieldEpisodes += 1;
          if (branch.zeroYieldEpisodes >= 2 && branch.status === 'active') branch.status = 'cooldown';
        }
      }
      ResearchEngine.credit(draft, proposal.branchId, 'search', evaluation.yield);
    });
    this.progress(`Episode ${truncated ? 'truncated' : 'completed'}: ${ingested}/${attempts} sources ingested, ${evaluation.yield} new contribution(s).`);
    this.noteEvaluation(evaluation);
  }

  /** One fetch attempt with its own reservation and checkpoint; never retried automatically. */
  private async fetchCandidate(candidate: SourceCandidate, options: { nextAction?: ProposedAction }): Promise<'fetched' | 'failed' | 'skipped'> {
    if (candidate.status !== 'unread') return 'skipped';
    this.precheck({ fetches: 1 });
    this.assertGuard();
    const operationId = randomUUID();
    if (!this.ledger.reserve(this.state.allowanceId, operationId, { requestId: this.requestId, kind: 'fetch', candidateId: candidate.id, url: candidate.url }, { fetches: 1 })) {
      throw new StopRun('Fetch allowance exhausted; no source acquisition was dispatched.');
    }
    // The operation record must identify the actual operation: always a fetch bound to
    // this candidate. A routed fetch is recorded as routed; inside a search episode the
    // fetch stays subordinate — the episode keeps search credit and yield, and only the
    // branch's routing hint (not the record) retains the episode proposal.
    const routing = options.nextAction;
    const subordinate = routing !== undefined && routing.kind !== 'fetch';
    const proposal: ProposedAction = {
      branchId: candidate.branchId, kind: 'fetch', candidateId: candidate.id,
      score: subordinate ? 0 : routing?.score ?? 0,
      reason: subordinate
        ? `Subordinate source fetch within episode${routing?.query ? ` for "${routing.query}"` : ''}; episode owns search credit and yield.`
        : routing?.reason ?? 'Authorized pending source acquisition.',
    };
    const actionId = this.actionCheckpoint(proposal, draft => {
      if (!subordinate || !routing) return;
      const branch = draft.branches.find(b => b.id === candidate.branchId);
      if (branch) branch.nextAction = { kind: routing.kind, score: routing.score, reason: short(routing.reason) };
    });
    this.ledger.dispatched(operationId);
    if (!this.guard()) { this.ledger.settle(operationId, {}); throw new StaleError(); } // stale before invocation: no external work
    this.progress(`Fetching source: ${candidate.url}`);
    let snapshot: Snapshot;
    try {
      snapshot = await this.host.acquire(candidate.url, this.signal);
    } catch (error) {
      if (this.signal.aborted) {
        this.ledger.settle(operationId, { fetches: 1 }, { error: short(message(error)) });
        this.finalizeAction(actionId, 'interrupted', 0, message(error));
        this.commit(draft => {
          const stored = draft.candidates.find(c => c.id === candidate.id);
          if (stored) { stored.status = 'failed'; stored.error = short(message(error)); }
        });
        throw error;
      }
      this.ledger.settle(operationId, { fetches: 1 }, { error: short(message(error)) });
      const policy = /robots|policy|private|denied|redirect|invalid url/i.test(message(error));
      this.finalizeAction(actionId, 'blocked', 0, message(error));
      this.commit(draft => {
        const stored = draft.candidates.find(c => c.id === candidate.id);
        if (stored) { stored.status = policy ? 'blocked' : 'failed'; stored.error = short(message(error)); }
      });
      this.progress(`Source attempt closed as ${policy ? 'blocked' : 'failed'}; not saturation: ${short(message(error))}`);
      return 'failed';
    }
    this.ledger.settle(operationId, { fetches: 1 });
    if (this.signal.aborted) throw this.abortReason(); // late acquisition still cannot ingest; usage is already settled

    // The manifest may only reference a snapshot that persisted and round-trips intact.
    try {
      const persisted = await this.store.loadSnapshot(snapshot.id);
      if (persisted.id !== snapshot.id || persisted.textHash !== snapshot.textHash || persisted.text !== snapshot.text) {
        throw new Error('Persisted snapshot does not match the acquired snapshot');
      }
    } catch (error) {
      this.finalizeAction(actionId, 'blocked', 0, `snapshot not persisted: ${message(error)}`);
      this.commit(draft => {
        const stored = draft.candidates.find(c => c.id === candidate.id);
        if (stored) { stored.status = 'failed'; stored.error = short(`snapshot not persisted: ${message(error)}`); }
      });
      return 'failed';
    }

    try {
      this.commit(draft => {
        if (!draft.snapshotIds.includes(snapshot.id)) draft.snapshotIds.push(snapshot.id);
        const existing = new Set(draft.passages.map(p => p.id));
        const fresh = segment(snapshot).filter(p => p.snapshotId === snapshot.id && !existing.has(p.id));
        draft.passages.push(...fresh);
        draft.corpusRevision += 1;
        const stored = draft.candidates.find(c => c.id === candidate.id);
        if (stored) { stored.status = 'fetched'; stored.snapshotId = snapshot.id; }
        const action = draft.actions.find(a => a.id === actionId);
        if (action) { action.status = 'completed'; action.completedAt = now(); }
      });
    } catch (error) {
      // Ingestion contract failure: nothing was published; the attempt stays closed and visible.
      this.finalizeAction(actionId, 'blocked', 0, `ingestion failed: ${message(error)}`);
      this.commit(draft => {
        const stored = draft.candidates.find(c => c.id === candidate.id);
        if (stored) { stored.status = 'failed'; stored.error = short(`ingestion failed: ${message(error)}`); }
      });
      return 'failed';
    }
    this.indexCache = undefined;
    return 'fetched';
  }

  // ------------------------------------------------------------- index and evaluation

  /**
   * Build the retrieval index over visible passages and adopt `index.all()`
   * (grouping metadata only; state keeps membership and immutable facts), then
   * remap Contribution.duplicateGroup to the matching indexed passage.
   */
  private ensureIndex(): PassageIndex {
    if (this.indexCache) return this.indexCache;
    const index = new PassageIndex();
    index.add(this.state.passages);
    const indexed = new Map(index.all().map(p => [p.id, p]));
    const merged: Passage[] = this.state.passages.map(passage => {
      const candidate = indexed.get(passage.id);
      if (!candidate) return passage;
      if (candidate.snapshotId !== passage.snapshotId || candidate.start !== passage.start ||
          candidate.end !== passage.end || candidate.text !== passage.text) return passage;
      return candidate.duplicateGroup !== passage.duplicateGroup ? { ...passage, duplicateGroup: candidate.duplicateGroup } : passage;
    });
    const differs = merged.some((p, i) => p !== this.state.passages[i]);
    if (differs) {
      this.commit(draft => {
        draft.passages = merged.map(p => ({ ...p }));
        const byId = new Map(draft.passages.map(p => [p.id, p]));
        for (const contribution of draft.contributions) {
          const passage = byId.get(contribution.passageId);
          if (passage && passage.duplicateGroup !== contribution.duplicateGroup) contribution.duplicateGroup = passage.duplicateGroup;
        }
      });
    }
    this.indexCache = index;
    return index;
  }

  /**
   * Ranking and the changed-context key share one construction path, so the key
   * hashes the exact query the evaluation actually ranks. With `expand=false` the
   * anchor alone is used; concept growth cannot then invalidate a stored key.
   */
  private retrievalQuery(branch: Branch): string | Record<string, number> {
    return rankingQuery(this.state, branch, this.options.expand);
  }

  /**
   * Local evidence evaluation: rank → diversify → contextual assessment (gates
   * contributions and PRF) → grounded concept derivation → model classification
   * with code-controlled branch admission. Returns new contribution yield.
   */
  private async evaluateBranch(branchId: string): Promise<{ yield: number; ok: boolean }> {
    const branch = this.state.branches.find(b => b.id === branchId);
    if (!branch || branch.objectiveId !== this.state.activeObjectiveId || branch.status === 'archived' || branch.status === 'rejected') {
      return { yield: 0, ok: true };
    }
    // Changed context is eligible even at zero deficit: assessment may still return an
    // explicit coverage update or a qualifying/contradicting contribution. An unchanged
    // key skips only a zero-deficit evaluation; outstanding needs still evaluate.
    // Capture the key of the inputs actually ranked before the call: a key recomputed
    // after this evaluation's expansion would hide the new query from the next check.
    const evaluatedKey = retrievalKey(this.state, branch, this.options.expand);
    const changedKey = branch.retrievalKey !== evaluatedKey;
    if (!this.state.passages.length || (unmetMass(branch) <= 0 && !changedKey)) return { yield: 0, ok: true };
    const index = this.ensureIndex();
    const ranked = index.rank(this.retrievalQuery(branch), 30, [branch.anchor].filter(a => a.trim()));
    if (!ranked.length) {
      this.commit(draft => { const b = draft.branches.find(x => x.id === branchId); if (b) b.retrievalKey = evaluatedKey; });
      return { yield: 0, ok: true };
    }
    const hits: SearchHit[] = mmr(ranked); // contract-typed until core-ir lands; mmr returns SearchHit[] per the briefed interface
    const variants = nearVariants(ranked, hits);
    const supplied = [...hits, ...variants.map(v => v.hit)];
    const objective = this.state.objectives.find(o => o.id === this.state.activeObjectiveId)!;
    const assessed = new Set(this.state.contributions.filter(c => c.branchId === branchId).map(c => c.passageId));
    let assessment: EvidenceAssessment;
    try {
      assessment = await this.validated('assess', {
        objective: { question: objective.question, constraints: objective.constraints },
        branch: { id: branch.id, question: branch.question, anchor: branch.anchor, needs: branch.needs.map(n => ({ id: n.id, question: n.question, status: n.status })) },
        passages: hits.map(h => ({ passageId: h.passage.id, section: h.passage.section ?? null, page: h.passage.page ?? null, text: h.passage.text })),
        nearVariants: variants.map(v => ({
          passageId: v.hit.passage.id, variantOf: v.representativeId,
          section: v.hit.passage.section ?? null, page: v.hit.passage.page ?? null, text: v.hit.passage.text,
          note: 'Near-duplicate variant of the listed representative (same duplicate group). Inspect for changed numbers or negation; not independent corroboration and never used for expansion.',
        })),
        alreadyAssessedPassageIds: [...assessed],
      }, value => parseAssessment(value, branch, supplied));
    } catch (error) {
      if (error instanceof StopRun || error instanceof StaleError || this.signal.aborted) throw error;
      return { yield: 0, ok: false };
    }

    const relevant = new Set(assessment.relevantPassageIds);
    let yieldCount = 0;
    this.commit(draft => {
      const current = draft.branches.find(b => b.id === branchId);
      if (!current) return;
      const byPassage = new Map(draft.passages.map(p => [p.id, p]));
      const statusBefore = new Map(current.needs.map(n => [n.id, n.status]));
      const priorByNeed = new Map<string, number>();
      for (const contribution of draft.contributions) {
        if (contribution.objectiveId === draft.activeObjectiveId && contribution.branchId === branchId) {
          priorByNeed.set(contribution.needId, (priorByNeed.get(contribution.needId) ?? 0) + 1);
        }
      }
      const keys = new Set(draft.contributions.map(c => contributionKey(c.objectiveId, c.branchId, c.needId, c.duplicateGroup, c.role)));
      for (const added of assessment.contributions) {
        const passage = byPassage.get(added.passageId);
        const need = current.needs.find(n => n.id === added.needId);
        if (!passage || !need) continue;
        const key = contributionKey(draft.activeObjectiveId, branchId, added.needId, passage.duplicateGroup, added.role);
        const known = keys.has(key);
        const wasUnmet = (statusBefore.get(added.needId) ?? 0) < 1;
        const hadAnswer = (priorByNeed.get(added.needId) ?? 0) > 0;
        // Legacy assessments (no explicit coverageUpdates) may still raise coverage from a
        // passage that is already in the ledger. Yield itself stays unique via the key check.
        // `added.status` is validated to {0.5, 1}: this is max over the {0, 0.5, 1} domain
        // without a cast. Contradictions never close a need by themselves. An actual upgrade
        // also points the audit at this witness and the current corpus revision, so an older
        // partial justification cannot remain attached to an adequate status.
        if (added.role !== 'contradiction' && (added.status === 1 ? need.status < 1 : need.status === 0)) {
          need.status = added.status;
          need.assessment = {
            passageIds: [passage.id], reason: added.assessment,
            corpusRevision: draft.corpusRevision, createdAt: now(),
          };
        }
        if (known) continue; // duplicate group / repeated evidence cannot earn yield again
        keys.add(key);
        const useful = (added.role !== 'contradiction' && wasUnmet) ||
          ((added.role === 'qualification' || added.role === 'contradiction') && hadAnswer);
        if (useful) { yieldCount += 1; priorByNeed.set(added.needId, (priorByNeed.get(added.needId) ?? 0) + 1); }
        draft.contributions.push({
          objectiveId: draft.activeObjectiveId, branchId, needId: added.needId, passageId: passage.id,
          duplicateGroup: passage.duplicateGroup, role: added.role, assessment: added.assessment,
        });
      }
      // Explicit coverage updates are authoritative and applied last: exact status, never
      // inferred from omission or contradiction. The audit is persisted even when the status
      // is unchanged, and only an explicit update can lower coverage.
      for (const update of assessment.coverageUpdates ?? []) {
        const need = current.needs.find(n => n.id === update.needId);
        if (!need) continue;
        need.status = update.status;
        need.assessment = {
          passageIds: [...update.passageIds], reason: update.assessment,
          corpusRevision: draft.corpusRevision, createdAt: now(),
        };
      }
      current.retrievalKey = evaluatedKey;
    });
    if (yieldCount > 0) this.progress(`${yieldCount} new evidence contribution(s) for: ${branch.question}`);

    // PRF takes only ordinary representative relevant passages: near variants are
    // inspection context, never an independent corroborating source.
    const relevantHits = hits.filter(h => relevant.has(h.passage.id));
    if (this.options.expand && relevantHits.length) await this.expand(branch, relevantHits, index);
    return { yield: yieldCount, ok: true };
  }

  // ------------------------------------------------------------- expansion and admission

  private async expand(branch: Branch, relevantHits: SearchHit[], index: PassageIndex): Promise<void> {
    let derived: Concept[] = [];
    try { derived = deriveConcepts(relevantHits, branch, this.state.feedback, 12, index); }
    catch { return; } // expansion is optional; evaluation yield already committed
    const knownTerms = new Set(this.state.concepts.filter(c => c.branchId === branch.id).map(c => normalizeQuery(c.term)));
    const usable = derived.filter(concept => {
      if (concept.branchId !== branch.id || !concept.term.trim()) return false;
      if (this.state.concepts.some(c => c.id === concept.id)) return false;
      if (knownTerms.has(normalizeQuery(concept.term))) return false; // lexical dedup in code
      if (!Number.isFinite(concept.score) || !Number.isFinite(concept.anchorRelevance)) return false;
      if (!concept.introducing.length) return false;
      const passages = new Map(this.state.passages.map(p => [p.id, p]));
      return concept.introducing.every(span => {
        const passage = passages.get(span.passageId);
        return !!passage && Number.isInteger(span.start) && Number.isInteger(span.end) &&
          span.start >= 0 && span.end > span.start && span.end <= passage.text.length;
      });
    });
    if (!usable.length) return;
    const createdIds: string[] = [];
    this.commit(draft => { for (const concept of usable) { draft.concepts.push(structuredClone(concept)); createdIds.push(concept.id); } });
    await this.classify(createdIds);
  }

  private async classify(conceptIds: string[]): Promise<void> {
    const concepts = this.state.concepts.filter(c => conceptIds.includes(c.id));
    if (!concepts.length) return;
    const objective = this.state.objectives.find(o => o.id === this.state.activeObjectiveId)!;
    const byPassage = new Map(this.state.passages.map(p => [p.id, p]));
    const input = {
      objective: { question: objective.question, constraints: objective.constraints },
      branchContext: this.state.branches.filter(b => b.objectiveId === this.state.activeObjectiveId)
        .map(b => ({ id: b.id, question: b.question, anchor: b.anchor, status: b.status })),
      concepts: concepts.map(concept => ({
        id: concept.id, term: concept.term, score: concept.score, anchorRelevance: concept.anchorRelevance,
        introducing: concept.introducing.slice(0, 3).flatMap(span => {
          const passage = byPassage.get(span.passageId);
          return passage ? [{ passageId: span.passageId, start: span.start, end: span.end, text: passage.text }] : [];
        }),
      })),
    };
    let decisions;
    try {
      decisions = await this.validated('classify', input, value => parseDecisions(value, concepts));
    } catch (error) {
      if (error instanceof StopRun || error instanceof StaleError || this.signal.aborted) throw error;
      const reason = short(`classification unavailable after bounded repair: ${message(error)}`);
      this.commit(draft => { for (const id of conceptIds) { const c = draft.concepts.find(x => x.id === id); if (c && !c.classification) c.decision = reason; } });
      return;
    }
    this.commit(draft => {
      const pending: { concept: Concept; question: string; needs: string[] }[] = [];
      for (const decision of decisions) {
        const concept = draft.concepts.find(c => c.id === decision.conceptId);
        if (!concept || concept.classification) continue;
        concept.classification = decision.classification;
        concept.decision = short(decision.reason);
        if (decision.classification === 'alias') {
          const branch = draft.branches.find(b => b.id === concept.branchId);
          const term = normalizeQuery(concept.term);
          if (branch && term && !branch.aliases.some(alias => normalizeQuery(alias) === term)) branch.aliases.push(concept.term);
        } else if (decision.classification === 'branch' && decision.question && decision.needs?.length) {
          pending.push({ concept, question: decision.question, needs: decision.needs });
        }
      }
      this.admit(draft, pending);
    });
  }

  /** Code-controlled admission: B = 0.45·E + 0.35·A + 0.20·N, 2 per cycle, active cap, backlog retained. */
  private admit(draft: Investigation, pending: { concept: Concept; question: string; needs: string[] }[]): void {
    if (!pending.length) return;
    const existing = draft.branches.filter(b => b.objectiveId === draft.activeObjectiveId);
    const maxScore = Math.max(0, ...pending.map(p => p.concept.score));
    const scored = pending.map(p => {
      const expansion = maxScore > 0 ? clamp01(p.concept.score / maxScore) : 0;
      const anchor = clamp01(p.concept.anchorRelevance);
      const questionTerms = terms(p.question);
      const novelty = existing.length ? 1 - Math.max(...existing.map(b => overlap(questionTerms, terms(`${b.question} ${b.anchor}`)))) : 1;
      return { ...p, priority: clamp01(0.45 * expansion + 0.35 * anchor + 0.20 * clamp01(novelty)) };
    }).sort((a, b) => b.priority - a.priority || a.concept.id.localeCompare(b.concept.id));

    let cycle = 0;
    const activeCount = () => existing.filter(b => b.status === 'active' || b.status === 'cooldown').length;
    for (const item of scored) {
      const questionTerms = terms(item.question);
      const duplicate = existing.some(b => overlap(questionTerms, terms(`${b.question} ${b.anchor}`)) >= 0.8);
      if (duplicate || [...scored].slice(0, scored.indexOf(item)).some(other => normalizeQuery(other.question) === normalizeQuery(item.question))) {
        item.concept.decision = `${item.concept.decision ?? ''} Not admitted: lexically duplicates an existing or earlier proposed branch (code dedup).`.trim();
        continue;
      }
      if (cycle >= BRANCHES_PER_EXPANSION_CYCLE) {
        item.concept.decision = `${item.concept.decision ?? ''} Backlog: expansion cycle admits at most ${BRANCHES_PER_EXPANSION_CYCLE} new branches.`.trim();
        continue;
      }
      if (activeCount() >= this.options.maxActiveBranches) {
        item.concept.decision = `${item.concept.decision ?? ''} Backlog: active branch limit ${this.options.maxActiveBranches} reached; proposal retained.`.trim();
        continue;
      }
      const branch: Branch = {
        id: randomUUID(), objectiveId: draft.activeObjectiveId, question: item.question, anchor: item.concept.term,
        parentId: item.concept.branchId, origin: 'evidence', introducing: item.concept.introducing,
        priority: item.priority, status: 'active',
        needs: item.needs.map(text => ({ id: randomUUID(), question: text, weight: 1 / item.needs.length, status: 0 as const })),
        aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
      };
      draft.branches.push(branch);
      existing.push(branch);
      item.concept.admittedBranchId = branch.id;
      item.concept.decision = `${item.concept.decision ?? ''} Admitted as branch with priority ${item.priority.toFixed(3)} = 0.45·E + 0.35·A + 0.20·N.`.trim();
      cycle += 1;
    }
  }

  // ------------------------------------------------------------- synthesis

  private async visibleSnapshots(): Promise<Snapshot[]> {
    const snapshots: Snapshot[] = [];
    for (const id of this.state.snapshotIds) {
      try { snapshots.push(await this.store.loadSnapshot(id)); }
      catch { /* missing snapshot: its passages leave the evidence packet */ }
    }
    return snapshots;
  }

  /**
   * Bounded, full-passage packet from current-objective evidence only; offsets stay
   * passage-relative. The unchanged 40-passage/48k-character cap is filled in priority
   * order — current need-audit witnesses, then current-objective qualification and
   * contradiction contributions, then remaining eligible evidence in corpus order — so
   * a late audit or contradictory passage is not crowded out by chronology. Every
   * included passage stays whole; omitted eligible passages are reported to the model
   * as a bounded-packet count and caveat, never as confidence.
   */
  private async synthesize(): Promise<Report | undefined> {
    this.assertGuard();
    const snapshots = await this.visibleSnapshots();
    const evidence = reportEvidence(this.state, snapshots);
    const objective = this.state.objectives.find(o => o.id === this.state.activeObjectiveId)!;
    const branches = this.state.branches.filter(b => b.objectiveId === objective.id && b.status !== 'rejected' && b.status !== 'archived');
    const evidenceById = new Map(evidence.map(p => [p.id, p]));
    const ordered: string[] = [];
    const seen = new Set<string>();
    const take = (id: string): void => {
      if (seen.has(id) || !evidenceById.has(id)) return;
      seen.add(id);
      ordered.push(id);
    };
    for (const branch of branches) for (const need of branch.needs) for (const id of need.assessment?.passageIds ?? []) take(id);
    const currentBranchIds = new Set(branches.map(b => b.id));
    for (const contribution of this.state.contributions) {
      if (contribution.objectiveId !== objective.id || !currentBranchIds.has(contribution.branchId)) continue;
      if (contribution.role !== 'qualification' && contribution.role !== 'contradiction') continue;
      take(contribution.passageId);
    }
    for (const passage of evidence) take(passage.id);

    const bySnapshot = new Map(snapshots.map(s => [s.id, s]));
    const packet: { passageId: string; snapshotId: string; title: string; url: string; section: string | null; page: number | null; text: string }[] = [];
    let used = 0;
    for (const id of ordered) {
      if (packet.length >= REPORT_MAX_PASSAGES) break;
      const passage = evidenceById.get(id)!;
      if (used + passage.text.length > REPORT_MAX_CHARS) continue;
      const snapshot = bySnapshot.get(passage.snapshotId);
      if (!snapshot) continue;
      packet.push({
        passageId: passage.id, snapshotId: passage.snapshotId, title: snapshot.title,
        url: snapshot.finalUrl, section: passage.section ?? null, page: passage.page ?? null, text: passage.text,
      });
      used += passage.text.length;
      if (used >= REPORT_MAX_CHARS) break;
    }
    if (!packet.length) return buildReport(this.state, snapshots); // deterministic outline; no call, no fabrication
    const packetIds = new Set(packet.map(p => p.passageId));
    const evidenceOmitted = evidence.length - packet.length;
    const input = {
      objective: { question: objective.question, constraints: objective.constraints },
      branches: branches.map(b => ({
        question: b.question, status: b.status, aliases: b.aliases,
        needs: b.needs.map(n => ({
          question: n.question, status: n.status,
          ...(n.assessment ? {
            assessment: {
              reason: short(n.assessment.reason), corpusRevision: n.assessment.corpusRevision,
              createdAt: n.assessment.createdAt,
              witnessPassageIds: n.assessment.passageIds.filter(id => packetIds.has(id)),
            },
          } : {}),
        })),
      })),
      evidence: packet,
      evidenceOmitted,
      packetNote: `Bounded evidence packet: ${packet.length} of ${evidence.length} currently eligible passages are supplied (cap ${REPORT_MAX_PASSAGES} passages / ${REPORT_MAX_CHARS} characters; ${evidenceOmitted} omitted). Omitted passages are not evidence of absence: never infer confidence from the packet bound and never claim that a qualification or contradiction is missing.`,
      citationRule: 'Citations are {passageId, start, end} with UTF-16 offsets relative to the supplied passage text (base 0). Cite only supplied passageIds; never invent URLs or facts.',
    };
    const build = (value: unknown): Report => buildReport(this.state, snapshots, value, packetIds);
    let value: unknown;
    try {
      value = await this.callModel('report', input);
    } catch (error) {
      if (error instanceof StopRun || error instanceof StaleError || this.signal.aborted) {
        if (error instanceof StopRun) return buildReport(this.state, snapshots); // synthesis unavailable → deterministic
        throw error;
      }
      return buildReport(this.state, snapshots); // model failure → extractive fallback, never fabricated text
    }
    try {
      const report = build(value);
      if (!report.fallback) return report;
      // One bounded repair in the protected lane; if unaffordable the deterministic outline stands.
      const repaired = await this.callModel('report', { ...input, repairNote: 'Previous response failed citation/structure validation. Return one corrected JSON object only.' });
      const second = build(repaired);
      return second.fallback ? buildReport(this.state, snapshots) : second;
    } catch (error) {
      if (error instanceof StaleError || this.signal.aborted) throw error;
      return buildReport(this.state, snapshots); // bounded repair unavailable or still invalid → deterministic outline
    }
  }
}