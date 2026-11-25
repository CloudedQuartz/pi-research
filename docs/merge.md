# How `research-from-scratch` and `riya` were merged

Branch: `integrate-rfs-riya` (merge commit `10a48ea`, local only, not pushed).

## Starting point

| Branch | Tip | Commits | What it is |
|---|---|---|---|
| `research-from-scratch` | `f81df41` | 5 (Ayan) | The one-command `/research` workflow, the DeepResearch Bench (RACE) judge harness in `evaluation/`, and the IEEE report in `submission/`. |
| `riya` | `265a8eb` | 22 (Riya), plus the shared earlier history | The IR engine: `src/core-ir.ts` (segmentation, positional and stemmed BM25, QL, SDM, MMR, Rocchio, Naive Bayes, k-means clustering), the budgeted multi-turn engine (`engine.ts`, `controller.ts`, `extension.ts`), CISI and BrowseComp-Plus evaluation scripts, and tests. |

The two branches share no history: `research-from-scratch` starts from an orphan commit. The merge uses `git merge --allow-unrelated-histories`, so every commit from both branches is kept with its original author and date.

Before the merge, `/research` copied only two functions from `riya` (`normalizeUrl` and `shouldSkipCandidateUrl`). It ranked passages with its own unstemmed BM25, even though the final report describes stemmed BM25 and Naive Bayes filtering. Both extensions also registered the `/research` command and the `research_inspect` tool, so they could not load together.

## Base and layering

- **Base:** `research-from-scratch`. Its `/research` is still the main workflow, and its prompts, stages, evidence file, and report rendering are unchanged.
- **On top:** `riya`. Its IR core now powers `/research`'s retrieval, and its full engine ships in the same package under its own commands.

## What `/research` now uses from the IR core

| Step | Before (`research-from-scratch`) | Now |
|---|---|---|
| Passage splitting | Sentence packing to about 900 characters | `segment()` from `core-ir.ts`: paragraph-aware, 180–300 tokens, exact offsets. Boilerplate passages are still dropped. |
| Passage ranking | In-file unstemmed BM25 | `PassageIndex.rankStemmed`: positional BM25 (k1 = 1.2, b = 0.75) on the Porter-stemmed stream |
| Diversification | In-file MMR (λ = 0.7) | `mmr()` from `core-ir.ts` (λ = 0.7), then at most two passages per source |
| Candidate filtering before fetch | Lexical title/snippet overlap and route filter | The same, plus a `NaiveBayesCandidateClassifier` (see below) |
| URL normalization and route filter | A copy in `research-acquisition.ts` | `acquisition.ts`. The copy was byte-identical and has been deleted. |

Citation IDs and offsets work as before. A passage ID is still `<sourceId>#<start>`, and `source.text.slice(start, end)` reproduces the passage text exactly.

### Naive Bayes candidate filter

- **On-topic examples:** the planned research needs and their queries, plus passages the assessor cited for needs it judged answered.
- **Off-topic examples:** sources that were read but contributed no ranked passage to any need.
- **When it applies:** it filters nothing until both classes have examples, so the first round is never filtered.
- **Rule:** a candidate is dropped only when it is predicted off-topic with confidence above 0.6, the same threshold as the engine's controller.
- **Record:** dropped candidates are saved under `filteredCandidates` in `.evidence.json`.
- **Known limit:** "contributed no passage this round" is a heuristic label. A source that is off-topic now can turn relevant for a later need.

## One package, two extensions

`package.json` registers both extensions:

```json
"pi": { "extensions": ["./src/research.ts", "./src/extension.ts"] }
```

| Extension | Commands | Tools |
|---|---|---|
| `src/research.ts` (one-command deep research) | `/research`, `/research-finish` | `research_round`, `research_inspect` |
| `src/extension.ts` (IR engine) | `/research-engine` (renamed from `/research`), `/research-continue`, `/research-map`, `/research-sources`, `/research-report`, `/research-feedback`, `/research-budget`, `/research-stop` | `research_run`, `research_feedback`, `research_fetch_source`, `research_retrieve`, `research_engine_inspect` (renamed from `research_inspect`), `research_report` |

Only the two names that collided were renamed. The engine's other commands keep the names the report cites. The extensions use different UI keys (`research` vs `pi-research`), and their event hooks act only while their own run is active.

Loading:

```bash
pi -e .                 # both extensions
pi -e src/research.ts   # /research only
```

## File-level resolution

| File | Resolution |
|---|---|
| `src/research-library.ts` | Uses `segment`, `PassageIndex.rankStemmed`, and `mmr` from `core-ir.ts`. Its own BM25 and cosine code is removed. |
| `src/research-loop.ts` | Imports URL utilities from `acquisition.ts` and adds the Naive Bayes filter and its training. |
| `src/research.ts` | Writes `filteredCandidates` to the evidence file. Otherwise unchanged. |
| `src/research-acquisition.ts` | Deleted, because it was a duplicate of `acquisition.ts`. |
| `src/extension.ts` | Two renames: `/research` → `/research-engine` and `research_inspect` → `research_engine_inspect`. |
| `src/pi-model.ts` | Pi 1.6.0 reports some `usage.cost` fields as non-numbers. Those are now skipped instead of failing the type check. |
| `package.json` | `riya`'s scripts and dev dependencies, Pi SDK 1.0.4 → 1.6.0 (needed by `research.ts`), both extensions registered, and the new test added to `test:ir`. |
| `package-lock.json` | Regenerated. |
| `.gitignore` | Union of both branches. |
| `README.md` | `research-from-scratch`'s README, updated for the IR-core retrieval and the two-extension package. |
| `docs/ir-engine.md` | `riya`'s former README, with `/research` → `/research-engine` and links fixed for the new location. |
| `evaluation/`, `submission/`, `scripts/`, other `docs/` | Kept from both branches. No paths collided. |

## Verification

All checks below ran offline on Node 24:

- `npm ci`, `npm run typecheck`, and `npm test` pass: 214 checks, 0 failures.
- `test/research-library.test.ts` (new) covers:
  - stemmed retrieval of an inflected query;
  - exact span reproduction for every passage;
  - the per-source cap;
  - no hits for an unrelated query;
  - no filtering in the first round;
  - Naive Bayes keeping an on-topic candidate and dropping an off-topic one.

  Disabling the filter makes the last check fail, which confirms the test detects it.
- `test/sdk-load.test.ts` (updated) loads the package and asserts that both extensions load, that no command or tool name is registered twice, and that `/research`, `/research-finish`, and `/research-engine` all exist.
- The real `pi` CLI (`get_commands` over RPC) registers each command exactly once with `-e .` and with `-e src/research.ts`.

## Open items

- **Live run:** a full `/research` run has not completed on the merged code. Earlier attempts hit Gemini (503, then 429 quota) and Exa (429) rate limits. Rerun after adding an Exa key in `~/.pi/agent/web-search.json`.
- **Report numbers:** the RACE scores in the report (94.29 and 83.04) were measured with the old `/research` retrieval. Passages are now larger and ranked by stemmed BM25, so those runs must be repeated before the scores describe this code.
- **Remote:** `origin/merge-rfs-riya` still holds the earlier merge, which put the two extensions side by side and missed four `research-from-scratch` commits. Publishing this branch means pushing it under a new name or force-pushing over that branch.
