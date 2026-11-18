# Implementation handover

## Current checkpoint — implementation resumed

The full approved scope remains [project-plan.md](project-plan.md); the application is **not yet complete**. Do not repeat scaffolding or replace unfinished owners because of stalls.

Recent verified milestones:

- `e9b7000`: allowance ledger, investigation-wide writer exclusion, terminal interrupted requests, conservative residual accounting. Delegated offline checks: 17 accounting + 21 ownership/recovery assertions.
- `90a65e9`: positional weighted BM25, distinct-document DF, surface phrase matching, corpus-based MMR and ordinary duplicate-group suppression. Delegated offline checks: 19 IR regressions plus the shared-interface suite.
- `eb3bda1`: validated explicit coverage updates, persisted current passage witnesses, changed-context local reuse for addressed needs, report witness inclusion, and negative-feedback invalidation. Delegated interface suite: 10 cases; full-project typecheck passed.
- Acquisition and immutable snapshot/citation fixes are committed in `1776157` and `f83c753`. Their checks were offline, not real-provider or real-socket end-to-end trials.

`6b8c023` commits the complete engine component and permanent retrieval/coverage regressions. Query-key and packet-citation fixes are in `122ba78` / `d3f8c95`. Expansion re-ranking is intentional: stamp the query actually evaluated, not the post-expansion query. Stop fences all normal logical publication while allowing only a fixed paused/interrupted-action disposition; accounting and physical orphans remain retained.

The package now registers `src/extension.ts`. `npm test` runs permanent IR, engine, actual SDK/package-loading and evaluator checks (52 cases/checks); `npm run typecheck` passes. The real adapter also passed 48 checks across nine temporary lifecycle/finalization-recovery cases against the final engine. These are offline proofs, not live provider or interactive end-to-end trials. No implementation worker remains active at this checkpoint.

Additional delegated offline results: 50 engine smoke checks, 36 coverage checks, 43 cancellation checks (fence-disabled negative control fails 18), 22 synthesis checks, 15 weighted-key checks and 14 strict text-cap checks. The 48k synthesis bound counts UTF-16 passage-text units, not the whole serialized prompt. Model citations are limited to actual packet IDs; current audit/qualification witnesses are prioritized, with omissions disclosed.

Temporary regression evidence remains in `/tmp/engine-smoke/smoke.ts`, `/tmp/engine-cancel.test.ts`, `/tmp/engine-synthesis.test.ts`, `/tmp/engine-key-wiring.test.ts`, `/tmp/engine-cap-edge.test.ts`, `/tmp/ext-verify-run/extension-auth.test.mts` and the earlier ledger/IR suites. Sequential engine fixtures explicitly finish previous requests before claiming the same investigation; never relax production single-writer exclusion to pass tests.

`a0e2c82` adds the frozen-corpus evaluation CLI and six permanent regression cases, including key-safe qrels and ranking independence from grades. `3d42353` adds `npm run demo`: a clearly labelled synthetic replay with 17 checks and stable canonicalized behavior digest, not a live provider run.

The user subsequently requested **no report work**. An already-created `docs/report.md` draft remains untracked; do not continue it or treat it as a deliverable. The user approved temporary capped-copy preparation and offline guard verification, then explicitly authorized **one Exa live smoke** with session model `opencode-go/deepseek-v4.1-flash`. Per-run caps: 1 nested search, 2 fetch attempts, 8 acquisition HTTP requests, 8 nested model calls (including synthesis), 60k estimated tokens and 90 seconds in-run. Unknown outer-model/provider-hidden costs were disclosed and accepted; no retries, extra grants, other providers or global-settings edits are authorized. Implement owner `d94b6a0e-e025-475` confirmed the pause took effect before any dispatch, grant, or launcher creation. The user then requested continuation; the original worker could not be resumed after a session reset. Do not count preparation as an attempt. The capped copy is `/tmp/pi-research-smoke-W3bf3W/extension.ts` (38 offline checks); the guard is `/tmp/pi-research-smoke-guard-hhLGNJ/guard.ts` (20 inert native-pipeline assertions). These are preparatory component proofs, not a completed live run. Human labels were queried, not supplied; an existing human-labelled benchmark is acceptable, and manual annotation is not required for the smoke.

