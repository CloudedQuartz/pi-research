/**
 * Offline regression for optional elapsed allowance semantics.
 *
 * An absent `Limits.elapsedMs` means no deadline while an explicit zero is
 * already exhausted. Unrelated grants must not turn absence into zero, an
 * elapsed grant is a total cap that includes time already accrued, elapsed
 * time stays tracked either way, and reopening the ledger preserves both the
 * absence and any finite cap. No network, model or host calls are made.
 *
 * Run: npx tsx test/allowance-elapsed.test.ts   (exit 1 on any failed check)
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/allowance.js';
import type { Limits } from '../src/types.js';

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const OWNER = 'elapsed-owner';
const BASE: Limits = { searches: 50, fetches: 50, http: 50, modelCalls: 50, modelTokens: 100_000 };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const roots: string[] = [];

function open(): { ledger: Ledger; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'allowance-elapsed-'));
  roots.push(root);
  const path = join(root, 'ledger.sqlite');
  return { ledger: new Ledger(path), path, root };
}

function authorize(ledger: Ledger, limits: Limits): string {
  return ledger.authorize(limits, {}, `auth-${randomUUID()}`);
}

/** Claim a request so active writer time accrues against the allowance. */
function claim(ledger: Ledger, allowanceId: string): string {
  const requestId = randomUUID();
  ledger.authorizeRequest({ id: requestId, allowanceId, investigationId: `inv-${requestId}`,
    sessionId: `session-${requestId}`, kind: 'start', question: 'elapsed regression',
    provider: 'brave', searchTool: 'web', storageRoot: '/tmp/allowance-elapsed' });
  ledger.claimRequest(requestId, OWNER);
  return requestId;
}

function reserve(ledger: Ledger, allowanceId: string): boolean {
  return ledger.reserve(allowanceId, randomUUID(), { requestId: randomUUID() }, { searches: 1 });
}

async function caseAbsent(): Promise<void> {
  const { ledger } = open();
  try {
    const allowanceId = authorize(ledger, { ...BASE });
    const initial = ledger.snapshot(allowanceId);
    check('absent elapsed cap leaves limits.elapsedMs absent', initial.limits.elapsedMs === undefined && !Object.hasOwn(initial.limits, 'elapsedMs'));
    check('absent cap reports remainingElapsedMs undefined', initial.remainingElapsedMs === undefined);
    check('elapsed time is still tracked without a cap', typeof initial.elapsedMs === 'number' && initial.elapsedMs >= 0);
    check('reservation is allowed without a deadline', reserve(ledger, allowanceId));

    const requestId = claim(ledger, allowanceId);
    await sleep(60);
    const live = ledger.snapshot(allowanceId);
    check('a live writer accrues elapsed time without a cap', live.elapsedMs >= 50, `elapsedMs=${live.elapsedMs}`);
    check('reservation stays allowed while time accrues without a cap', live.remainingElapsedMs === undefined && reserve(ledger, allowanceId));
    check('claim released after the no-deadline run', ledger.finishRequest(requestId, OWNER, 'completed'));
  } finally { ledger.close(); }
}

function caseExplicitZero(): void {
  const { ledger } = open();
  try {
    const allowanceId = authorize(ledger, { ...BASE, elapsedMs: 0 });
    const snapshot = ledger.snapshot(allowanceId);
    check('explicit zero elapsed cap reports zero remaining', snapshot.remainingElapsedMs === 0);
    check('explicit zero elapsed cap is already exhausted', !reserve(ledger, allowanceId));
  } finally { ledger.close(); }
}

async function caseFinite(): Promise<void> {
  const { ledger } = open();
  try {
    const allowanceId = authorize(ledger, { ...BASE, elapsedMs: 80 });
    check('finite elapsed cap reports its remaining time', ledger.snapshot(allowanceId).remainingElapsedMs === 80);
    check('reservation is allowed under a finite cap', reserve(ledger, allowanceId));

    const requestId = claim(ledger, allowanceId);
    await sleep(120);
    const live = ledger.snapshot(allowanceId);
    check('live writer time consumes the finite cap', (live.remainingElapsedMs ?? 1) <= 0, `remaining=${live.remainingElapsedMs}`);
    check('exhausted finite cap blocks new reservations', !reserve(ledger, allowanceId));
    ledger.finishRequest(requestId, OWNER, 'completed');
    check('released finite-cap elapsed stays recorded', (ledger.snapshot(allowanceId).elapsedMs ?? 0) >= 100);
  } finally { ledger.close(); }
}

