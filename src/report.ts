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
  for (const branch of state.branches) if (branches.has(branch.id)) {
    for (const need of branch.needs) for (const id of need.assessment?.passageIds ?? []) {
      if (latestFeedback.get(id) !== 'irrelevant') ids.add(id);
    }
  }
  return state.passages.filter(p => ids.has(p.id) && visible.has(p.snapshotId));
}

export interface Corroboration {
  rawPassages: number;
  distinctGroups: number;
  distinctDomains: number;
  isSyndicated: boolean;
}

/**
 * Computes corroboration metrics for a report statement across its citations,
 * detecting whether multiple citations originate from the same duplicate group or domain.
 */
export function statementCorroboration(
  statement: Statement,
  evidence: Map<string, Passage>,
  visible: Map<string, Snapshot>
): Corroboration {
  const rawPassages = statement.citations.length;
  const groups = new Set<string>();
  const domains = new Set<string>();

  for (const span of statement.citations) {
    const p = evidence.get(span.passageId);
    if (p) {
      groups.add(p.duplicateGroup || p.id);
      const s = visible.get(p.snapshotId);
      if (s) {
        try { domains.add(new URL(s.finalUrl).hostname.toLowerCase()); } catch { /* ignore */ }
      }
    }
  }

  const distinctGroups = groups.size;
  const distinctDomains = domains.size;
  const isSyndicated = rawPassages > 1 && (distinctGroups < rawPassages || (distinctDomains > 0 && distinctDomains < rawPassages));
  return { rawPassages, distinctGroups, distinctDomains, isSyndicated };
}

/** Invalid or unavailable synthesis becomes an explicitly extractive outline.
 * Optional packet IDs restrict model citations; the deterministic outline uses visible evidence.
 */
export function buildReport(state: Investigation, snapshots: Snapshot[], modelValue?: unknown, allowedPassageIds?: ReadonlySet<string>): Report {
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
            if (!p || (allowedPassageIds !== undefined && !allowedPassageIds.has(id))) throw new Error('Passage was not in the supplied synthesis packet');
            let start = typeof s.start === 'number' && Number.isFinite(s.start) ? Math.floor(s.start) : 0;
            let end = typeof s.end === 'number' && Number.isFinite(s.end) ? Math.floor(s.end) : p.text.length;
            if (start < 0) start = 0;
            if (start >= p.text.length) start = Math.max(0, p.text.length - 1);
            if (end <= start) end = p.text.length > start ? p.text.length : start + 1;
            if (end > p.text.length) end = p.text.length;
            const span: Span = { passageId: id, start, end };
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
      const contributions = state.contributions.filter(c => c.objectiveId === objective.id && c.branchId === branch.id);
      const witnesses = branch.needs.flatMap(n => n.assessment?.passageIds ?? []);
      const qualifications = contributions.filter(c => c.role !== 'support').map(c => c.passageId);
      const ids = [...new Set([...witnesses, ...qualifications, ...contributions.map(c => c.passageId)])].filter(id => evidence.has(id)).slice(0, 5);
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
  const footnotes = new Map<string, { num: number; p: Passage; s: Snapshot; span: Span }>();
  let footnoteSeq = 1;
  const lines = [`# ${md(objective.question)}`, '',
    `Objective: ${objective.id} · corpus revision: ${state.corpusRevision}`, '',
    fallback ? '> Extractive evidence outline: model synthesis was unavailable or failed validation. Quotes are extracted directly from verified evidence.' : '> Citations resolve mechanically to source spans. Semantic support remains subject to review.', '',
    ...(objective.constraints.length ? ['## Scope constraints', ...objective.constraints.map(c => `- ${md(c)}`), ''] : []),
  ];
  for (const section of sections) {
    lines.push(`## ${md(section.title)}`, '');
    for (const statement of section.statements) {
      const refs = statement.citations.map(span => {
        const key = `${span.passageId}-${span.start}-${span.end}`;
        let entry = footnotes.get(key);
        if (!entry) {
          entry = { num: footnoteSeq++, p: evidence.get(span.passageId)!, s: visible.get(evidence.get(span.passageId)!.snapshotId)!, span };
          footnotes.set(key, entry);
        }
        return `[^${entry.num}]`;
      });
      lines.push(`${fallback ? '> ' : ''}${md(statement.text)} ${refs.join(' ')}`, '');
    }
  }
  if (!sections.length) lines.push('No contextual evidence was accepted for this objective.', '');
  lines.push('## Unresolved needs', '', ...(unresolved.length ? unresolved.map(u => `- ${md(u)}`) : ['No open needs in the current assessment; this does not establish factual confidence.']), '',
    '## What changed', '', ...changes.map(c => `- ${md(c)}`), '', `Stop reason: ${md(state.stopReason ?? 'report requested')}`, '', '## Sources and exact spans', '');
  const statementSyndications = sections.flatMap(sec => sec.statements)
    .filter(st => st.citations.length > 1)
    .map(st => statementCorroboration(st, evidence, visible))
    .filter(c => c.isSyndicated);
  if (statementSyndications.length > 0) {
    lines.push(`> Responsible IR note: ${statementSyndications.length} statement(s) cite syndicated or duplicate coverage. Duplicate copies are not independent corroboration.`, '');
  }
  for (const [key, { num, p, s, span }] of footnotes) {
    let url: URL;
    try { url = new URL(s.finalUrl); }
    catch { throw new Error(`Invalid URL in source snapshot ${s.id}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid citation URL');
    const start = p.start + span.start, end = p.start + span.end;
    const first = s.pages?.find(page => page.start <= start && start < page.end);
    const last = s.pages?.find(page => page.start <= end - 1 && end - 1 < page.end);
    let location = '';
    if (first && last) location = first.page === last.page ? `; page ${first.page}` : `; pages ${first.page}–${last.page}`;
    const datePart = s.publishedAt ? ` · published ${s.publishedAt.slice(0, 10)} (source-claimed)` : '';
    lines.push(`[^${num}]: [${md(s.title || s.finalUrl)}](${url.href}) — fetched ${s.fetchedAt.slice(0, 10)}${datePart} (passage ${p.id.slice(0, 8)}… span ${start}–${end}${location})`, '');
  }
  return { id: randomUUID(), objectiveId: objective.id, corpusRevision: state.corpusRevision, createdAt: new Date().toISOString(), sections, unresolved, changes, markdown: lines.join('\n'), fallback };
}