Next: collect the single authorized smoke result and preserve its paid artifacts; report failed/partial evidence honestly without automatic retry. Preserve critical temporary regressions proportionally, and clarify benchmark input only if measured evaluation is wanted. Frozen retrieval evaluation must reject exact-text aliases before scoring; keep near variants distinct and use the same frozen human-judged corpus for all methods. This retrieval ablation alone does not establish research-policy or conversational quality. No provider run has been completed. Beyond the single scoped Exa smoke, paid live calls and global configuration changes are not authorized. Human benchmark results and course submission details are separate milestones. Keep model-rate estimates distinct from provider-reported costs, and answer coverage distinct from factual confidence.

## Historical checkpoint

> The remaining sections describe commit `6d65054`, not the current filesystem. Preserve them as history; use the current checkpoint above and repository state when resuming.

## Start here

Implementation is **paused**, not finished. The full approved specification is [project-plan.md](project-plan.md). Resume that scope; do not replace it with a smaller chatbot or declare the drafts working.

The user intends to change the existing **Implement** agent configuration to **DeepSeek v4.1 Flash** before the next session. Do not edit that global configuration on their behalf. Read the agent definitions at startup and use their configured model/thinking settings without overrides.

## User instructions for the next session

- Delegate concrete implementation units with clear file ownership and fixed interfaces.
- Use the existing agent configurations; no model or thinking overrides.
- A stall or interrupted worker is not permission to switch providers, duplicate work, or discard its progress. The configured Implement provider returned explicit 429 errors before executing the latest assignments; do not confuse that with an ordinary stall.
- Commit focused milestones continuously. Do not wait for the entire application before committing useful code.
- Prioritize actual implementation. Keep verification proportional to each component; do not spend an implementation turn building a large test suite or repeatedly probing an already-known environment.
- Preserve pre-existing changes. Use targeted `edit` on existing files; whole-file replacement needs approval.
- Project-local dependency downloads were explicitly approved. Global installation, paid live research calls, and changes to user configuration were not authorized.

## Repository state

### Implemented shared modules

| File | Current responsibility |
|---|---|
| `src/types.ts` | Domain contracts for objectives, branches/needs, snapshots/passages, concepts, contributions, actions, reports, limits and engine-host interfaces |
| `src/pi-model.ts` | Tool-free structured model-task adapter, usage aggregation, and normalization of structured discovery results; preserves observed usage on parse/stop failures |
| `src/report.ts` | Structurally validated passage-cited report construction and an explicitly extractive fallback outline |
| `src/views.ts` | Plain-text research map, source list, evidence inspection and BM25 score rendering with terminal-control sanitization |

These are shared components, **not a working research engine**. No live web, nested-tool or end-to-end application test has been performed. A successful TypeScript check establishes type consistency only.

### Preserved unfinished drafts

| File | Why it is a draft |
|---|---|
| `docs/drafts/extension.ts.txt` | Pi commands, authorization and tool wiring reference foundations that do not exist yet. Lifecycle/concurrency and complete tool exposure still need review. |
| `docs/drafts/evaluate.ts.txt` | Frozen-corpus metric/ablation harness depends on the missing IR engine. It has not been run against human judgments. |

The drafts are original partial implementation work preserved for reuse, not verified templates. Their `.txt` extensions intentionally keep them out of compilation and extension loading. Promote them only after reviewing and integrating them; do not copy blindly.

### Missing components

No implementations exist for:

- `src/core-ir.ts`
- `src/object-store.ts`
- `src/allowance.ts`
- `src/acquisition.ts`
- `src/engine.ts`
- a runnable `src/extension.ts`
- tests, a demo script, a runnable evaluation script or evaluation judgments/results

The interrupted workers did not deliver these modules. Check the filesystem again rather than assuming a prior task completed.

### Package and verification state

