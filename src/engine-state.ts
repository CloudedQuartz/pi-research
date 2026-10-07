import { randomUUID } from 'node:crypto';
import { validateInvestigation } from './object-store.js';
import type { Feedback, Investigation } from './types.js';

export interface InvestigationSeed { id: string; allowanceId: string; storageRoot: string; question: string; }

export function newInvestigation(seed: InvestigationSeed): Investigation {
  if (!seed.question.trim()) throw new Error('Research requires a nonempty question');
  return validateInvestigation({ schema: 1, id: seed.id, revisionId: randomUUID(), allowanceId: seed.allowanceId,
    storageRoot: seed.storageRoot, originalQuestion: seed.question.trim(), objectives: [], activeObjectiveId: '',
    branches: [], candidates: [], snapshotIds: [], passages: [], concepts: [], contributions: [], actions: [],
    feedback: [], reports: [], corpusRevision: 0, status: 'paused' });
}

/** Pure feedback transformation; callers must hold the durable writer before publication. */
export function feedback(input: Investigation, targetId: string, kind: Feedback['kind']): Investigation {
  const state = validateInvestigation(input);
  if (state.status === 'running') throw new Error('Pause research before applying feedback');
  if (!['useful', 'irrelevant', 'accept', 'reject', 'prioritize'].includes(kind)) throw new Error('Unknown feedback kind');
  if (kind === 'useful' || kind === 'irrelevant') {
    if (!state.passages.some(p => p.id === targetId)) throw new Error('Evidence feedback targets a branch-visible passage ID');
    if (kind === 'irrelevant') {
      const affected = state.contributions.filter(c => c.objectiveId === state.activeObjectiveId && c.passageId === targetId);
      for (const c of affected) {
        const need = state.branches.find(b => b.id === c.branchId)?.needs.find(n => n.id === c.needId);
        // Other passages may still address the need; cached re-assessment, not guessing, restores coverage.
        if (need) need.status = 0;
      }
    }
  } else {
    const branch = state.branches.find(b => b.id === targetId && b.objectiveId === state.activeObjectiveId);
    if (!branch || branch.status === 'archived') throw new Error('Branch feedback targets a current, non-archived branch');
    if (kind === 'reject') branch.status = 'rejected';
    if (kind === 'prioritize') branch.priority = 1;
    if (kind === 'accept' && branch.status !== 'active' && branch.status !== 'cooldown') {
      const active = state.branches.filter(b => b.objectiveId === state.activeObjectiveId && (b.status === 'active' || b.status === 'cooldown')).length;
      if (active >= 8) throw new Error('Active branch limit reached; reject a branch or refine the objective first');
      branch.status = 'active';
    }
  }
  state.feedback.push({ id: randomUUID(), targetId, kind, createdAt: new Date().toISOString() });
  state.revisionId = randomUUID();
  state.status = 'paused';
  state.stopReason = 'User feedback recorded; explicit continuation is required.';
  return validateInvestigation(state);
}
