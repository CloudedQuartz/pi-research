import type { Branch, Concept, ConceptDecision, EvidenceAssessment, PlanResult, SearchHit } from './types.js';

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
}
function array(value: unknown, label: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${label} array`);
  return value;
}
const normalized = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function unique(values: string[], label: string): void {
  if (new Set(values.map(normalized)).size !== values.length) throw new Error(`Duplicate ${label}`);
}

/** Reconstruct only permitted fields: generated objects never become authoritative state. */
export function parsePlan(value: unknown): PlanResult {
  const result = record(value, 'Plan');
  const constraints = array(result.constraints, 'constraints', 12).map(v => string(v, 'constraint', 1000));
  const facets = array(result.facets, 'facets', 8, 1).map(raw => {
    const facet = record(raw, 'Facet');
    if (typeof facet.priority !== 'number' || !Number.isFinite(facet.priority) || facet.priority < 0 || facet.priority > 1) throw new Error('Facet priority must be in [0,1]');
    const needs = array(facet.needs, 'answer needs', 6, 1).map(v => string(v, 'answer need'));
    unique(needs, 'answer needs');
    return { question: string(facet.question, 'facet question'), anchor: string(facet.anchor, 'facet anchor'), priority: facet.priority, needs };
  });
  unique(facets.map(f => f.question), 'facets');
  unique(constraints, 'constraints');
  return { question: string(result.question, 'standalone question', 4000), constraints, facets };
}

/** Contextual assessments may address only the current branch's frozen needs and supplied hits. */
export function parseAssessment(value: unknown, branch: Branch, hits: SearchHit[]): EvidenceAssessment {
  const result = record(value, 'Assessment');
  const passageIds = new Set(hits.map(h => h.passage.id));
  const needIds = new Set(branch.needs.map(n => n.id));
  const relevantPassageIds = array(result.relevantPassageIds, 'relevant passages', hits.length).map(v => string(v, 'passage ID', 150));
  if (new Set(relevantPassageIds).size !== relevantPassageIds.length || relevantPassageIds.some(id => !passageIds.has(id))) throw new Error('Assessment contains unknown or repeated passage IDs');
  const relevant = new Set(relevantPassageIds);
  const keys = new Set<string>();
  const contributions = array(result.contributions, 'contributions', Math.max(1, hits.length * branch.needs.length * 3)).map(raw => {
    const item = record(raw, 'Contribution');
    const passageId = string(item.passageId, 'passage ID', 150);
    const needId = string(item.needId, 'need ID', 150);
    if (!relevant.has(passageId) || !needIds.has(needId)) throw new Error('Contribution is outside relevant evidence/current needs');
    if (item.role !== 'support' && item.role !== 'qualification' && item.role !== 'contradiction') throw new Error('Invalid evidence role');
    if (item.status !== 0.5 && item.status !== 1) throw new Error('Invalid answer-coverage assessment');
    const key = `${passageId}\0${needId}\0${item.role}`;
    if (keys.has(key)) throw new Error('Duplicate contribution');
    keys.add(key);
    return { passageId, needId, role: item.role, status: item.status, assessment: string(item.assessment, 'assessment') } satisfies EvidenceAssessment['contributions'][number];
  });
  const coverageUpdates = result.coverageUpdates === undefined ? undefined
    : array(result.coverageUpdates, 'coverage updates', branch.needs.length).map(raw => {
      const item = record(raw, 'Coverage update');
      const needId = string(item.needId, 'need ID', 150);
      const need = branch.needs.find(n => n.id === needId);
      if (!need || (item.status !== 0 && item.status !== 0.5 && item.status !== 1)) throw new Error('Invalid coverage need/status');
      const witnesses = array(item.passageIds, 'coverage witnesses', hits.length, 1).map(v => string(v, 'passage ID', 150));
      unique(witnesses, 'coverage witnesses');
      const linked = contributions.filter(c => c.needId === needId && witnesses.includes(c.passageId));
      if (witnesses.some(id => !relevant.has(id) || !linked.some(c => c.passageId === id))) throw new Error('Coverage witness is outside current relevant same-need evidence');
      if (item.status < need.status && !linked.some(c => c.role === 'qualification' || c.role === 'contradiction')) throw new Error('Coverage downgrade requires explicit qualifying or contradicting evidence');
      return { needId, status: item.status, passageIds: witnesses, assessment: string(item.assessment, 'coverage explanation') } satisfies NonNullable<EvidenceAssessment['coverageUpdates']>[number];
    });
  if (coverageUpdates) unique(coverageUpdates.map(u => u.needId), 'coverage need updates');
  return { relevantPassageIds, contributions, ...(coverageUpdates ? { coverageUpdates } : {}) };
}

export function parseDecisions(value: unknown, concepts: Concept[]): ConceptDecision[] {
  const result = record(value, 'Concept classification');
  const ids = new Set(concepts.map(c => c.id));
  const seen = new Set<string>();
  return array(result.decisions, 'concept decisions', concepts.length).map(raw => {
    const decision = record(raw, 'Concept decision');
    const conceptId = string(decision.conceptId, 'concept ID', 150);
    if (!ids.has(conceptId) || seen.has(conceptId)) throw new Error('Unknown/repeated concept classification');
    seen.add(conceptId);
    const classification = decision.classification;
    if (classification !== 'alias' && classification !== 'branch' && classification !== 'boilerplate' && classification !== 'tangent' && classification !== 'unclear') throw new Error('Invalid concept classification');
    const base = { conceptId, classification, reason: string(decision.reason, 'classification reason') } satisfies ConceptDecision;
    if (classification !== 'branch') return base satisfies ConceptDecision;
    const needs = array(decision.needs, 'new branch needs', 4, 1).map(v => string(v, 'new answer need'));
    unique(needs, 'new answer needs');
    return { ...base, question: string(decision.question, 'new branch question'), needs } satisfies ConceptDecision;
  });
}