- Node 24.13.1; npm 11.12.1 were checked.
- `package.json` and `tsconfig.json` were generated with `npm init --yes` and `tsc --init`, then edited.
- Approved dependencies are installed locally and pinned in `package-lock.json`: Readability, LinkeDOM, unpdf, robots-parser, ipaddr.js, TypeScript, tsx, Node types and the Pi contracts. Pi packages and TypeBox are declared as peers with development copies for checking.
- Built-in `node:sqlite` is available; use it for transactional operational accounting, not retrieval.
- `npm run typecheck` passed after the incomplete integration/evaluation files were moved to drafts, including after the small boundary fixes. It checks the four current shared modules only. An additional active LSP probe timed out for all four files and is inconclusive, not proof of clean diagnostics.
- `npm install --package-lock-only --ignore-scripts` synchronized the cleaned manifest and reported zero known vulnerabilities for that installation. This is not a general security audit.
- Runnable extension registration and test/demo/evaluation scripts were removed because their referenced files did not exist. Restore each only when its implementation exists.
- No implementation behavior tests were run or written. No paid live research calls were made.
- The configured Review worker subsequently completed: no blocking findings within the four shared modules; project and standalone TypeScript checks passed. Its provider-metadata finding concerns the earlier implementation and was already addressed during cleanup. It performed no behavior tests and did not verify the application end to end.

## Resume in dependency order

### 1. Shared-module review and focused fixes

First inspect the current shared modules and any retained Review findings. Small boundary fixes were made during cleanup: citation offsets now require JSON numbers and valid passage/snapshot bounds; absent provider metadata now gives unknown ranking, and contradictory/multiple identity bindings are rejected. These changes have not been behavior-tested.

Remaining areas to verify before trusting runtime inputs:

- Citation support is only mechanical; the missing contextual evidence assessment must establish semantic relevance.
- Domain IDs, snapshot URLs and all rehydrated state require validation at their persistence boundary. No immutable-store implementation exists yet.
- The reviewer noted that an invalid cited snapshot URL aborts report construction outside the model fallback path. Keep fail-closed behavior or explicitly design safe degradation; acquisition/storage must guarantee valid public HTTP(S) URLs.
- The reviewer also noted that `irrelevant` feedback currently filters passage IDs only. Define evidence feedback as passage-targeted, or explicitly propagate other target kinds when implementing the controller; do not silently accept ineffective feedback.

The shared contracts/adapters are committed as their own unit after a bounded TypeScript check; this does not make the system runnable. Apply subsequent review fixes in focused commits.

### 2. Independent foundation ownership

Delegate these as separate concrete units, not oversized all-in-one workers:

1. **IR:** `src/core-ir.ts` — positional index, BM25 explanations, passage segmentation, duplicates, MMR, provenance-bearing TF-IDF candidates and anchored expansion.
2. **Object storage:** `src/object-store.ts` — immutable content-addressed blobs and snapshots; active-path manifest rehydration.
3. **Accounting:** `src/allowance.ts` — transactional grants, command authorization, request claims, operation reservations/settlement and shared hostname scheduling.

Each worker reads `src/types.ts` and the relevant plan section, implements its module first, then performs a bounded check and reports concrete evidence. Parent integrates and commits each coherent result. Add focused regression tests alongside real code, without letting test scaffolding substitute for implementation.

### 3. Acquisition after storage/accounting

Implement `src/acquisition.ts` with Readability/LinkeDOM and unpdf, a real robots parser, a shared hostname delay queue and pinned public-address HTTP(S) transport. DNS checks must govern the actual socket. Redirects, robots requests and retries must all obey policy and accounting. Bound bytes and extraction time; worker-based extraction must be terminable. Do not relax SSRF policy to make localhost fixtures pass.

### 4. Controller and reports

Implement `src/engine.ts` against those fixed interfaces: initial planning, corpus acquisition, contextual assessment, grounded expansion, action utility, complete search episodes, yield ledger, stopping, follow-up objective revisions, report synthesis and fallback. Model output cannot grant budget or provide authoritative progress/confidence. Commit this as an integrated engine milestone.

### 5. Pi integration

Review/promote the extension draft once its imports are real. Required outstanding integration work includes:

- Strong state/schema validation and branch-specific corpus membership.
- Durable request ownership and generation/session/objective guards on **every** mutation, including feedback; the draft's feedback writes bypass durable writer ownership.
- Ledger cleanup that does not invalidate late operational settlement.
- Protected synthesis reservations and elapsed-time checks.
- Exact structured tool result schemas/content for programmatic callers.
- Complete planned tool operations, including policy-controlled source acquisition, without bypass paths.
- Safe cancellation and interrupted-request reconciliation without automatic redispatch.
- Per-call discovery tool activation and validated structured results.
- Runtime smoke testing with Pi 1.0.4 and pi-web-access 0.37.0, only with authorization for live usage.