function caseGrants(): void {
  const { ledger } = open();
  try {
    const uncapped = authorize(ledger, { ...BASE });
    ledger.addGrant(uncapped, { searches: 5 }, `grant-${randomUUID()}`);
    const unrelated = ledger.snapshot(uncapped);
    check('an unrelated grant preserves an absent elapsed cap', unrelated.limits.elapsedMs === undefined && unrelated.remainingElapsedMs === undefined);
    check('an unrelated grant still increments its own limit', unrelated.limits.searches === BASE.searches + 5, `searches=${unrelated.limits.searches}`);
    check('reservation remains allowed after an unrelated grant', reserve(ledger, uncapped));

    ledger.addGrant(uncapped, { elapsedMs: 0 }, `grant-${randomUUID()}`);
    const zeroed = ledger.snapshot(uncapped);
    check('an explicit zero elapsed grant starts exhausted', zeroed.remainingElapsedMs === 0 && !reserve(ledger, uncapped));

    const finite = authorize(ledger, { ...BASE, elapsedMs: 100 });
    ledger.addGrant(finite, { elapsedMs: 50 }, `grant-${randomUUID()}`);
    check('an elapsed grant adds to an existing finite cap', ledger.snapshot(finite).limits.elapsedMs === 150);
  } finally { ledger.close(); }
}

async function caseElapsedGrantCountsPriorTime(): Promise<void> {
  const { ledger } = open();
  try {
    const allowanceId = authorize(ledger, { ...BASE });
    const requestId = claim(ledger, allowanceId);
    await sleep(60);
    const beforeGrant = ledger.snapshot(allowanceId);
    ledger.addGrant(allowanceId, { elapsedMs: 10 }, `grant-${randomUUID()}`);
    const capped = ledger.snapshot(allowanceId);
    check('an elapsed grant caps time already accrued', capped.elapsedMs >= 50 && (capped.remainingElapsedMs ?? 0) < 0,
      `elapsedMs=${capped.elapsedMs} remaining=${capped.remainingElapsedMs}`);
    check('an elapsed grant over prior time can start exhausted', !reserve(ledger, allowanceId));

    ledger.addGrant(allowanceId, { elapsedMs: Math.ceil(beforeGrant.elapsedMs) + 10_000 }, `grant-${randomUUID()}`);
    const reopened = ledger.snapshot(allowanceId);
    check('a larger elapsed grant reopens a deadline that started exhausted', (reopened.remainingElapsedMs ?? -1) > 0 && reserve(ledger, allowanceId),
      `remaining=${reopened.remainingElapsedMs}`);
    ledger.finishRequest(requestId, OWNER, 'completed');
  } finally { ledger.close(); }
}

async function caseReopen(): Promise<void> {
  const { ledger, path } = open();
  const uncapped = authorize(ledger, { ...BASE });
  const finite = authorize(ledger, { ...BASE, elapsedMs: 500 });
  const requestId = claim(ledger, uncapped);
  await sleep(60);
  ledger.finishRequest(requestId, OWNER, 'completed');
  const beforeClose = ledger.snapshot(uncapped);
  ledger.close();

  const reopened = new Ledger(path);
  try {
    const noDeadline = reopened.snapshot(uncapped);
    check('reopen preserves an absent elapsed cap', noDeadline.limits.elapsedMs === undefined && noDeadline.remainingElapsedMs === undefined && !Object.hasOwn(noDeadline.limits, 'elapsedMs'));
    check('reopen preserves accrued elapsed time without a cap', noDeadline.elapsedMs === beforeClose.elapsedMs && noDeadline.elapsedMs >= 50,
      `before=${beforeClose.elapsedMs} after=${noDeadline.elapsedMs}`);
    check('reservation is allowed after reopening without a cap', reserve(reopened, uncapped));

    const capped = reopened.snapshot(finite);
    check('reopen preserves an existing finite elapsed cap', capped.limits.elapsedMs === 500 && capped.remainingElapsedMs === 500 - capped.elapsedMs,
      `limits=${capped.limits.elapsedMs} remaining=${capped.remainingElapsedMs}`);
  } finally { reopened.close(); }
}

async function main(): Promise<void> {
  try {
    await caseAbsent();
    caseExplicitZero();
    await caseFinite();
    caseGrants();
    await caseElapsedGrantCountsPriorTime();
    await caseReopen();
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log('\nall elapsed allowance checks passed');
}

main().catch(error => {
  console.error('elapsed allowance regression crashed:', error);
  process.exitCode = 1;
});
