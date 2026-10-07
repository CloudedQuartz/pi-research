/**
 * Regression: the engine must hand `expandedQuery`'s actual weight map to
 * `PassageIndex.rank` through its real retrieval path — never a flattened
 * concatenated string. The capture happens at the rank call itself (prototype
 * spy driven through `ResearchEngine.run`), not by unit-testing the helper.
 *
 * Run: npx tsx test/engine-retrieval.test.ts   (exit 1 on any failed check)
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchEngine, newInvestigation } from '../src/engine.js';
import { Ledger } from '../src/allowance.js';
import { ObjectStore, validateInvestigation } from '../src/object-store.js';
import { PassageIndex, segment } from '../src/core-ir.js';
import type { EngineHost, Concept, Investigation, Snapshot, SearchHit } from '../src/types.js';

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const TEXT = [
  'Quantum foxberry taxonomy survey methods were revised during the 2024 season.',
  'Researchers catalogue quantum foxberry variants with field taxonomy notes and reproducible survey methods.',
].join('\n\n');

function fixtureSnapshot(store: ObjectStore, url: string): Snapshot {
  const raw = `<html><head><title>Quantum foxberry taxonomy</title></head><body><p>${TEXT.split('\n\n').join('</p><p>')}</p></body></html>`;
  const rawBlob = store.put(raw);
  const textBlob = store.put(TEXT);
  const snapshot: Snapshot = {
    id: rawBlob, requestedUrl: url, finalUrl: url, canonicalUrl: url,
    fetchedAt: new Date().toISOString(), contentHash: rawBlob, textHash: textBlob,
    rawBlob, textBlob, mime: 'text/html', status: 200,
    title: 'Quantum foxberry taxonomy', extraction: 'fixture', extractionVersion: '1', text: TEXT,
  };
  store.saveSnapshot(snapshot);
  return snapshot;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'engine-retrieval-'));
  const captured: unknown[] = [];
  let delegationError: unknown;
  const originalRank = PassageIndex.prototype.rank;
  try {
    const store = new ObjectStore(root);
    const ledger = new Ledger(join(root, 'ledger.sqlite'));
    const allowanceId = ledger.authorize(
      { searches: 20, fetches: 20, http: 40, modelCalls: 20, modelTokens: 100_000, elapsedMs: 300_000 },
      { modelCalls: 5, modelTokens: 30_000 }, `auth-${randomUUID()}`);
    const requestId = randomUUID();
    const owner = 'retrieval-regression';
    ledger.authorizeRequest({
      id: requestId, allowanceId, investigationId: 'inv-1', sessionId: 'session-1', kind: 'start',
      question: 'Quantum foxberry taxonomy survey methods', provider: 'brave', searchTool: 'web', storageRoot: root,
    });
    ledger.claimRequest(requestId, owner);

    const seed = newInvestigation({ id: 'inv-1', allowanceId, storageRoot: root, question: 'Quantum foxberry taxonomy survey methods' });
    const snapshot = fixtureSnapshot(store, 'https://example.org/quantum-foxberry');
    const passages = segment(snapshot);
    const objective = {
      id: randomUUID(), input: seed.originalQuestion, question: 'Quantum foxberry taxonomy survey methods',
      constraints: [], createdAt: new Date().toISOString(),
    };
    const branch = {
      id: randomUUID(), objectiveId: objective.id, question: 'Quantum foxberry taxonomy survey methods',
      anchor: 'quantum foxberry taxonomy', origin: 'initial' as const, introducing: [],
      priority: 0.7, status: 'active' as const,
      needs: [{ id: randomUUID(), question: 'identify survey methods', weight: 1, status: 0 as const }],
      aliases: [], queries: [], zeroYieldEpisodes: 0, stats: {},
    };
    const concept: Concept = {
      id: randomUUID(), branchId: branch.id, term: 'foxberry survey methods',
      score: 0.9, anchorRelevance: 0.85, introducing: [], classification: 'alias',
    };
    const state: Investigation = {
      ...seed, objectives: [objective], activeObjectiveId: objective.id, branches: [branch],
      snapshotIds: [snapshot.id], passages, concepts: [concept], corpusRevision: 1,
    };
    validateInvestigation(state); // fail fast on an invalid fixture

    const host: EngineHost = {
      model: {
        async complete(task) {
          if (task !== 'assess') throw new Error(`unexpected model task in regression: ${task}`);
          return {
            value: { relevantPassageIds: [], contributions: [] },
            usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50 },
            usageComplete: true,
          };
        },
      },
      discover: async query => ({ query, provider: 'brave', rankingKind: 'ranked', results: [] }),
      acquire: async () => { throw new Error('regression scenario must not fetch'); },
      commit: () => { /* publication not under test */ },
      isCurrent: () => true,
      progress: () => { /* progress text not under test */ },
    };

    // Capture what the engine actually passes at its rank call site.
    PassageIndex.prototype.rank = function (query: string, limit = 30, phrases?: string[]): SearchHit[] {
      captured.push(query);
      try { return originalRank.call(this, query, limit, phrases); }
      catch (error) { delegationError = error; return []; }
    };

    const engine = new ResearchEngine({
      state, ledger, store, host, requestId, owner,
      signal: new AbortController().signal, options: { maxActions: 1 },
    });
    const finished = await engine.run('', 'start');
    check('engine run resolved through retrieval', !!finished);

    check('rank was called through the engine path', captured.length >= 1, `captures=${captured.length}`);
    const query = captured[0];
    check('rank received the weight map, not a flattened string',
      typeof query === 'object' && query !== null, `typeof=${typeof query}`);
    if (typeof query === 'object' && query !== null) {
      const weights = query as Record<string, number>;
      const entries = Object.entries(weights);
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      check('all weights are nonnegative', entries.every(([, weight]) => Number.isFinite(weight) && weight >= 0));
      check('map is L1-normalized (~1)', Math.abs(total - 1) < 1e-9, `total=${total}`);
      const anchorKeys = entries.filter(([key]) => !key.includes(' '));
      const anchorMass = anchorKeys.reduce((sum, [, weight]) => sum + weight, 0);
      check('anchor terms keep >=75% of lexical mass', anchorMass >= 0.75 - 1e-9, `anchorMass=${anchorMass}`);
      check('anchor terms present',
        ['quantum', 'foxberry', 'taxonomy'].every(term => term in weights), `keys=${entries.map(([key]) => key).join('|')}`);
      check('expansion phrase key preserved with 25% mass',
        typeof weights['foxberry survey methods'] === 'number' && Math.abs(weights['foxberry survey methods']! - 0.25) < 1e-9,
        `phraseWeight=${weights['foxberry survey methods']}`);
    }
    check('rank accepted the map argument at runtime', delegationError === undefined,
      delegationError instanceof Error ? delegationError.message : String(delegationError));
  } finally {
    PassageIndex.prototype.rank = originalRank;
    rmSync(root, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

main().catch(error => {
  console.error('regression crashed:', error);
  process.exitCode = 1;
});
