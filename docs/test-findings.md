# Test findings: merged branch `integrate-rfs-riya`

Date: 2026-11-25. Code under test: `10a48ea` plus the uncommitted `modelObject` fix in `src/research-loop.ts` and its test.

## Scope and outcome

| Area | How it was tested | Outcome |
|---|---|---|
| Offline tests | `npm run typecheck`, `npm test`, `npm run demo` on Node 24 | All pass: 216 `ok` checks, 0 failures. Demo replay passes. |
| Offline use cases | About 50 cases. Both extensions were loaded through Pi's `ExtensionRunner` and handlers and tools were called directly with stub UI and model, so no model was called. | Everything passes except the items in *Discrepancies*. |
| `pi-web-access` 0.48.0 | Live `fetch_content` and `web_search` calls, plus a mocked Exa 429 | Result shapes match what `src/research.ts` reads. A 429 is recorded as a failure, not a crash. |
| Live runs (Gemini free tier) | 13 runs through Pi RPC with `-e .` (both extensions loaded) | Brief, search, fetch, ranking, inspection, assessment, `/research-finish`, the concurrency guard and the empty-question path all work live. **No run completed a report:** every report turn hit Gemini 503 or daily-quota 429. |
| Report audit | Every claim in `submission/CSD358-project-report.md` checked against the code, the tests and `evaluation/` | Judge validation numbers, all RACE scores, the arithmetic and the p-values check out. The method description is out of date since the merge, and some sections cannot be verified from the repo. |

## Bug found live and fixed (uncommitted)

**`modelObject()` failed when a model wrote prose after a fenced JSON block.**
- **Seen with:** `gemini-3-flash-preview` on the assessment turn.
- **Effect:** the run stopped after round 1 with `Unexpected non-whitespace character after JSON`.
- **Fix:** parse the first fenced block when one is present (`src/research-loop.ts`).
- **Test:** two new checks in `test/research-library.test.ts`. They fail on the old code and pass on the fix.

## Discrepancies: code and behaviour

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | Rate-limited searches are never retried. `markSearched` runs before the search, so a 429'd query never comes back. If the model proposes nothing new, the stop reason reads "No new search queries were proposed…" (misleading), and the report may be written from an empty library. | `src/research.ts:133-136`, `src/research-loop.ts` `assess` | High under Exa free tier |
| 2 | A failed report turn cannot be retried. After a successful research phase, a model error on the report turn ends with "No completed report. Evidence saved"; nothing re-runs synthesis from the saved evidence. | `src/research.ts` `finish` | Medium |
| 3 | `renderReport` leaves multi-ID citations such as `[P1, P2]`, `[P1,I1]` and `[p1]` as raw text. They are neither linked nor flagged as unresolved. The writer prompt asks for one ID per bracket, so a model slip leaks silently. | `src/research-evidence.ts:17` | Medium |
| 4 | `modelObject` still fails on CRLF fences, one-line fences, and bare JSON after prose. In the brief stage that stops the run. | `src/research-loop.ts:41` | Low–medium |
| 5 | A failed `/research-engine` start (model error after confirmation) shows no error in RPC mode. The user only sees "No investigation on this branch" later. | `src/extension.ts` | Low |
| 6 | `/research-report` silently writes `<slug>_report_v<N>.md` and `report.md` into `process.cwd()` (not `ctx.cwd`) and swallows errors. This is undocumented, and `report.md` is overwritten each time. Found by reading the code; not triggered live. | `src/extension.ts:260, 336` | Low |
| 7 | `/research-stop` prints nothing without a UI, and with a UI it says "cancellation requested" even when nothing is running. | `src/extension.ts:366` | Low |
| 8 | `research_inspect` with blank `terms` silently becomes a plain 6,000-character read. | `src/research-loop.ts:127` | Low |
| 9 | `scripts/evaluate-browsecomp-plus.ts` has no usage message: `--help` throws "Unknown option", and no arguments gives ENOENT. `score-browsecomp-plus.py` needs `pytrec_eval`, which is not installed or documented. | `scripts/` | Low |

## Discrepancies: docs and stored results

| # | Finding | Where |
|---|---|---|
| 10 | The CISI stemming significance is overstated. A fresh run reproduces nDCG@10 0.3984 vs 0.3607, but at t = 2.12, p = 0.037. The docs say p < 0.001 (t = 3.82). The `.tex` correctly says p = 0.037. P@10 does reach p ≈ 0.0009. | `docs/ir-engine.md:108`, `docs/information-retrieval.md:107` |
| 11 | `evaluation/cisi-results.json` is stale. It holds 3 methods (bm25, lexicalPRF, prfMMR); the docs table and a fresh run have 6. | `evaluation/cisi-results.json` |
| 12 | Old command names (`/research`, `research_inspect` for the engine) remain in historical docs. | `docs/live-verification.md`, `docs/project-plan.md` |

## Discrepancies: `submission/CSD358-project-report.md`

