/**
 * Transactional allowance ledger backed by `node:sqlite`.
 *
 * Contract highlights:
 * - Grants, request authorizations and operation reservations are durable and
 *   payload-bound: repeating an authorization/operation ID with the same
 *   payload is idempotent (never redispatches), a conflicting payload is
 *   rejected. IDs carry digests of their whole payload.
 * - Request writers are exclusive and durable: a claim is released only by its
 *   own owner's `finishRequest` or by explicit user recovery
 *   (`interruptInvestigation`). There is no automatic lock steal, no automatic
 *   redispatch of finished requests, and a stale owner can never release a
 *   newer owner's claim. Exclusivity is enforced per investigation: while any
 *   request of an investigation holds an active claim, no other request of
 *   that investigation may be claimed, regardless of owner or session, so
 *   concurrent copied-fork writers are unsupported (distinct investigations
 *   stay independent). Recovery is investigation-wide: it revokes every
 *   active writer and marks every non-terminal request `interrupted`, so an
 *   old request ID can never reclaim or redispatch — continuation always goes
 *   through a newly authorized request ID.
 * - Unknown outcomes stay conservatively reserved (`unresolved` in
 *   `snapshot`); known usage, including overruns, is confirmed, visible and
 *   blocks further reservations that exceed the caps. An unknown outcome still
 *   confirms the usage it did observe and holds only the componentwise
 *   residual `max(reserved - observed, 0)`; observations may grow but never
 *   decrease already-confirmed counts, and identical replays never add twice.
 * - Synthesis capacity is a protected carve-out of the authorized limits that
 *   work-lane reservations cannot consume. Elapsed time accrues only while a
 *   writer claim is active (idle gaps are excluded, so the cap spans runs and
 *   survives reopen/forks); interrupted or crashed writers keep accruing until
 *   explicit recovery, which is recorded, never silently reclaimed.
 * - Model token accounting is provider-reported and estimated; it is enforced
 *   mechanically but is not a guaranteed monetary cap. Hidden provider costs
 *   stay unknown rather than zero.
 * - Every mutation runs in a short `BEGIN IMMEDIATE` transaction with a busy
 *   timeout. No network or other external I/O ever happens inside a
 *   transaction; host scheduling waits occur after the slot transaction
 *   commits.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Feedback, Limits, Resource, Usage } from './types.js';

export type RequestKind = 'start' | 'continue' | 'report' | 'feedback' | 'fetch';
export type Lane = 'work' | 'synthesis';
export type RequestDisposition = 'completed' | 'interrupted';

/** Immutable, command-authorized request payload; the whole object is digested. */
export interface AuthorizedRequest {
  id: string;
  allowanceId: string;
  investigationId: string;
  expectedRevision?: string;
  sessionId: string;
  kind: RequestKind;
  question: string;
  provider: string;
  searchTool: string;
  storageRoot: string;
  targetId?: string;
  feedbackKind?: Feedback['kind'];
}

export interface SettleMeta {
  /** Provider-reported money cost where actually exposed; absent stays unknown. */
  cost?: number;
  /** Unknown outcome: keep the reservation instead of confirming observed usage. */
  unknown?: boolean;
  error?: string;
}

export interface OperationView {
  operationId: string;
  lane: Lane;
  payload: unknown;
  amount: Usage;
  status: 'reserved' | 'unknown' | 'settled';
  createdAt: number;
  dispatchedAt?: number;
  settledAt?: number;
  observed?: Usage;
  cost?: number;
  error?: string;
}

export interface GrantView {
  authorizationId: string;
  increments: Partial<Limits>;
  createdAt: number;
}

export interface LaneSnapshot {
  cap: Record<Resource, number>;
  reserved: Record<Resource, number>;
  confirmed: Record<Resource, number>;
  remaining: Record<Resource, number>;
}

export interface AllowanceSnapshot {
  allowanceId: string;
  /** Effective authorized limits: base grant plus every confirmed increment. */
  limits: Limits;
  baseLimits: Limits;
  /** Protected carve-out; work-lane reservations cannot consume it. */
  synthesis: Usage;
  /** Held reservations (reserved and unresolved), summed across lanes. */
  reserved: Record<Resource, number>;
  confirmed: Record<Resource, number>;
  /** `limits - reserved - confirmed`; negative means a visible overrun. */
  remaining: Record<Resource, number>;
  /** Subset of `reserved` held by unknown-outcome operations. */
  unresolved: Record<Resource, number>;
  lanes: { work: LaneSnapshot; synthesis: LaneSnapshot };
  /** Active writer time recorded so far (grows live while a writer is claimed). */
  elapsedMs: number;
  /** `limits.elapsedMs - elapsedMs`; zero or negative stops new reservations. */
  remainingElapsedMs: number;
  /** Sum of reported provider costs; `undefined` when no cost was ever exposed. */
  cost: number | undefined;
  operations: OperationView[];
  grants: GrantView[];
  activeWriters: { requestId: string; owner: string; since: number }[];
}

type Row = Record<string, unknown>;

