import { randomUUID } from 'node:crypto';
import type { Investigation, Passage, Report, Snapshot, Span, Statement } from './types.js';

const plain = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g, '').replace(/\s+/g, ' ').trim();
const md = (text: string) => plain(text).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 4000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid report text');
  return plain(value);
};

/** Mechanical provenance validation, not a proof of semantic support. */
export function validateSpan(span: Span, passage: Passage, snapshot: Snapshot): void {
  if (span.passageId !== passage.id || passage.snapshotId !== snapshot.id ||
      !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
      span.start < 0 || span.end <= span.start || span.end > passage.text.length ||
      !Number.isInteger(passage.start) || !Number.isInteger(passage.end) ||
      passage.start < 0 || passage.end <= passage.start || passage.end > snapshot.text.length ||
      snapshot.text.slice(passage.start, passage.end) !== passage.text) {
    throw new Error('Citation does not resolve to an immutable passage span');
  }
}

/** Only current, non-rejected branches and the latest passage feedback authorize evidence. */
export function reportEvidence(state: Investigation, snapshots: Snapshot[]): Passage[] {
  const visible = new Set(snapshots.filter(s => state.snapshotIds.includes(s.id)).map(s => s.id));
  const branches = new Set(state.branches.filter(b => b.objectiveId === state.activeObjectiveId && b.status !== 'rejected' && b.status !== 'archived').map(b => b.id));
  const latestFeedback = new Map<string, 'useful' | 'irrelevant'>();
  for (const f of state.feedback) if (f.kind === 'useful' || f.kind === 'irrelevant') latestFeedback.set(f.targetId, f.kind);
  const ids = new Set(state.contributions.filter(c => c.objectiveId === state.activeObjectiveId && branches.has(c.branchId) && latestFeedback.get(c.passageId) !== 'irrelevant').map(c => c.passageId));
  return state.passages.filter(p => ids.has(p.id) && visible.has(p.snapshotId));
}