Restore package `pi.extensions` registration after the entry point is runnable, not before.

### 6. Evaluation/demo/submission

Promote and validate the evaluation draft; collect actual human passage judgments, never generated benchmark results. Add deterministic replay for regression use, not as a substitute for the live course demo. Finish the README with real commands/results and documented limitations. Course report, video and actual work division remain human deliverables.

## Proposed interfaces already briefed

These interfaces are coordination decisions, not existing code. Keep names stable where reasonable; settle consequential changes with the parent before implementation.

### IR (`core-ir.ts`)

```text
tokenize(text): Token[]
segment(snapshot): Passage[]
PassageIndex.add(passages), get(id), all(), stats, rank(query, limit=30, phrases?)
mmr(hits, count=8, lambda=.75): SearchHit[]
concepts(hits, branch, feedback, limit=12): Concept[]
expandedQuery(anchor, concepts, negativePassages?): Record<string, number>
```

Stopwords remain in the positional stream; scoring normalization is separate. Incremental and rebuilt indexes must agree. Exact duplicates score once while aliases retain branch-visible provenance; near duplicates remain inspectable and do not imply factual equivalence.

### Object storage (`object-store.ts`)

```text
ObjectStore(root)
put(bytes|string): hash
read(hash): Buffer
saveSnapshot(snapshot): void
loadSnapshot(id): Snapshot
rehydrate(chronologicalActivePathEntries): Investigation | undefined
```

Write blobs before manifests. No scanning to discover corpus membership. Identical blobs can back distinct immutable retrieval records with different URLs/times. Only the active path's latest validated manifest is authoritative.

### Accounting (`allowance.ts`)

```text
Ledger(path)
authorize(limits, synthesisReserve, authorizationId): allowanceId
addGrant(allowanceId, increments, authorizationId)
authorizeRequest(request), getRequest(id)
claimRequest(id, owner), finishRequest(id, owner, completed|interrupted)
owns(requestId, owner), interruptInvestigation(id)
reserve(allowanceId, operationId, payload, amount, work|synthesis): boolean
dispatched(operationId), settle(operationId, observedUsage, metadata?)
snapshot(allowanceId), waitForHost(hostname, delayMs, signal), close()
```

`AuthorizedRequest` includes ID, allowance/investigation/session identity, expected logical revision, kind (`start|continue|report`), question, provider, search tool and storage root. IDs bind immutable payloads. Reservations and claims are atomic across runtimes; unknown outcomes remain reserved, and repeated IDs never redispatch. Explicit user-confirmed recovery can revoke an old writer without freeing uncertain spending. Synthesis has a separate protected lane. Model token control is estimated; confirmed usage and unresolved exposure are distinct.

### Engine (`engine.ts`)

```text
newInvestigation({id, allowanceId, storageRoot, question}): Investigation
ResearchEngine({state, ledger, store, host, requestId, owner, signal, options?})
run(input, start|continue|report): Promise<Investigation>
feedback(state, targetId, kind): Investigation
```

`EngineHost` and model task schemas are defined in `src/types.ts` and `src/pi-model.ts`. Acquisition saves immutable snapshots; engine should verify persistence before manifest publication. Every logical commit uses a cloned state/new revision ID and requires both current-generation guards and ledger ownership. Stale completions settle usage but never commit evidence.

## Commit discipline

Existing commits before the final handover commit:

- `3a12fc8` — complete implementation plan.
- `75f2289` — generated package/scaffold and pinned approved dependencies.
- `7c2ea25` — development documentation and evidence boundaries.
- `d636043` — shared research contracts, model/discovery adapters, report construction and text inspectors (TypeScript check passed; behavior unverified).

The handover commit preserves shared source modules and unfinished drafts while removing misleading runnable registration. Next session: start with `git status`, preserve anything added since this handover, then commit one coherent component at a time. Do not mix unrelated setup, multiple worker implementations and evaluation changes into a single final commit.
