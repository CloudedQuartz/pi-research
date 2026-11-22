import type { Action, Branch, Concept, Contribution, Investigation, Passage, ProgressInfo, SearchHit, Snapshot, SourceCandidate } from './types.js';
import { normalizeUrl } from './acquisition.js';
import { clusterPassages } from './core-ir.js';

export type Inspection = Branch | Concept | SourceCandidate | Action | {
  passage: Passage;
  source: Pick<Snapshot, 'id' | 'fetchedAt' | 'extraction' | 'extractionVersion'> & { url: string };
  exactText: string; contributions: Contribution[]; introducedConcepts: Concept[];
};

/** Prevent terminal control sequences from untrusted source strings. */
export const safeText = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');

export interface Corroboration {
  rawPassages: number;
  distinctGroups: number;
  distinctDomains: number;
  isSyndicated: boolean;
}

/**
 * Computes corroboration metrics for a branch need, distinguishing raw passage count
 * from distinct duplicate groups and distinct source domains (Responsible IR syndication check).
 */
export function needCorroboration(
  state: Investigation,
  branchId: string,
  needId: string,
  snapshots: Snapshot[] = []
): Corroboration {
  const needContribs = state.contributions.filter(c => c.branchId === branchId && c.needId === needId && c.role === 'support');
  const rawPassages = needContribs.length;
  const groups = new Set(needContribs.map(c => c.duplicateGroup || c.passageId));

  const snapshotById = new Map(snapshots.map(s => [s.id, s]));
  const passageById = new Map(state.passages.map(p => [p.id, p]));
  const domains = new Set<string>();

  for (const c of needContribs) {
    const passage = passageById.get(c.passageId);
    if (passage) {
      const snap = snapshotById.get(passage.snapshotId);
      if (snap) {
        try {
          domains.add(new URL(snap.finalUrl).hostname.toLowerCase());
        } catch { /* ignore */ }
      }
    }
  }

  const distinctGroups = groups.size;
  const distinctDomains = domains.size;
  const isSyndicated = rawPassages > 1 && (distinctGroups < rawPassages || (distinctDomains > 0 && distinctDomains < rawPassages));

  return { rawPassages, distinctGroups, distinctDomains, isSyndicated };
}

