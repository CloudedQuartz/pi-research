import type { Action, Branch, Concept, Contribution, Investigation, Passage, SearchHit, Snapshot, SourceCandidate } from './types.js';

export type Inspection = Branch | Concept | SourceCandidate | Action | {
  passage: Passage;
  source: Pick<Snapshot, 'id' | 'fetchedAt' | 'extraction' | 'extractionVersion'> & { url: string };
  exactText: string; contributions: Contribution[]; introducedConcepts: Concept[];
};

/** Prevent terminal control sequences from untrusted source strings. */
export const safeText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');

export function researchMap(state: Investigation): string {
  const objective = state.objectives.find(o => o.id === state.activeObjectiveId);
  const lines = [`Investigation ${state.id} · ${state.status}`, `Objective: ${objective?.question ?? state.originalQuestion}`, `Corpus revision ${state.corpusRevision} · ${state.snapshotIds.length} visible snapshots · ${state.passages.length} passages`, 'Answer coverage is not factual confidence.', ''];
  for (const b of state.branches.filter(b => b.objectiveId === state.activeObjectiveId)) {
    const total = b.needs.reduce((sum, n) => sum + n.weight, 0);
    const coverage = total ? b.needs.reduce((sum, n) => sum + n.weight * n.status, 0) / total : 0;
    lines.push(`${b.parentId ? '  ↳ ' : ''}${b.question} [${b.status}]`, `  ID ${b.id} · priority ${b.priority.toFixed(2)} · answer coverage ${(100 * coverage).toFixed(0)}%`);
    if (b.introducing.length) lines.push(`  Introduced by ${b.introducing.map(s => `${s.passageId}:${s.start}–${s.end}`).join(', ')}`);
    for (const need of b.needs) lines.push(`  ${need.status === 1 ? 'addressed' : need.status === 0.5 ? 'partial' : 'open'}: ${need.question}`);
    lines.push(`  Recent zero-yield search episodes: ${b.zeroYieldEpisodes}`);
    if (b.nextAction) lines.push(`  Next: ${b.nextAction.kind} · utility ${b.nextAction.score.toFixed(4)} · ${b.nextAction.reason}`);
    for (const c of state.concepts.filter(c => c.branchId === b.id).slice(-6)) lines.push(`  Concept “${c.term}”: ${c.classification ?? 'pending'} · TF-IDF ${c.score.toFixed(4)} · ${c.decision ?? 'not yet classified'}`);
    lines.push('');
  }
  if (state.stopReason) lines.push(`Stop reason: ${state.stopReason}`);
  return safeText(lines.join('\n'));
}

export function sourceList(state: Investigation, snapshots: Snapshot[] = []): string {
  const visible = snapshots.filter(s => state.snapshotIds.includes(s.id));
  const hosts = new Map<string, number>();
  for (const snapshot of visible) {
    let host: string;
    try { host = new URL(snapshot.finalUrl).hostname; }
    catch { throw new Error(`Invalid URL in visible source ${snapshot.id}`); }
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const warnings = [...hosts].filter(([, count]) => visible.length > 1 && count / visible.length > 0.6)
    .map(([host, count]) => `Source concentration: ${count}/${visible.length} acquired snapshot records are from ${host}. This is not credibility or factual confidence.`);
  const sources = state.candidates.map(c => `${c.id} [${c.status}] ${c.title}\n  ${c.url}\n  ${c.provider} / ${c.rankingKind}${c.rank ? ` rank ${c.rank}` : ''} · query: ${c.query}${c.error ? `\n  ${c.error}` : ''}`).join('\n\n') || 'No discovered sources.';
  return safeText([...warnings, 'Discovery metadata is not original evidence; snapshot/domain counts are not confidence.', '', sources].join('\n'));
}

export function inspectState(state: Investigation, id: string, snapshots: Snapshot[]): Inspection {
  const passage = state.passages.find(p => p.id === id);
  if (passage) {
    const snapshot = snapshots.find(s => s.id === passage.snapshotId && state.snapshotIds.includes(s.id));
    if (!snapshot) throw new Error('Passage snapshot not visible on this branch');
    return { passage, source: { id: snapshot.id, url: snapshot.finalUrl, fetchedAt: snapshot.fetchedAt, extraction: snapshot.extraction, extractionVersion: snapshot.extractionVersion }, exactText: snapshot.text.slice(passage.start, passage.end), contributions: state.contributions.filter(c => c.passageId === id), introducedConcepts: state.concepts.filter(c => c.introducing.some(s => s.passageId === id)) };
  }
  const result = state.branches.find(b => b.id === id) ?? state.concepts.find(c => c.id === id) ?? state.candidates.find(c => c.id === id) ?? state.actions.find(a => a.id === id);
  if (!result) throw new Error('Unknown or branch-invisible ID');
  return result;
}

export function rankText(hits: SearchHit[]): string {
  return safeText(hits.map((h, i) => `${i + 1}. ${h.passage.id} score=${h.score.toFixed(4)}${h.mmr !== undefined ? ` mmr=${h.mmr.toFixed(4)}` : ''}\n  length ${h.length}; avg ${h.averageLength.toFixed(2)}; phrase bonus ${h.phraseBonus.toFixed(4)}\n${h.terms.map(t => `  ${t.term}: weight=${t.weight.toFixed(3)} tf=${t.tf} df=${t.df} idf=${t.idf.toFixed(4)} contribution=${t.contribution.toFixed(4)}`).join('\n')}\n  ${h.passage.text}`).join('\n\n'));
}