const RESOURCE_KEYS: readonly Resource[] = ['searches', 'fetches', 'http', 'modelCalls', 'modelTokens'];
const LIMIT_KEYS: readonly (keyof Limits)[] = [...RESOURCE_KEYS, 'elapsedMs'];
const REQUEST_KINDS: readonly RequestKind[] = ['start', 'continue', 'report', 'feedback', 'fetch'];
const FEEDBACK_KINDS: readonly Feedback['kind'][] = ['useful', 'irrelevant', 'accept', 'reject', 'prioritize'];
const BUSY_TIMEOUT_MS = 5000;
const SCHEMA_VERSION = 1;
const MAX_ID_LENGTH = 512;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS allowances (
  id TEXT PRIMARY KEY,
  base_limits TEXT NOT NULL,
  synthesis TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  authorization_id TEXT PRIMARY KEY,
  allowance_id TEXT NOT NULL REFERENCES allowances(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  increments TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  allowance_id TEXT NOT NULL REFERENCES allowances(id),
  investigation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  digest TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  finish_owner TEXT,
  disposition TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  request_id TEXT NOT NULL REFERENCES requests(id),
  owner TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  allowance_id TEXT NOT NULL REFERENCES allowances(id),
  lane TEXT NOT NULL,
  payload TEXT NOT NULL,
  digest TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  settled_at INTEGER,
  observed TEXT,
  settle_key TEXT,
  cost REAL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS elapsed (
  allowance_id TEXT PRIMARY KEY REFERENCES allowances(id),
  accrued_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS host_slots (
  host TEXT PRIMARY KEY,
  next_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_investigation ON requests(investigation_id);
CREATE INDEX IF NOT EXISTS idx_requests_allowance ON requests(allowance_id);
CREATE INDEX IF NOT EXISTS idx_operations_allowance ON operations(allowance_id);
CREATE INDEX IF NOT EXISTS idx_claims_request ON claims(request_id);
`;

type LedgerJson = string | number | boolean | null | undefined | LedgerJson[] | { [key: string]: LedgerJson };
type JsonObject = { [key: string]: LedgerJson };

/** JSON semantics with deterministically sorted object keys, for stable digests. */
function canonicalize(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item: LedgerJson) => sortKeys(item));
  if (encoded === undefined) throw new Error('Ledger payload is not JSON-encodable');
  return encoded;
}

function sortKeys(item: LedgerJson): LedgerJson {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
  const sorted = {} as JsonObject;
  for (const key of Object.keys(item).sort(compareKeys)) sorted[key] = item[key];
  return sorted;
}

function compareKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Parse stored ledger JSON at its persistence boundary with a domain error. */
function parseJson<T = unknown>(text: string, label: string): T {
  try { return JSON.parse(text) as T; } catch (error) { throw new Error(`${label} is not valid JSON`, { cause: error }); }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assertId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) {
    throw new Error(`${label} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function assertCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

/** Validate a `Usage`-shaped value; unknown resources or malformed counts throw. */
function readUsage(value: unknown, label: string): Record<string, number> {
  const source = assertObject(value, label);
  const usage = {} as Record<string, number>;
  for (const key of Object.keys(source).sort(compareKeys)) {
    if (!(RESOURCE_KEYS as readonly string[]).includes(key)) throw new Error(`${label}.${key} is not an allowance resource`);
    usage[key] = assertCount(source[key], `${label}.${key}`);
  }
  return usage;
}

/** Reconstruct a full `Limits` value at its persistence boundary; every key is required. */
function readLimits(value: unknown, label: string): Limits {
  const source = assertObject(value, label);
  const counts: Record<string, number> = {};
  for (const key of Object.keys(source).sort(compareKeys)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) throw new Error(`${label}.${key} is not an allowance limit`);
    counts[key] = assertCount(source[key], `${label}.${key}`);
  }
  const limits: Limits = { searches: 0, fetches: 0, http: 0, modelCalls: 0, modelTokens: 0, elapsedMs: 0 };
  for (const key of LIMIT_KEYS) {
    const count = counts[key];
    if (count === undefined) throw new Error(`${label}.${key} is required`);
    limits[key] = count;
  }
  return limits;
}

/** Validate a grant increment; any subset of limits is allowed, empty is a no-op. */
function readIncrements(value: unknown, label: string): Record<string, number> {
  const source = assertObject(value, label);
  const increments = {} as Record<string, number>;
  for (const key of Object.keys(source).sort(compareKeys)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) throw new Error(`${label}.${key} is not an allowance limit`);
    increments[key] = assertCount(source[key], `${label}.${key}`);
  }
  return increments;
}

/**
 * Validate a request payload at its persistence boundary: every domain field
 * is checked, and unrecognized extra fields are preserved so the stored
 * payload digest still round-trips byte for byte.
 */
function readRequest(value: unknown): AuthorizedRequest {
  const source = assertObject(value, 'request');
  assertId(source.id, 'request.id');
  assertId(source.allowanceId, 'request.allowanceId');
  assertId(source.investigationId, 'request.investigationId');
  assertId(source.sessionId, 'request.sessionId');
  assertId(source.storageRoot, 'request.storageRoot');
  if (typeof source.kind !== 'string' || !(REQUEST_KINDS as readonly string[]).includes(source.kind)) {
    throw new Error('request.kind must be start, continue, report, feedback or fetch');
  }
  for (const key of ['question', 'provider', 'searchTool'] as const) {
    if (typeof source[key] !== 'string') throw new Error(`request.${key} must be a string`);
  }
  for (const key of ['expectedRevision', 'targetId'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string') throw new Error(`request.${key} must be a string when present`);
  }
  if (source.feedbackKind !== undefined && !(FEEDBACK_KINDS as readonly string[]).includes(source.feedbackKind as string)) {
    throw new Error('request.feedbackKind must be a valid feedback kind');
  }
  if (source.kind === 'feedback' && (typeof source.targetId !== 'string' || !source.targetId || source.feedbackKind === undefined)) {
    throw new Error('Feedback authorization must bind targetId and feedbackKind');
  }
  if (source.kind === 'fetch' && (typeof source.targetId !== 'string' || !source.targetId)) {
    throw new Error('Fetch authorization must bind targetId');
  }
  // SAFETY: every required `AuthorizedRequest` field was validated above with
  // a domain error on mismatch; TypeScript cannot express that per-field
  // runtime check, and the same object (including any extra fields that keep
  // the stored payload digest stable) is returned unchanged.
  return source as unknown as AuthorizedRequest;
}

function normalizeMeta(meta: SettleMeta | undefined): SettleMeta {
  if (meta === undefined || meta === null) return {};
  const source = assertObject(meta, 'settle meta');
  const normalized: SettleMeta = {};
  if (source.cost !== undefined) {
    if (typeof source.cost !== 'number' || !Number.isFinite(source.cost) || source.cost < 0) {
      throw new Error('settle meta.cost must be a non-negative finite number');
    }
    normalized.cost = source.cost;
  }
  if (source.unknown !== undefined) {
    if (typeof source.unknown !== 'boolean') throw new Error('settle meta.unknown must be a boolean');
    if (source.unknown) normalized.unknown = true;
  }
  if (source.error !== undefined) {
    if (typeof source.error !== 'string') throw new Error('settle meta.error must be a string');
    normalized.error = source.error;
  }
  return normalized;
}

function field(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Ledger row is missing string column ${key}`);
  return value;
}

function optionalField(row: Row, key: string): string | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : String(value);
}

function numberField(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`Ledger row is missing numeric column ${key}`);
  return value;
}

function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  return value === null || value === undefined ? undefined : numberField(row, key);
}

function zeroUsage(): Record<Resource, number> {
  const usage = {} as Record<Resource, number>;
  for (const key of RESOURCE_KEYS) usage[key] = 0;
  return usage;
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(String(reason ?? 'Operation aborted'));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolveSleep, rejectSleep) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectSleep(abortReason(signal));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * What one operation row contributes to the ledger: `confirmed` usage that is
 * already spent and `held` capacity that stays reserved, both componentwise.
 * Settled rows confirm their full observations and hold nothing; unknown rows
 * confirm the observations they persisted and hold only
 * `max(amount - observed, 0)` (no observations at all leaves the full hold);
 * reserved rows hold their full amount. Stored observations are reconstructed
 * as validated usage at this boundary.
 */
function opContributions(status: string, amount: Usage, observedRaw: string | undefined):
  { confirmed: Record<Resource, number>; held: Record<Resource, number>; observed?: Usage } {
  if (status === 'reserved') {
    const held = zeroUsage();
    for (const key of RESOURCE_KEYS) held[key] = amount[key] ?? 0;
    return { confirmed: zeroUsage(), held };
  }
  if (status !== 'unknown' && status !== 'settled') throw new Error(`Unknown operation status ${status}`);
  if (status === 'settled' && observedRaw === undefined) throw new Error('Settled operation is missing its observed usage');
  const observed = observedRaw === undefined
    ? zeroUsage()
    : readUsage(parseJson(observedRaw, 'stored operation observed'), 'stored operation observed');
  const confirmed = zeroUsage();
  const held = zeroUsage();
  for (const key of RESOURCE_KEYS) {
    const seen = observed[key] ?? 0;
    confirmed[key] = seen;
    held[key] = status === 'unknown' ? Math.max((amount[key] ?? 0) - seen, 0) : 0;
  }
  const parts: { confirmed: Record<Resource, number>; held: Record<Resource, number>; observed?: Usage } = { confirmed, held };
  if (observedRaw !== undefined) parts.observed = observed;
  return parts;
}

export class Ledger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (typeof path !== 'string' || !path) throw new Error('Ledger requires a database file path');
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const versionRow = this.db.prepare('PRAGMA user_version').get() as Row | undefined;
    const version = versionRow ? numberField(versionRow, 'user_version') : 0;
    if (version > SCHEMA_VERSION) throw new Error(`Unsupported ledger schema version ${version}`);
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  // ---------------------------------------------------------------- grants

  /**
   * Create an allowance bound to `authorizationId`. Repeating the same ID with
   * the same payload returns the same allowance ID; a conflicting payload
   * throws. Synthesis is a protected carve-out and may not exceed the limits.
   */
  authorize(limits: Limits, synthesis: Usage, authorizationId: string): string {
    assertId(authorizationId, 'authorizationId');
    const base = readLimits(limits, 'limits');
    const reserve = readUsage(synthesis, 'synthesis');
    for (const key of RESOURCE_KEYS) {
      if ((reserve[key] ?? 0) > (base[key] ?? 0)) throw new Error(`synthesis.${key} exceeds limits.${key}`);
    }
    const baseJson = canonicalize(base);
    const synthesisJson = canonicalize(reserve);
    const payload = canonicalize({ op: 'authorize', limits: base, synthesis: reserve });
    return this.tx(() => {
      const existing = this.db.prepare('SELECT allowance_id, kind, payload FROM grants WHERE authorization_id = ?').get(authorizationId);
      if (existing) {
        if (field(existing, 'kind') !== 'authorize' || field(existing, 'payload') !== payload) {
          throw new Error('Authorization ID already recorded with a different payload');
        }
        return field(existing, 'allowance_id');
      }
      const allowanceId = randomUUID();
      const now = Date.now();
      this.db.prepare('INSERT INTO allowances (id, base_limits, synthesis, created_at) VALUES (?, ?, ?, ?)')
        .run(allowanceId, baseJson, synthesisJson, now);
      this.db.prepare('INSERT INTO elapsed (allowance_id, accrued_ms) VALUES (?, 0)').run(allowanceId);
      this.db.prepare('INSERT INTO grants (authorization_id, allowance_id, kind, payload, increments, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(authorizationId, allowanceId, 'authorize', payload, now);
      return allowanceId;
    });
  }

  /** Add explicitly authorized increments; idempotent and payload-bound like `authorize`. */
  addGrant(allowanceId: string, increments: Partial<Limits>, authorizationId: string): void {
    assertId(allowanceId, 'allowanceId');
    assertId(authorizationId, 'authorizationId');
    const delta = readIncrements(increments, 'increments');
    const payload = canonicalize({ op: 'grant', allowanceId, increments: delta });
    this.tx(() => {
      const existing = this.db.prepare('SELECT allowance_id, kind, payload FROM grants WHERE authorization_id = ?').get(authorizationId);
      if (existing) {
        if (field(existing, 'kind') !== 'grant' || field(existing, 'payload') !== payload) {
          throw new Error('Authorization ID already recorded with a different payload');
        }
        return;
      }
      if (!this.db.prepare('SELECT id FROM allowances WHERE id = ?').get(allowanceId)) throw new Error('Unknown allowance ID');
      this.db.prepare('INSERT INTO grants (authorization_id, allowance_id, kind, payload, increments, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(authorizationId, allowanceId, 'grant', payload, canonicalize(delta), Date.now());
    });
  }

  // -------------------------------------------------------------- requests

  /**
   * Persist an immutable request payload. Re-authorizing the same ID with the
   * same payload is a no-op; a conflicting payload or an unknown allowance
   * throws. Feedback and fetch kinds bind their target so every mutation goes
   * through the same durable ownership.
   */
  authorizeRequest(request: AuthorizedRequest): void {
    const source = readRequest(request);
    const id = source.id;
    const allowanceId = source.allowanceId;
    const investigationId = source.investigationId;
    const sessionId = source.sessionId;
    const kind = source.kind;
    const payload = canonicalize(request);
    const digest = sha256(payload);
    this.tx(() => {
      const existing = this.db.prepare('SELECT digest FROM requests WHERE id = ?').get(id);
      if (existing) {
        if (field(existing, 'digest') !== digest) throw new Error('Request ID already recorded with a different payload');
        return;
      }
      if (!this.db.prepare('SELECT id FROM allowances WHERE id = ?').get(allowanceId)) throw new Error('Unknown allowance ID');
      this.db.prepare(
        'INSERT INTO requests (id, allowance_id, investigation_id, session_id, kind, payload, digest, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, allowanceId, investigationId, sessionId, kind, payload, digest, 'authorized', Date.now());
    });
  }

  /** Return the stored request payload, or undefined when the ID was never authorized. */
  getRequest(id: string): AuthorizedRequest | undefined {
    assertId(id, 'request id');
    this.requireOpen();
    const row = this.db.prepare('SELECT payload, digest FROM requests WHERE id = ?').get(id);
    if (!row) return undefined;
    const payload = field(row, 'payload');
    if (field(row, 'digest') !== sha256(payload)) throw new Error('Stored request payload failed its digest check');
    return readRequest(parseJson(payload, 'Stored request payload'));
  }

  /**
   * Become the exclusive durable writer of a request. Exclusivity is per
   * investigation: while any request of the investigation holds an active
   * claim, claiming any other request of that investigation throws, even for
   * the same owner or a different session (concurrent copied-fork writers are
   * unsupported); distinct investigations never block each other. Repeating
   * the claim of the same request by the same owner is idempotent, a second
   * owner on a held claim is rejected (no automatic steal), and a finished
   * request can never be dispatched again.
   */
  claimRequest(id: string, owner: string): void {
    assertId(id, 'request id');
    assertId(owner, 'owner');
    this.tx(() => {
      const request = this.db.prepare('SELECT status, investigation_id FROM requests WHERE id = ?').get(id);
      if (!request) throw new Error('Unknown request ID');
      const status = field(request, 'status');
      if (status === 'completed' || status === 'interrupted') {
        throw new Error('Request already finished; finished requests are never dispatched again');
      }
      const active = this.db.prepare(
        'SELECT c.request_id, c.owner FROM claims c JOIN requests r ON r.id = c.request_id WHERE r.investigation_id = ? AND c.released_at IS NULL')
        .all(field(request, 'investigation_id'));
      const own = active.find(row => field(row, 'request_id') === id);
      if (own) {
        if (field(own, 'owner') === owner) return;
        throw new Error('Request already has an exclusive writer');
      }
      if (active.length > 0) {
        throw new Error('Investigation already has an active writer; finish or recover it before claiming another request');
      }
      this.db.prepare('INSERT INTO claims (request_id, owner, claimed_at, released_at, release_reason) VALUES (?, ?, ?, NULL, NULL)')
        .run(id, owner, Date.now());
      this.db.prepare('UPDATE requests SET status = ? WHERE id = ?').run('claimed', id);
    });
  }

  /**
   * Release this owner's claim and record the disposition. Returns true only
   * when this call performed the transition. Repeating the call, a stale late
   * owner, or an owner whose claim was revoked are all safe no-ops: a stale
   * owner can never release a newer owner's claim.
   */
  finishRequest(id: string, owner: string, disposition: RequestDisposition): boolean {
    assertId(id, 'request id');
    assertId(owner, 'owner');
    if (disposition !== 'completed' && disposition !== 'interrupted') {
      throw new Error("disposition must be 'completed' or 'interrupted'");
    }
    return this.tx(() => {
      const request = this.db.prepare('SELECT allowance_id FROM requests WHERE id = ?').get(id);
      if (!request) throw new Error('Unknown request ID');
      const active = this.db.prepare('SELECT owner, claimed_at FROM claims WHERE request_id = ? AND released_at IS NULL').get(id);
      if (!active || field(active, 'owner') !== owner) return false;
      const now = Date.now();
      this.releaseClaim(id, numberField(active, 'claimed_at'), field(request, 'allowance_id'), disposition, now);
      this.db.prepare('UPDATE requests SET status = ?, finished_at = ?, finish_owner = ?, disposition = ? WHERE id = ?')
        .run(disposition, now, owner, disposition, id);
      return true;
    });
  }

  /** True only while `owner` holds the request's active writer claim. */
  owns(id: string, owner: string): boolean {
    if (typeof id !== 'string' || typeof owner !== 'string' || !id || !owner) return false;
    this.requireOpen();
    const row = this.db.prepare('SELECT owner FROM claims WHERE request_id = ? AND released_at IS NULL').get(id);
    return row !== undefined && field(row, 'owner') === owner;
  }

  /**
   * Explicit user recovery, effective across the investigation: revoke every
   * active writer claim and mark every non-terminal request of the
   * investigation `interrupted` in the same transaction, so an old or revoked
   * request ID can never be claimed or redispatched — continuation continues
   * only through a newly authorized request ID. Completed requests keep their
   * disposition. Reservations are unchanged, confirmed spending is never
   * refunded, uncertain operations stay reserved, elapsed time accrued by the
   * revoked writer stays recorded, and nothing is retried automatically.
   * Repeating the call is a no-op.
   */
  interruptInvestigation(investigationId: string): void {
    assertId(investigationId, 'investigation id');
    this.tx(() => {
      const rows = this.db.prepare(
        'SELECT c.request_id, c.claimed_at, r.allowance_id FROM claims c JOIN requests r ON r.id = c.request_id WHERE r.investigation_id = ? AND c.released_at IS NULL')
        .all(investigationId);
      const now = Date.now();
      for (const row of rows) {
        this.releaseClaim(field(row, 'request_id'), numberField(row, 'claimed_at'), field(row, 'allowance_id'), 'revoked', now);
      }
      this.db.prepare('UPDATE requests SET status = ? WHERE investigation_id = ? AND status NOT IN (?, ?)')
        .run('interrupted', investigationId, 'completed', 'interrupted');
    });
  }

  // ----------------------------------------------------------- operations

  /**
   * Atomically reserve capacity for one operation. Repeating an existing
   * operation ID with the same allowance, lane, payload and amount returns
   * false and never redispatches; a conflicting reuse throws. Otherwise false
   * is a budget rejection: the selected-lane cap or the allowance's global
   * total (both measured against settled observations of every lane, so
   * visible overruns count) would be exceeded, or the active elapsed
   * allowance is exhausted. Malformed arguments throw: they are programming
   * errors, not budget rejections.
   */
  reserve(allowanceId: string, opId: string, payload: unknown, amount: Usage, lane: Lane = 'work'): boolean {
    assertId(allowanceId, 'allowanceId');
    assertId(opId, 'operationId');
    if (lane !== 'work' && lane !== 'synthesis') throw new Error("lane must be 'work' or 'synthesis'");
    const usage = readUsage(amount, 'amount');
    const payloadJson = canonicalize(payload);
    const digest = sha256(payloadJson);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT allowance_id, lane, payload, amount FROM operations WHERE id = ?').get(opId);
      if (existing) {
        if (field(existing, 'allowance_id') !== allowanceId || field(existing, 'lane') !== lane ||
          field(existing, 'payload') !== payloadJson || field(existing, 'amount') !== canonicalize(usage)) {
          throw new Error('Operation ID already recorded with a different reservation');
        }
        return false;
      }
      const allowance = this.readAllowance(allowanceId);
      const now = Date.now();
      if (allowance.effective.elapsedMs - this.elapsedMs(allowanceId, now) <= 0) return false;
      const cap = zeroUsage();
      for (const key of RESOURCE_KEYS) {
        const reserveLimit = allowance.synthesis[key] ?? 0;
        cap[key] = lane === 'synthesis' ? reserveLimit : Math.max(0, (allowance.effective[key] ?? 0) - reserveLimit);
      }
      const laneHeld = zeroUsage();
      const laneConfirmed = zeroUsage();
      const totalHeld = zeroUsage();
      const totalConfirmed = zeroUsage();
      for (const row of this.db.prepare('SELECT lane, status, amount, observed FROM operations WHERE allowance_id = ?').all(allowanceId)) {
        const storedAmount = readUsage(parseJson(field(row, 'amount'), 'stored operation amount'), 'stored operation amount');
        const parts = opContributions(field(row, 'status'), storedAmount, optionalField(row, 'observed'));
        const selected = field(row, 'lane') === lane;
        for (const key of RESOURCE_KEYS) {
          if (selected) {
            laneHeld[key] = (laneHeld[key] ?? 0) + parts.held[key];
            laneConfirmed[key] = (laneConfirmed[key] ?? 0) + parts.confirmed[key];
          }
          totalHeld[key] = (totalHeld[key] ?? 0) + parts.held[key];
          totalConfirmed[key] = (totalConfirmed[key] ?? 0) + parts.confirmed[key];
        }
      }
      for (const key of RESOURCE_KEYS) {
        const need = usage[key] ?? 0;
        if (need <= 0) continue;
        if ((laneHeld[key] ?? 0) + (laneConfirmed[key] ?? 0) + need > (cap[key] ?? 0)) return false;
        if ((totalHeld[key] ?? 0) + (totalConfirmed[key] ?? 0) + need > (allowance.effective[key] ?? 0)) return false;
      }
      this.db.prepare(
        'INSERT INTO operations (id, allowance_id, lane, payload, digest, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(opId, allowanceId, lane, payloadJson, digest, canonicalize(usage), 'reserved', now);
      return true;
    });
  }

  /** Record that the reserved operation was actually dispatched; idempotent. */
  dispatched(opId: string): void {
    assertId(opId, 'operationId');
    this.tx(() => {
      const op = this.db.prepare('SELECT dispatched_at FROM operations WHERE id = ?').get(opId);
      if (!op) throw new Error('Unknown operation ID; reserve before dispatch');
      if (optionalNumber(op, 'dispatched_at') === undefined) {
        this.db.prepare('UPDATE operations SET dispatched_at = ? WHERE id = ?').run(Date.now(), opId);
      }
    });
  }

  /**
   * Record the outcome. Observations are persisted cumulatively: known settles
   * confirm their full observations and release the residual hold, while
   * `meta.unknown` still confirms the observed portion and holds only
   * `max(reserved - observed, 0)` per resource as unresolved exposure — no
   * observations at all leaves the full reservation held. A later known settle
   * replaces the cumulative observations and releases the remaining hold; it
   * never adds to them. Replaying an identical settle is a no-op, observations
   * that would decrease already-confirmed counts throw (confirmed spending is
   * never refunded by a replay), and a conflicting settle of a confirmed
   * operation throws. Late settlement is safe regardless of request state.
   */
  settle(opId: string, observed: Usage, meta?: SettleMeta): void {
    assertId(opId, 'operationId');
    const usage = readUsage(observed, 'observed');
    const normalized = normalizeMeta(meta);
    const observedJson = canonicalize(usage);
    const settleKey = canonicalize({ observed: usage, meta: normalized });
    this.tx(() => {
      const op = this.db.prepare('SELECT status, settle_key, observed FROM operations WHERE id = ?').get(opId);
      if (!op) throw new Error('Unknown operation ID');
      const status = field(op, 'status');
      if (status === 'settled') {
        if (field(op, 'settle_key') !== settleKey) throw new Error('Operation already settled with different observations');
        return;
      }
      if (optionalField(op, 'settle_key') === settleKey) return;
      const priorRaw = optionalField(op, 'observed');
      const prior = priorRaw === undefined ? zeroUsage() : readUsage(parseJson(priorRaw, 'stored operation observed'), 'stored operation observed');
      for (const key of RESOURCE_KEYS) {
        if ((usage[key] ?? 0) < (prior[key] ?? 0)) throw new Error(`Observations may not decrease confirmed ${key}`);
      }
      const now = Date.now();
      if (normalized.unknown) {
        this.db.prepare('UPDATE operations SET status = ?, observed = ?, settle_key = ?, cost = ?, error = ? WHERE id = ?')
          .run('unknown', observedJson, settleKey, normalized.cost ?? null, normalized.error ?? null, opId);
        return;
      }
      this.db.prepare('UPDATE operations SET status = ?, observed = ?, settle_key = ?, settled_at = ?, cost = ?, error = ? WHERE id = ?')
        .run('settled', observedJson, settleKey, now, normalized.cost ?? null, normalized.error ?? null, opId);
    });
  }

  // ------------------------------------------------------------- inspection

  /** Named allowance view: limits, reserved/confirmed/remaining usage, operations, this allowance's grants and live elapsed time. */
  snapshot(allowanceId: string): AllowanceSnapshot {
    assertId(allowanceId, 'allowanceId');
    return this.tx(() => {
      const now = Date.now();
      const allowance = this.readAllowance(allowanceId);
      const grants: GrantView[] = [];
      for (const row of this.db.prepare('SELECT authorization_id, increments, created_at FROM grants WHERE kind = ? AND allowance_id = ? ORDER BY created_at, authorization_id').all('grant', allowanceId)) {
        grants.push({
          authorizationId: field(row, 'authorization_id'),
          increments: readIncrements(parseJson(field(row, 'increments'), 'grant increments'), 'grant increments'),
          createdAt: numberField(row, 'created_at'),
        });
      }
      const reserved = zeroUsage();
      const confirmed = zeroUsage();
      const unresolved = zeroUsage();
      const lanes = {
        work: { cap: zeroUsage(), reserved: zeroUsage(), confirmed: zeroUsage(), remaining: zeroUsage() },
        synthesis: { cap: zeroUsage(), reserved: zeroUsage(), confirmed: zeroUsage(), remaining: zeroUsage() },
      };
      for (const key of RESOURCE_KEYS) {
        const reserveLimit = allowance.synthesis[key] ?? 0;
        lanes.work.cap[key] = Math.max(0, (allowance.effective[key] ?? 0) - reserveLimit);
        lanes.synthesis.cap[key] = reserveLimit;
      }
      const operations: OperationView[] = [];
      let cost: number | undefined;
      for (const row of this.db.prepare('SELECT * FROM operations WHERE allowance_id = ? ORDER BY created_at, id').all(allowanceId)) {
        const lane = field(row, 'lane') as Lane;
        const status = field(row, 'status') as OperationView['status'];
        const amount = readUsage(parseJson(field(row, 'amount'), 'operation amount'), 'operation amount');
        const parts = opContributions(status, amount, optionalField(row, 'observed'));
        const observed = parts.observed;
        if (lane === 'work' || lane === 'synthesis') {
          for (const key of RESOURCE_KEYS) {
            lanes[lane].confirmed[key] = (lanes[lane].confirmed[key] ?? 0) + parts.confirmed[key];
            lanes[lane].reserved[key] = (lanes[lane].reserved[key] ?? 0) + parts.held[key];
          }
        }
        for (const key of RESOURCE_KEYS) {
          confirmed[key] = (confirmed[key] ?? 0) + parts.confirmed[key];
          reserved[key] = (reserved[key] ?? 0) + parts.held[key];
        }
        if (status === 'unknown') for (const key of RESOURCE_KEYS) unresolved[key] = (unresolved[key] ?? 0) + parts.held[key];
        const opCost = optionalNumber(row, 'cost');
        if (opCost !== undefined) cost = (cost ?? 0) + opCost;
        const view: OperationView = {
          operationId: field(row, 'id'),
          lane,
          payload: parseJson(field(row, 'payload'), 'operation payload'),
          amount,
          status,
          createdAt: numberField(row, 'created_at'),
        };
        const dispatchedAt = optionalNumber(row, 'dispatched_at');
        if (dispatchedAt !== undefined) view.dispatchedAt = dispatchedAt;
        const settledAt = optionalNumber(row, 'settled_at');
        if (settledAt !== undefined) view.settledAt = settledAt;
        if (observed) view.observed = observed;
        if (opCost !== undefined) view.cost = opCost;
        const error = optionalField(row, 'error');
        if (error !== undefined) view.error = error;
        operations.push(view);
      }
      const remaining = zeroUsage();
      for (const key of RESOURCE_KEYS) {
        remaining[key] = (allowance.effective[key] ?? 0) - reserved[key] - confirmed[key];
        lanes.work.remaining[key] = lanes.work.cap[key] - lanes.work.reserved[key] - lanes.work.confirmed[key];
        lanes.synthesis.remaining[key] = lanes.synthesis.cap[key] - lanes.synthesis.reserved[key] - lanes.synthesis.confirmed[key];
      }
      const elapsedMs = this.elapsedMs(allowanceId, now);
      const activeWriters = this.db.prepare(
        'SELECT c.request_id, c.owner, c.claimed_at FROM claims c JOIN requests r ON r.id = c.request_id WHERE r.allowance_id = ? AND c.released_at IS NULL')
        .all(allowanceId)
        .map(row => ({ requestId: field(row, 'request_id'), owner: field(row, 'owner'), since: numberField(row, 'claimed_at') }));
      return {
        allowanceId,
        limits: allowance.effective,
        baseLimits: allowance.base,
        synthesis: allowance.synthesis,
        reserved,
        confirmed,
        remaining,
        unresolved,
        lanes,
        elapsedMs,
        remainingElapsedMs: (allowance.effective.elapsedMs ?? 0) - elapsedMs,
        cost,
        operations,
        grants,
        activeWriters,
      };
    }, false);
  }

  // --------------------------------------------------------------- hosting

  /**
   * Reserve the next start slot for a hostname from the shared SQLite table,
   * then wait outside any transaction. Concurrent callers (including other
   * processes on the same ledger file) queue at least `delayMs` apart. An
   * abort during the wait throws; the already-reserved slot keeps its spacing.
   */
  async waitForHost(host: string, delayMs: number, signal?: AbortSignal): Promise<void> {
    if (typeof host !== 'string' || !host) throw new Error('host must be a non-empty string');
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) throw new Error('delayMs must be a non-negative finite number');
    if (signal?.aborted) throw abortReason(signal);
    const slotAt = this.tx(() => {
      const now = Date.now();
      const existing = this.db.prepare('SELECT next_at FROM host_slots WHERE host = ?').get(host);
      const at = Math.max(now, existing ? numberField(existing, 'next_at') : now);
      this.db.prepare('INSERT INTO host_slots (host, next_at) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET next_at = excluded.next_at')
        .run(host, at + delayMs);
      return at;
    });
    const wait = slotAt - Date.now();
    if (wait > 0) await sleep(wait, signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---------------------------------------------------------------- internals

  private requireOpen(): void {
    if (this.closed) throw new Error('Ledger is closed');
  }

  /** Short atomic transaction; `immediate` takes the write lock up front. No I/O beyond SQLite runs inside. */
  private tx<T>(body: () => T, immediate = true): T {
    this.requireOpen();
    if (this.db.isTransaction) throw new Error('Nested ledger transaction');
    this.db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const value = body();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* The original failure is reported. */ }
      throw error;
    }
  }

  private readAllowance(allowanceId: string): { base: Limits; synthesis: Usage; effective: Limits } {
    const row = this.db.prepare('SELECT base_limits, synthesis FROM allowances WHERE id = ?').get(allowanceId);
    if (!row) throw new Error('Unknown allowance ID');
    const base = readLimits(parseJson(field(row, 'base_limits'), 'allowance limits'), 'allowance limits');
    const synthesis = readUsage(parseJson(field(row, 'synthesis'), 'allowance synthesis'), 'allowance synthesis');
    const effective: Limits = { ...base };
    const increments = this.db.prepare('SELECT increments FROM grants WHERE allowance_id = ? AND kind = ?').all(allowanceId, 'grant');
    for (const grant of increments) {
      const delta = readIncrements(parseJson(field(grant, 'increments'), 'grant increments'), 'grant increments');
      for (const key of LIMIT_KEYS) effective[key] = (effective[key] ?? 0) + (delta[key] ?? 0);
    }
    return { base, synthesis, effective };
  }

  /** Recorded elapsed time: released claims are settled, live claims accrue now minus claim start. */
  private elapsedMs(allowanceId: string, now: number): number {
    const accruedRow = this.db.prepare('SELECT accrued_ms FROM elapsed WHERE allowance_id = ?').get(allowanceId);
    if (!accruedRow) throw new Error('Unknown allowance ID');
    let total = numberField(accruedRow, 'accrued_ms');
    const active = this.db.prepare(
      'SELECT c.claimed_at FROM claims c JOIN requests r ON r.id = c.request_id WHERE r.allowance_id = ? AND c.released_at IS NULL')
      .all(allowanceId);
    for (const row of active) total += Math.max(0, now - numberField(row, 'claimed_at'));
    return total;
  }

  /** Release the active claim and durably accrue its elapsed time to the allowance. */
  private releaseClaim(requestId: string, claimedAt: number, allowanceId: string, reason: string, now: number): void {
    this.db.prepare('UPDATE claims SET released_at = ?, release_reason = ? WHERE request_id = ? AND released_at IS NULL')
      .run(now, reason, requestId);
    this.db.prepare('UPDATE elapsed SET accrued_ms = accrued_ms + ? WHERE allowance_id = ?')
      .run(Math.max(0, now - claimedAt), allowanceId);
  }
}
