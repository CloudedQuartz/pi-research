# Decisions carried over from the earlier IR branch

The project has two lineages. The earlier one (`origin/riya`, 23 commits) grew a
full IR core: its own index, rankers, clustering, classifier and metrics. This tree
came at the same problem from the other end - evidence collection first, with a
BM25 + MMR library and a citation-first report - so the two overlap where the
question is the same and diverge where the architecture is different.

This note records what crossed over and what did not, so that the divergence is a
decision on the record rather than an accident of history.

## Adopted

| Item | From | Why | Test |
|---|---|---|---|
| Porter stemmer | `src/core-ir.ts` (`stem`) | This tree matched only literal inflections. Both sides of a BM25 match are stemmed now, so `leak` finds `leaks`/`leaking`. 151 lines, no dependencies. | `test/porter.test.ts` — variants collapse, numbers/IDs survive, inflected and uninflected queries rank identically |

## Already present

The acquisition hardening in `origin/riya:src/acquisition.ts` was adapted earlier
(this tree's `src/research-acquisition.ts` credits `3cdb94b`), and it is present -
but mostly **not wired**. Only `normalizeUrl` and `shouldSkipCandidateUrl` are
imported (by `research-loop.ts`). `isBotChallenge`, `parseHtmlMetadata` (JSON-LD
dates, canonical URLs), `isThinContent` and the whole `AcquisitionService` are dead
code: page reads go through `pi-web-access`'s `fetch_content`, not this module
(`src/research.ts` calls `ctx.executeTool(FETCH_TOOL, ...)`). The module also
contains no robots logic, so robots enforcement is not happening anywhere in this
pipeline. Recorded rather than deleted: it is 39 KB of prior work that a future
change could wire up deliberately.

## Not adopted, and why

| Item | Reason |
|---|---|
| `PassageIndex.rank` / `rankStemmed` with phrase bonuses | Superseded: this tree has its own BM25 + MMR in `EvidenceLibrary`. Porting the index would duplicate scoring. Its stemmed path also scored an exact-phrase bonus across a removed stopword ("alpha the beta" matched "alpha beta" exactly), which the current text-matching contract forbids. |
| `rankQL` (Dirichlet), `rankSDM` (MRF) | No consumer and no relevance judgments in this tree to choose between rankers; the SDM `phraseBonus` could go negative (observed `-0.001`), so it is not a safe drop-in. |
| `mmr` | Already implemented here. |
| `concepts`, `keyTerms`, `expandedQuery`, `rocchioQuery` | Query expansion without judgments. The loop already expands through the assessment's gap queries, which are evidence-driven; adding PRF on top changes queries with no way to measure the effect. |
| `clusterPassages` (spherical k-means, facet labels) | No consumer: the UI shows rounds and needs, and the report cites passages. Clusters would add work per round and change no citation. It also turns `k = 1` into `2`, and its seeding is farthest-first rather than the k-means++ the old docs claimed. |
| `NaiveBayesCandidateClassifier` | Needs labelled on/off-topic examples. With no feedback labels it fails open (`predict` returns on-topic, confidence 0), so it prunes nothing; the cheap wins are already covered by `shouldSkipCandidateUrl`. |
| IR metrics (MAP, R-Precision, BPref, 11-point PR, paired t-test) | The evaluation here is a point-wise judge over DeepResearch Bench tasks; there are no pooled qrels in this tree to compute them against. Porting metrics without judgments would produce numbers that look comparable and are not. |
| BrowseComp-Plus harness (`evaluate-browsecomp-plus.ts`, dataset prep, scorer) | The corpus and qrels are not bundled (multi-GB download), so it cannot run in this environment; running it partially would report an unrepresentative subset. |

## Consequence

Stemming is the one retrieval change that crossed over. The rest either duplicates
what is here, cannot be measured without relevance judgments, or carries a defect
recorded above. None of it is lost: the branch still has it, and the reasons it
stayed there are written down.