/** Invalid or unavailable synthesis becomes an explicitly extractive outline. */
export function buildReport(state: Investigation, snapshots: Snapshot[], modelValue?: unknown): Report {
  const objective = state.objectives.find(o => o.id === state.activeObjectiveId);
  if (!objective) throw new Error('Cannot report without an objective');
  const visible = new Map(snapshots.filter(s => state.snapshotIds.includes(s.id)).map(s => [s.id, s]));
  const evidence = new Map(reportEvidence(state, snapshots).map(p => [p.id, p]));
  const spanFor = (id: string): Span => {
    const passage = evidence.get(id);
    if (!passage) throw new Error('Citation was not in the current evidence packet');
    return { passageId: id, start: 0, end: passage.text.length };
  };
  let sections: Report['sections'] = [];
  let fallback = modelValue === undefined;
  if (!fallback) {
    try {
      const value = object(modelValue);
      if (!Array.isArray(value.sections) || value.sections.length < 1 || value.sections.length > 12) throw new Error('Invalid report sections');
      sections = value.sections.map(raw => {
        const section = object(raw);
        if (!Array.isArray(section.statements) || section.statements.length < 1 || section.statements.length > 20) throw new Error('Invalid statements');
        return { title: text(section.title, 200), statements: section.statements.map(rawStatement => {
          const item = object(rawStatement);
          const statementText = text(item.text);
          if (!Array.isArray(item.citations) || item.citations.length < 1 || item.citations.length > 8) throw new Error('Uncited statement');
          const citations = item.citations.map(rawSpan => {
            const s = object(rawSpan);
            const id = text(s.passageId, 150);
            const p = evidence.get(id);
            if (!p) throw new Error('Unknown/currently irrelevant passage');
            if (typeof s.start !== 'number' || typeof s.end !== 'number') throw new Error('Citation offsets must be JSON numbers');
            const span: Span = { passageId: id, start: s.start, end: s.end };
            validateSpan(span, p, visible.get(p.snapshotId)!);
            return span;
          });
          return { text: statementText, citations } satisfies Statement;
        }) };
      });
    } catch {
      sections = [];
      fallback = true;
    }
  }
  if (fallback) {
    sections = state.branches.filter(b => b.objectiveId === objective.id && b.status !== 'rejected' && b.status !== 'archived').map(branch => {
      const ids = [...new Set(state.contributions.filter(c => c.objectiveId === objective.id && c.branchId === branch.id).map(c => c.passageId))].filter(id => evidence.has(id)).slice(0, 5);
      return { title: branch.question, statements: ids.map(id => {
        const p = evidence.get(id)!;
        const span = spanFor(id);
        validateSpan(span, p, visible.get(p.snapshotId)!);
        return { text: p.text, citations: [span] };
      }) };
    }).filter(s => s.statements.length > 0);
  }
  const unresolved = state.branches.filter(b => b.objectiveId === objective.id && b.status !== 'archived' && b.status !== 'rejected').flatMap(b => b.needs.filter(n => n.status < 1).map(n => `${b.question}: ${n.question} (${n.status === 0.5 ? 'partial' : 'open'})`));
  const previous = state.reports.at(-1);
  const oldTexts = new Set(previous?.sections.flatMap(s => s.statements.map(t => t.text)) ?? []);
  const newTexts = new Set(sections.flatMap(s => s.statements.map(t => t.text)));
  const changes = previous ? [
    ...(previous.objectiveId !== objective.id ? [`Objective revised: ${objective.question}`] : []),
    `${[...newTexts].filter(t => !oldTexts.has(t)).length} statements added; ${[...oldTexts].filter(t => !newTexts.has(t)).length} previous statements removed or revised.`,
    `Corpus revision ${previous.corpusRevision} → ${state.corpusRevision}.`,
  ] : ['Initial report.'];
  const footnotes = new Map<string, { p: Passage; s: Snapshot; span: Span }>();
  const lines = [`# ${md(objective.question)}`, '',
    `Objective: ${objective.id} · corpus revision: ${state.corpusRevision}`, '',
    fallback ? '> Extractive evidence outline: model synthesis was unavailable or failed validation. Quotes are not an integrated answer.' : '> Citations resolve mechanically to source spans. Semantic support remains subject to review.', '',
    ...(objective.constraints.length ? ['## Scope constraints', ...objective.constraints.map(c => `- ${md(c)}`), ''] : []),
  ];
  for (const section of sections) {
    lines.push(`## ${md(section.title)}`, '');
    for (const statement of section.statements) {
      const refs = statement.citations.map(span => {
        const key = `${span.passageId}-${span.start}-${span.end}`;
        footnotes.set(key, { p: evidence.get(span.passageId)!, s: visible.get(evidence.get(span.passageId)!.snapshotId)!, span });
        return `[^${key}]`;
      });
      lines.push(`${fallback ? '> ' : ''}${md(statement.text)} ${refs.join(' ')}`, '');
    }
  }
  if (!sections.length) lines.push('No contextual evidence was accepted for this objective.', '');
  lines.push('## Unresolved needs', '', ...(unresolved.length ? unresolved.map(u => `- ${md(u)}`) : ['No open needs in the current assessment; this does not establish factual confidence.']), '',
    '## What changed', '', ...changes.map(c => `- ${md(c)}`), '', `Stop reason: ${md(state.stopReason ?? 'report requested')}`, '', '## Sources and exact spans', '');
  for (const [key, { p, s, span }] of footnotes) {
    let url: URL;
    try { url = new URL(s.finalUrl); }
    catch { throw new Error(`Invalid URL in source snapshot ${s.id}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid citation URL');
    const start = p.start + span.start, end = p.start + span.end;
    const first = s.pages?.find(page => page.start <= start && start < page.end);
    const last = s.pages?.find(page => page.start <= end - 1 && end - 1 < page.end);
    let location = '';
    if (first && last) location = first.page === last.page ? `; page ${first.page}` : `; pages ${first.page}–${last.page}`;
    lines.push(`[^${key}]: ${md(s.title || s.finalUrl)} — ${url.href.replace(/[<>\s]/g, c => encodeURIComponent(c))} — fetched ${s.fetchedAt}; snapshot \`${s.id}\`; passage \`${p.id}\`; extracted-text offsets ${start}–${end}${location}.`, '');
  }
  return { id: randomUUID(), objectiveId: objective.id, corpusRevision: state.corpusRevision, createdAt: new Date().toISOString(), sections, unresolved, changes, markdown: lines.join('\n'), fallback };
}