| # | Report location | Finding | Category |
|---|---|---|---|
| R1 | §5 Ranking | "Cosine uses term-frequency vectors". Core-ir `mmr` uses L2-normalised TF-IDF vectors. | Wrong |
| R2 | §5 | The report does not say that `/research` now uses Porter-stemmed, stopword-filtered BM25 with query-term weighting, or 180–300-token `segment()` passages (previously about 900-character sentence packing). | Outdated by merge |
| R3 | §4 Fig. 1 and §5 | The Naive Bayes pre-fetch filter (round 2 onward, confidence > 0.6, logged as `filteredCandidates`) is not mentioned. | Outdated by merge |
| R4 | Whole `.md` | Only `/research` is described. The IR engine (`/research-engine` and its follow-up commands, Rocchio, QL/SDM, clustering, SQLite budgets) ships in the same package. The `.tex` describes it; the `.md` does not. | Outdated / `.md` vs `.tex` |
| R5 | §6.2 | The RACE scores 94.29 and 83.04 come from pre-merge `/research` runs (`pi-research-2026-11-22T18-12-59-663Z`). The merged retrieval has no RACE score. | Outdated by merge |
| R6 | §6.2, abstract | The `.md` reports tasks 19 and 20 only. The repo and `.tex` also have task 22 (81.98) and task 33 (93.78, below OpenAI's 96.04). | `.md` vs `.tex` |
| R7 | §6.2 l.115, l.122 | Tasks 12 and 17 are called "pending". The repo has diagnostic scores (75.32 and 90.21), both marked contaminated. | Outdated |
| R8 | §6.1 | The PMCR table (21/21/12 queries, 5,664/6,173/785 words, 109,282 characters, and so on) cannot be verified: those runs' `.md` and `.evidence.json` files are not in the repo. | Unverifiable |
| R9 | §6.3 | The BrowseComp-Plus table and the stemming p = 0.423 cannot be recomputed: no run or metric files are archived. The `.tex` cites `evaluation/browsecomp-plus/metrics.json`, which is absent. | Unverifiable |
| R10 | §6.3 | The "Lucene-style" row label omits that it is stemmed (k1 = 0.9, b = 0.4). Since stemming did not win the ablation, the report should present it as a design choice. | Minor |
| R11 | Header | Author order differs: `.md` has Riya, Abhyudaya, Ayan; `.tex` has Ayan, Riya, Abhyudaya. | Inconsistent |
| R12 | §1 | "Fixed Wikipedia corpus" for the mid-semester project. Wikipedia appears nowhere in the repo; the evaluation corpus is CISI. | Unverifiable, likely wrong |
| R13 | §6.2 | "drsh" is never defined. | Minor |

Verified correct: the BM25 formula and parameters, the MMR formula and λ = 0.7, the stable tie-break on candidate ranking, 5-shingle containment ≥ 0.8, concurrent search batches, readable-mode fetch, exact passage offsets, inspection zero-count semantics, `/research-finish` behaving as distinct from cancel, the judge validation (44/50, r = 0.462, centred r = 0.690, MAE 13.71 → about 10.72, recomputed from `evaluation/corpus/scores.jsonl`), every baseline RACE score, the 16.60, 3.96, 17.99 and 4.77 differences, and the p-values derived from the `.tex` t-statistics.

## Test coverage gaps

No repo test imports `src/research.ts` or `src/research-evidence.ts`. That leaves the following untested:
- **Commands:** `/research` and `/research-finish`.
- **Tools:** `research_round` and `research_inspect`.
- **Hooks:** `tool_call`, `context` and `agent_settled`.
- **`ResearchLoop`:** `plan` and `assess` validation and the stop reasons.
- **`EvidenceLibrary`:** dedup (arXiv IDs, canonical URLs, shingles, summary replacement) and the boilerplate filter.
- **Rendering:** citation resolution in `renderReport`.
- **External:** the `pi-web-access` result shapes.

All of these were exercised by ad-hoc harnesses in this pass, but they are not regression tests. The offline harnesses are in the session scratchpad (`usecases/`).

## Blocked by external limits: rerun when quota allows

Gemini free tier, at the time of testing:
- `gemini-3.6-flash`, `gemini-3.5-flash` and (later) `gemini-3-flash-preview`: out of daily quota.
- `gemini-3.5-flash-lite`, `3.7` and `3.8`: constant 503.

Run one at a time, after adding an Exa key in `~/.pi/agent/web-search.json`:

1. **Full `/research` to a saved report.** Check that citations resolve, and record word count and elapsed time.
2. **Broad multi-round question.** Check whether the Naive Bayes filter drops anything from round 2 on.
3. **`/research-finish`.** Check that it ends with a saved report.
4. **Full engine sequence.** `/research-engine` → `/research-map`, `/research-sources`, `/research-report`, `/research-continue`, `/research-stop`. The engine's setup asks for the provider and tool name as two text inputs, not selects.
5. **`/research` after an engine run in the same session.**
