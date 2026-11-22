export type RankingKind = 'ranked' | 'citation-list' | 'unknown';
export type BranchStatus = 'active' | 'cooldown' | 'backlog' | 'rejected' | 'archived';
export type EvidenceRole = 'support' | 'qualification' | 'contradiction';
export interface Span { passageId: string; start: number; end: number; }
export interface Objective {
  id: string; parentId?: string; input: string; question: string;
  constraints: string[]; createdAt: string;
}
export interface Need {
  id: string; question: string; weight: number; status: 0 | 0.5 | 1;
  assessment?: { passageIds: string[]; reason: string; corpusRevision: number; createdAt: string };
}
export interface Branch {
  id: string; objectiveId: string; question: string; anchor: string;
  parentId?: string; origin: 'initial' | 'evidence'; introducing: Span[];
  priority: number; status: BranchStatus; needs: Need[]; aliases: string[];
  queries: string[]; retrievalKey?: string; zeroYieldEpisodes: number;
  stats: Partial<Record<ActionKind, { completed: number; successful: number }>>;
  nextAction?: { kind: ActionKind; score: number; reason: string };
}
export interface SourceCandidate {
  id: string; branchId: string; query: string; url: string; title: string; snippet: string;
  provider: string; rankingKind: RankingKind; rank?: number; discoveredAt: string;
  status: 'unread' | 'fetched' | 'blocked' | 'failed'; snapshotId?: string; error?: string;
}
export interface Snapshot {
  id: string; requestedUrl: string; finalUrl: string; canonicalUrl: string;
  fetchedAt: string; contentHash: string; textHash: string; rawBlob: string; textBlob: string;
  mime: string; status: number; title: string; extraction: string; extractionVersion: string;
  text: string; pages?: { page: number; start: number; end: number }[];
  publishedAt?: string;
  modifiedAt?: string;
}
export interface Passage {
  id: string; snapshotId: string; start: number; end: number; text: string;
  section?: string; page?: number; duplicateGroup: string;
}
export interface Token { term: string; start: number; end: number; position: number; }
export interface TermScore { term: string; weight: number; tf: number; df: number; idf: number; contribution: number; }
export interface SearchHit {
  passage: Passage; score: number; terms: TermScore[]; phraseBonus: number;
  length: number; averageLength: number; mmr?: number;
}
export interface Concept {
  id: string; branchId: string; term: string; score: number; anchorRelevance: number;
  introducing: Span[]; classification?: 'alias' | 'branch' | 'boilerplate' | 'tangent' | 'unclear';
  decision?: string; proposedQuestion?: string; admittedBranchId?: string;
}
export interface Contribution {
  objectiveId: string; branchId: string; needId: string; passageId: string;
  duplicateGroup: string; role: EvidenceRole; assessment: string;
}
export type ActionKind = 'retrieve' | 'fetch' | 'search';
export interface Action {
  id: string; objectiveId: string; branchId: string; kind: ActionKind;
  query?: string; candidateId?: string; score: number; reason: string;
  status: 'running' | 'completed' | 'blocked' | 'interrupted';
  startedAt: string; completedAt?: string; yield: number; error?: string;
  candidateIds?: string[];
}
export interface Statement { text: string; citations: Span[]; }
export interface Report {
  id: string; objectiveId: string; corpusRevision: number; createdAt: string;
  sections: { title: string; statements: Statement[] }[];
  unresolved: string[]; changes: string[]; markdown: string; fallback: boolean;
}
export interface Feedback {
  id: string; targetId: string; kind: 'useful' | 'irrelevant' | 'accept' | 'reject' | 'prioritize';
  createdAt: string;
}
export interface Investigation {
  schema: 1; id: string; revisionId: string; allowanceId: string; storageRoot: string;
  originalQuestion: string; objectives: Objective[]; activeObjectiveId: string;
  branches: Branch[]; candidates: SourceCandidate[]; snapshotIds: string[];
  passages: Passage[]; concepts: Concept[]; contributions: Contribution[];
  actions: Action[]; feedback: Feedback[]; reports: Report[]; corpusRevision: number;
  status: 'paused' | 'running' | 'complete'; stopReason?: string;
}
export interface Limits {
  searches: number; fetches: number; http: number; modelCalls: number;
  modelTokens: number;
  /** Active-time cap in milliseconds; absent means no deadline, while zero is exhausted. */
  elapsedMs?: number;
}
export type Resource = Exclude<keyof Limits, 'elapsedMs'>;
export type Usage = Partial<Record<Resource, number>>;
export interface ModelUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number;
  cost?: number; costKind?: 'model-estimate' | 'provider-reported';
}
export interface ModelResponse {
  value: unknown; usage?: ModelUsage;
  /** Explicitly complete token accounting; absent means unresolved, not confirmed zero. */
  usageComplete?: boolean;
}
export interface DiscoveryResult {
  responseId?: string; query: string; provider: string; rankingKind: RankingKind;
  results: { url: string; title: string; snippet: string; rank?: number }[];
}
export interface PlanResult {
  question: string; constraints: string[];
  facets: { question: string; anchor: string; priority: number; needs: string[] }[];
}
export interface EvidenceAssessment {
  contributions: { passageId: string; needId: string; role: EvidenceRole; status: 0.5 | 1; assessment: string }[];
  relevantPassageIds: string[];
  /** Explicit evidence-backed current coverage, independent of contribution novelty. */
  coverageUpdates?: { needId: string; status: Need['status']; passageIds: string[]; assessment: string }[];
}
export interface ConceptDecision {
  conceptId: string; classification: NonNullable<Concept['classification']>;
  reason: string; question?: string; needs?: string[];
}
export interface ModelHost {
  /** Return parsed JSON; source material is untrusted data and calls have no tools. */
  complete(task: 'plan' | 'assess' | 'classify' | 'report', input: unknown,
    options: { signal: AbortSignal; maxOutputTokens: number }): Promise<ModelResponse>;
}
export interface EngineHost {
  model: ModelHost;
  discover(query: string, signal: AbortSignal): Promise<DiscoveryResult>;
  /** Acquisition accounts for each HTTP attempt through its configured ledger hook. */
  acquire(url: string, signal: AbortSignal): Promise<Snapshot>;
  commit(state: Investigation): void;
  isCurrent(): boolean;
  progress(message: string, state: Investigation): void;
}