export function researchMap(state: Investigation, snapshots: Snapshot[] = []): string {
  const objective = state.objectives.find(o => o.id === state.activeObjectiveId);
  const lines = [`Investigation ${state.id} · ${state.status}`, `Objective: ${objective?.question ?? state.originalQuestion}`, `Corpus revision ${state.corpusRevision} · ${state.snapshotIds.length} visible snapshots · ${state.passages.length} passages`, 'Answer coverage is not factual confidence.', ''];
  for (const b of state.branches.filter(b => b.objectiveId === state.activeObjectiveId)) {
    const total = b.needs.reduce((sum, n) => sum + n.weight, 0);
    const coverage = total ? b.needs.reduce((sum, n) => sum + n.weight * n.status, 0) / total : 0;
    lines.push(`${b.parentId ? '  ↳ ' : ''}${b.question} [${b.status}]`, `  ID ${b.id} · priority ${b.priority.toFixed(2)} · answer coverage ${(100 * coverage).toFixed(0)}%`);
    if (b.introducing.length) lines.push(`  Introduced by ${b.introducing.map(s => `${s.passageId}:${s.start}–${s.end}`).join(', ')}`);
    for (const need of b.needs) {
      const corrob = needCorroboration(state, b.id, need.id, snapshots);
      const corrobNote = corrob.rawPassages > 0
        ? ` · corroboration: ${corrob.distinctDomains || corrob.distinctGroups} independent origin(s)${corrob.isSyndicated ? ` (${corrob.rawPassages} passages; syndicated duplication detected)` : ''}`
        : '';
      lines.push(`  ${need.status === 1 ? 'addressed' : need.status === 0.5 ? 'partial' : 'open'}: ${need.question}${corrobNote}`);
    }
    lines.push(`  Recent zero-yield search episodes: ${b.zeroYieldEpisodes}`);
    if (b.nextAction) lines.push(`  Next: ${b.nextAction.kind} · utility ${b.nextAction.score.toFixed(4)} · ${b.nextAction.reason}`);
    for (const c of state.concepts.filter(c => c.branchId === b.id).slice(-6)) lines.push(`  Concept “${c.term}”: ${c.classification ?? 'pending'} · TF-IDF ${c.score.toFixed(4)} · ${c.decision ?? 'not yet classified'}`);
    lines.push('');
  }
  if (state.passages.length >= 2) {
    const k = Math.min(4, Math.max(2, Math.floor(Math.sqrt(state.passages.length))));
    const clusters = clusterPassages(state.passages, k);
    if (clusters.length) {
      lines.push('Semantic topic clusters (passage facets):');
      for (const cl of clusters) {
        lines.push(`  • Cluster [${cl.centroidTerms.join(' · ')}]: ${cl.passageIds.length} passage(s)`);
      }
      lines.push('');
    }
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
  const snapshotById = new Map(snapshots.map(s => [s.id, s]));
  const sources = state.candidates.map(c => {
    const snap = c.snapshotId ? snapshotById.get(c.snapshotId) : undefined;
    const dateInfo = snap?.publishedAt ? ` · published: ${snap.publishedAt.slice(0, 10)} (source-claimed)` : '';
    const canonicalInfo = (snap?.canonicalUrl && normalizeUrl(snap.canonicalUrl) !== normalizeUrl(c.url)) ? `\n  canonical: ${snap.canonicalUrl}` : '';
    return `${c.id} [${c.status}] ${c.title}\n  ${c.url}${canonicalInfo}\n  ${c.provider} / ${c.rankingKind}${c.rank ? ` rank ${c.rank}` : ''} · query: ${c.query}${dateInfo}${c.error ? `\n  ${c.error}` : ''}`;
  }).join('\n\n') || 'No discovered sources.';
  const summary = summarizeAcquisition(state, snapshots);
  const summaryText = formatAcquisitionSummary(summary);
  return safeText([...warnings, 'Discovery metadata is not original evidence; snapshot/domain counts are not confidence.', '', sources, '', summaryText].join('\n'));
}

export interface AcquisitionSummary {
  totalDiscovered: number;
  unread: number;
  fetched: number;
  blocked: number;
  failed: number;
  attempts: number;
  yieldPct: number;
  failuresByCause: Record<string, number>;
  hostOutcomes: Record<string, {
    discovered: number;
    fetched: number;
    blocked: number;
    failed: number;
    circuitBroken: boolean;
  }>;
}

export function classifyFailure(error?: string): string {
  if (!error) return 'Unspecified';
  const e = error.toLowerCase();
  if (e.includes('challenge') || e.includes('captcha') || e.includes('browser verification')) {
    return 'Bot challenge / CAPTCHA';
  }
  if (e.includes('robots')) {
    return 'Robots.txt policy';
  }
  if (e.includes('403') || e.includes('forbidden')) {
    return 'HTTP 403 Forbidden';
  }
  if (e.includes('429') || e.includes('too many requests')) {
    return 'HTTP 429 Rate limited';
  }
  if (/\b5\d\d\b/.test(e) || e.includes('server error') || e.includes('bad gateway') || e.includes('service unavailable')) {
    return 'HTTP 5xx Server error';
  }
  if (e.includes('404') || e.includes('not found')) {
    return 'HTTP 404 Not found';
  }
  if (e.includes('timeout') || e.includes('timed out')) {
    return 'Timeout';
  }
  if (e.includes('thin text') || e.includes('readability') || e.includes('extraction')) {
    return 'Extraction failure / thin content';
  }
  if (e.includes('dns') || e.includes('network') || e.includes('econnrefused') || e.includes('enotfound')) {
    return 'DNS / Network error';
  }
  if (e.includes('previously blocked')) {
    return 'Host circuit-broken';
  }
  if (e.includes('non-article')) {
    return 'Non-article route filter';
  }
  if (e.includes('invalid url') || e.includes('private') || e.includes('redirect')) {
    return 'Policy / invalid destination';
  }
  return error.length > 50 ? `${error.slice(0, 47)}...` : error;
}

export function summarizeAcquisition(state: Investigation, snapshots: Snapshot[] = []): AcquisitionSummary {
  const summary: AcquisitionSummary = {
    totalDiscovered: state.candidates.length,
    unread: 0,
    fetched: 0,
    blocked: 0,
    failed: 0,
    attempts: 0,
    yieldPct: 0,
    failuresByCause: {},
    hostOutcomes: {},
  };

  for (const c of state.candidates) {
    let host = 'unknown';
    try { host = new URL(c.url).hostname.toLowerCase(); } catch { /* ignore */ }

    if (!summary.hostOutcomes[host]) {
      summary.hostOutcomes[host] = { discovered: 0, fetched: 0, blocked: 0, failed: 0, circuitBroken: false };
    }
    const h = summary.hostOutcomes[host]!;
    h.discovered += 1;

    if (c.status === 'unread') {
      summary.unread += 1;
    } else if (c.status === 'fetched') {
      summary.fetched += 1;
      summary.attempts += 1;
      h.fetched += 1;
    } else if (c.status === 'failed') {
      summary.failed += 1;
      summary.attempts += 1;
      h.failed += 1;
      const cause = classifyFailure(c.error);
      summary.failuresByCause[cause] = (summary.failuresByCause[cause] ?? 0) + 1;
    } else if (c.status === 'blocked') {
      summary.blocked += 1;
      h.blocked += 1;
      const isPreFiltered = Boolean(c.error && c.error.startsWith('skipped: '));
      if (!isPreFiltered) {
        summary.attempts += 1;
      }
      if (c.error && /previously blocked|circuit-broken/i.test(c.error)) {
        h.circuitBroken = true;
      }
      const cause = classifyFailure(c.error);
      summary.failuresByCause[cause] = (summary.failuresByCause[cause] ?? 0) + 1;
    }
  }

  summary.yieldPct = summary.attempts > 0 ? (summary.fetched / summary.attempts) * 100 : 0;
  return summary;
}

export function formatAcquisitionSummary(summary: AcquisitionSummary): string {
  if (summary.totalDiscovered === 0) return 'Acquisition summary: No candidate URLs discovered.';
  const lines: string[] = [
    '=== Acquisition Summary ===',
    `Yield: ${summary.fetched}/${summary.attempts} attempt(s) (${summary.yieldPct.toFixed(1)}%) · ${summary.totalDiscovered} candidate(s) discovered (${summary.fetched} fetched, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.unread} unread)`,
  ];

  const failureEntries = Object.entries(summary.failuresByCause);
  if (failureEntries.length > 0) {
    lines.push('Failures and policy exclusions:');
    for (const [cause, count] of failureEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${cause}: ${count}`);
    }
  }

  const hostEntries = Object.entries(summary.hostOutcomes);
  if (hostEntries.length > 0) {
    lines.push('Host outcomes:');
    for (const [host, h] of hostEntries.sort((a, b) => b[1].discovered - a[1].discovered)) {
      const flags: string[] = [];
      if (h.circuitBroken) flags.push('circuit-broken');
      lines.push(`  - ${host}: ${h.discovered} discovered, ${h.fetched} fetched, ${h.failed} failed, ${h.blocked} blocked${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    }
  }

  return lines.join('\n');
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

/**
 * Renders a compact stage-based progress bar.
 * Example: `[██████░░░░] 3/5 stages`
 */
export function renderProgressBar(stage?: number, totalStages?: number, width = 10): string {
  if (!stage || !totalStages || totalStages <= 0) {
    return stage ? `[Stage ${stage}]` : '';
  }
  const clampedStage = Math.max(0, Math.min(totalStages, stage));
  const filled = Math.round((clampedStage / totalStages) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `[${bar}] ${clampedStage}/${totalStages} stages`;
}

/**
 * Compact single-line status for the terminal status bar (`ctx.ui.setStatus`).
 * Format: `[3/5] Acquiring sources · Calls: 12/40 · 8 sources · 6 assessed`
 */
export function renderProgressStatus(
  state: Investigation,
  info?: ProgressInfo,
  modelCalls?: { confirmed: number; limit: number },
  message?: string
): string {
  const parts: string[] = [];

  if (info?.stage && info?.totalStages) {
    parts.push(`[${info.stage}/${info.totalStages}]`);
  } else if (state.status === 'complete') {
    parts.push('[Complete]');
  }

  const activity = info?.activity ?? (message ? (message.length > 40 ? `${message.slice(0, 37)}...` : message) : `Research ${state.status}`);
  parts.push(activity);

  if (modelCalls) {
    parts.push(`Calls: ${modelCalls.confirmed}/${modelCalls.limit}`);
  }

  const sources = state.snapshotIds.length;
  const assessed = state.contributions.length;
  parts.push(`${sources} source${sources === 1 ? '' : 's'} · ${assessed} assessed`);

  return safeText(parts.join(' · '));
}

/**
 * Compact multi-line progress widget rendered in the terminal UI (`ctx.ui.setWidget`).
 * Provides an at-a-glance view of current activity, stage completion, counters, and needs.
 */
export function renderProgressWidget(
  state: Investigation,
  info?: ProgressInfo,
  modelCalls?: { confirmed: number; limit: number }
): string[] {
  const lines: string[] = [];

  const roundPrefix = info?.round && info.round > 1 ? ` (Round ${info.round})` : '';
  const bar = renderProgressBar(info?.stage, info?.totalStages);
  const activity = info?.activity ?? (state.status === 'complete' ? 'Research completed' : `Research ${state.status}`);
  if (bar) {
    lines.push(`Research${roundPrefix}: ${bar} · ${activity}`);
  } else {
    lines.push(`Research${roundPrefix}: ${activity}`);
  }

  const sources = state.snapshotIds.length;
  const assessed = state.contributions.length;
  const callsText = modelCalls ? ` | Model calls: ${modelCalls.confirmed} / ${modelCalls.limit}` : '';
  lines.push(`Sources acquired: ${sources} | Evidence assessed: ${assessed}${callsText}`);

  const objective = state.objectives.find(o => o.id === state.activeObjectiveId);
  const question = objective?.question ?? state.originalQuestion;
  const truncatedQ = question.length > 70 ? `${question.slice(0, 67)}...` : question;
  lines.push(`Objective: ${truncatedQ}`);

  const branches = state.branches.filter(b => b.objectiveId === state.activeObjectiveId && b.status !== 'archived');
  const allNeeds = branches.flatMap(b => b.needs);
  const addressed = allNeeds.filter(n => n.status === 1).length;
  const partial = allNeeds.filter(n => n.status === 0.5).length;
  const totalWeight = allNeeds.reduce((sum, n) => sum + n.weight, 0);
  const coveragePct = totalWeight > 0
    ? Math.round((allNeeds.reduce((sum, n) => sum + n.weight * n.status, 0) / totalWeight) * 100)
    : 0;
  lines.push(`Needs: ${addressed}/${allNeeds.length} addressed (${coveragePct}%)${partial > 0 ? ` [${partial} partial]` : ''} · ${state.passages.length} passages`);

  const openOrPartialNeeds = allNeeds.filter(n => n.status < 1);
  const sampleNeeds = (openOrPartialNeeds.length ? openOrPartialNeeds : allNeeds).slice(0, 3);
  for (const n of sampleNeeds) {
    const icon = n.status === 1 ? '✓' : n.status === 0.5 ? '◐' : '○';
    const label = n.status === 1 ? 'addressed' : n.status === 0.5 ? 'partial' : 'open';
    const q = n.question.length > 55 ? `${n.question.slice(0, 52)}...` : n.question;
    lines.push(`  ${icon} ${q} [${label}]`);
  }

  const report = state.reports.at(-1);
  if (state.status === 'complete' && report) {
    if (report.fallback) {
      lines.push('  ⚠️ Extractive fallback report (model synthesis unavailable)');
    } else {
      lines.push(`  Report synthesized (${report.sections.reduce((s, sec) => s + sec.statements.length, 0)} statements with citations)`);
    }
  } else if (state.stopReason) {
    const shortReason = state.stopReason.length > 70 ? `${state.stopReason.slice(0, 67)}...` : state.stopReason;
    lines.push(`  Status: ${shortReason}`);
  }

  return lines.map(safeText);
}
