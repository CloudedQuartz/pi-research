import { createHash } from 'node:crypto';
import type { ActionKind, Branch, Investigation, SourceCandidate } from './types.js';

export interface ProposedAction {
  branchId: string; kind: ActionKind; query?: string; candidateId?: string;
  score: number; reason: string;
}
export interface ControllerOptions { mode?: 'adaptive' | 'round-robin'; costs?: Partial<Record<ActionKind, number>>; }
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const terms = (text: string) => new Set(normalize(text).split(' ').filter(Boolean));
function overlap(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter(t => b.has(t)).length;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

export function unmetMass(branch: Branch): number {
  const total = branch.needs.reduce((sum, need) => sum + need.weight, 0);
  return total ? branch.needs.reduce((sum, need) => sum + need.weight * (1 - need.status), 0) / total : 0;
}

export function retrievalKey(state: Investigation, branch: Branch): string {
  return createHash('sha256').update(JSON.stringify({ objective: state.activeObjectiveId, corpus: state.corpusRevision,
    anchor: branch.anchor, aliases: branch.aliases,
    concepts: state.concepts.filter(c => c.branchId === branch.id && (c.classification === 'alias' || c.classification === 'branch')).map(c => c.id).sort(),
    feedback: state.feedback.length })).digest('hex');
}

/** Each web-query variant is tied to an objective need or a passage-derived alias. */
export function nextQuery(branch: Branch, previousQueries: string[] = []): string | undefined {
  const attempted = new Set([...branch.queries, ...previousQueries].map(normalize));
  const variants = [branch.anchor, ...branch.aliases.map(alias => `${branch.anchor} ${alias}`), branch.question,
    ...branch.needs.filter(n => n.status < 1).map(n => `${branch.anchor} ${n.question}`)];
  return variants.find(query => query.trim() && !attempted.has(normalize(query)));
}

function candidateRelevance(candidate: SourceCandidate, branch: Branch): number {
  const anchor = terms(`${branch.anchor} ${branch.question} ${branch.aliases.join(' ')}`);
  const metadata = terms(`${candidate.title} ${candidate.snippet} ${candidate.query}`);
  const lexical = overlap(anchor, metadata);
  return candidate.branchId === branch.id ? Math.max(lexical, 0.5) : lexical;
}

/** Pure routing policy; dispatch, ownership, hard allowances and commits live elsewhere. */
export function chooseAction(state: Investigation, options: ControllerOptions = {}): ProposedAction | undefined {
  const branches = state.branches.filter(b => b.objectiveId === state.activeObjectiveId &&
    (b.status === 'active' || b.status === 'cooldown') && b.priority > 0 && unmetMass(b) > 0);
  if (!branches.length) return undefined;
  const costs = { retrieve: 0.1, fetch: 2, search: 7, ...options.costs };
  for (const value of Object.values(costs)) if (!Number.isFinite(value) || value <= 0) throw new Error('Controller costs must be positive finite scheduling estimates');
  const proposals: ProposedAction[] = [];
  for (const branch of branches) {
    const deficit = unmetMass(branch);
    const probability = (kind: ActionKind) => {
      const history = branch.stats[kind];
      if (history?.completed) return (1 + history.successful) / (2 + history.completed);
      const pooled = state.branches.reduce((sum, b) => ({
        completed: sum.completed + (b.stats[kind]?.completed ?? 0),
        successful: sum.successful + (b.stats[kind]?.successful ?? 0),
      }), { completed: 0, successful: 0 });
      return (1 + pooled.successful) / (2 + pooled.completed);
    };
    const utility = (kind: ActionKind, novelty: number) => branch.priority * deficit * probability(kind) * novelty / costs[kind];
    const explain = (kind: ActionKind, novelty: number) => `priority=${branch.priority.toFixed(3)}, unmet=${deficit.toFixed(3)}, useful-yield estimate=${probability(kind).toFixed(3)}, novelty=${novelty.toFixed(3)}, estimated cost=${costs[kind].toFixed(3)}`;
    if (state.passages.length && branch.retrievalKey !== retrievalKey(state, branch)) proposals.push({
      branchId: branch.id, kind: 'retrieve', query: branch.anchor, score: utility('retrieve', 1),
      reason: `Objective, corpus, grounded expansion or feedback changed; evaluate existing evidence before acquisition. ${explain('retrieve', 1)}`,
    });
    const unread = state.candidates.filter(c => c.status === 'unread').map(c => ({ candidate: c, relevance: candidateRelevance(c, branch) })).filter(c => c.relevance > 0);
    unread.sort((a, b) => b.relevance - a.relevance ||
      (a.candidate.rankingKind === 'ranked' && b.candidate.rankingKind === 'ranked' ? (a.candidate.rank ?? Infinity) - (b.candidate.rank ?? Infinity) : 0) ||
      a.candidate.id.localeCompare(b.candidate.id));
    const candidate = unread[0];
    if (candidate) proposals.push({ branchId: branch.id, kind: 'fetch', candidateId: candidate.candidate.id,
      score: utility('fetch', candidate.relevance), reason: `A relevant discovered source remains unread; metadata relevance estimates usefulness, not factual support. ${explain('fetch', candidate.relevance)}` });
    const query = nextQuery(branch, state.actions.flatMap(a => a.kind === 'search' && a.query ? [a.query] : []));
    if (branch.status === 'active' && query) {
      const novelty = branch.queries.length ? 1 - Math.max(...branch.queries.map(q => overlap(terms(q), terms(query)))) : 1;
      proposals.push({ branchId: branch.id, kind: 'search', query, score: utility('search', novelty),
        reason: `Unmet answer needs remain; grounded query. Search cost estimates include source evaluation. ${explain('search', novelty)}` });
    }
  }
  // Local-first is an eligibility policy, not a fabricated zero external cost.
  const local = proposals.filter(p => p.kind === 'retrieve');
  if (local.length) return local.sort((a, b) => b.score - a.score || a.branchId.localeCompare(b.branchId))[0];
  const unexplored = proposals.filter(p => p.kind === 'search' && !branches.find(b => b.id === p.branchId)!.queries.length);
  if (unexplored.length) return unexplored.sort((a, b) => b.score - a.score || a.branchId.localeCompare(b.branchId))[0];
  if (options.mode === 'round-robin') {
    const counts = (id: string) => state.actions.filter(a => a.branchId === id && a.kind !== 'retrieve' && a.status !== 'running').length;
    return proposals.filter(p => p.score > 0).sort((a, b) => counts(a.branchId) - counts(b.branchId) || a.branchId.localeCompare(b.branchId) || a.kind.localeCompare(b.kind))[0];
  }
  return proposals.filter(p => p.score > 0).sort((a, b) => b.score - a.score || a.branchId.localeCompare(b.branchId) || a.kind.localeCompare(b.kind))[0];
}
