# Deep Research in Pi — how it works

A companion to `docs/EVAL.md` (the measurements) and `docs/DECISIONS.md` (the trade-offs). This document
explains the shipped system end to end, in the order a run executes, and ends with the questions a viva
is likely to ask.

---

## 1. What it is

`/research <question>` turns a question into a cited report, in one Pi session, using only the models and
tools that are already installed. It is an information-retrieval system: the work is deciding *what to
fetch*, turning what was fetched into a ranked corpus of quotable passages, and then writing from that
corpus. The model never writes a sentence in the report stage that is not traceable to a passage.

Three properties define it:

1. **Corpus first.** Evidence is collected and stored before any prose exists. The report stage runs with
   **no tools at all**, so it cannot fetch, cannot re-search, and cannot invent a citation.
2. **Every claim resolves.** Report sentences cite passage ids; a renderer replaces each id with a link
   to a stored excerpt whose source URL, retrieval date and character offsets are recorded.
3. **Stopping is a decision, not a timeout.** A run ends because the evidence assessment says another
   round cannot change the answer, or because it hit a stated bound — and it says which.

---

## 2. The pipeline

```
/research <question>
      │
      ├── brief      → the model returns needs (one per named part of the question) + search queries
      ├── research   → repeat: plan URLs → search → fetch → segment → rank → inspect → assess
      │                   ├── research_round   (search + acquisition for one round)
      │                   ├── research_inspect (read a stored source, no network)
      │                   ├── research_add_urls(delegated pages become citable)
      │                   └── research_assess  (per-need judgment + continue/stop)
      └── report     → synthesis from the ranked packet only; no tools
                        └── renderReport() turns [P12]/[I3] into links + an Evidence section
```

The stages are driven by the extension in `src/research.ts`; the retrieval loop is `src/research-loop.ts`;
the index is `src/research-library.ts`; rendering is `src/research-evidence.ts`.

### 2.1 Brief (`briefPrompt`, `src/research.ts:186`)

The model produces a list of needs. The prompt asks for one need per component or dimension the question
names, because merging them is what makes a run stop early with a thin corpus: on task 85 the merged plan
produced five needs, two rounds, and 8–18 sources, while other tasks collected 24–54.

### 2.2 Research round

Each round is one `research_round` call, which internally:

1. `selectUrls()` picks candidates from the model's queries — at most **2 per query** (`PER_QUERY`) and at
   most **20 per round** (`PER_ROUND`). Both caps were measured: two per query roughly doubled the source
   ceiling on a broad query; the per-round cap cut a task from 1381 s to 298 s with no change in its
   judged median.
2. Searches run through `pi-web-access`, in batches with a 90 s wait per batch.
3. Fetching goes through a ladder (§3).
4. Every page is segmented into passages (§4) and stored.
5. The model inspects stored text (`research_inspect`, 8 per round) and then judges each need, now by
   calling **`research_assess`** with a schema-validated payload.

### 2.3 Where the caps live

| constant | value | effect |
|---|---|---|
| `MAX_ROUNDS` | 10 | hard stop, reason `Reached the 10-round limit` |
| `PER_QUERY` | 2 | ceiling on one query dominating a round |
| `PER_ROUND` | 20 | wall-clock control on fetch volume |
| `PER_SOURCE_LIMIT` | 4 | passages per source in the report packet |
| `PASSAGES_PER_SUBQUESTION` | 12 | packet width per need |
| `INSPECTIONS_PER_ROUND` | 8 | inspections are full model turns |
| `DOCUMENTS_PER_ROUND` | 2 | each parse costs seconds |
| `MAX_QUOTE_CHARS` | 700 | an excerpt quotes, never reprints |

### 2.4 Report

`reportPrompt` hands over the packet — needs with their ranked passages, plus inspections — and forbids
tools. The model writes prose citing `[P12]`/`[I3]`. `renderReport()` then:

- maps each id to a numbered evidence record (`[3](#evidence-3)`, `<a id="evidence-3">`),
- writes the source, URL, retrieval date, character offsets and the quoted excerpt (≤700 chars),
- leaves `[unresolved citation]` where an id does not exist, so a hallucinated id is visible rather than
  silently plausible.

---

## 3. Acquisition: the three-rung ladder

Not every URL is fetchable by a plain GET. The ladder tries in order and records which rung answered:

1. **Direct fetch** (`fetch_content` from `pi-web-access`) with a headed user agent — dropping
   `HeadlessChrome` and refusing pages under 500 characters removed most bot walls.
2. **Public archive** — a Wayback snapshot, up to 6 per round (`ARCHIVE_FALLBACK_LIMIT`), stored under the
   original URL marked `(archived copy)`.
3. **Headless browser** (`src/research-browser.ts`, optional `playwright-core`) for pages that still
   refuse; opt-in with `PI_RESEARCH_BROWSER=1`.

Guards that apply to every rung (`src/research.ts` `rejectUnsafe`, `src/research-acquisition.ts`):

- **SSRF**: `checkPublicTarget()` resolves the host and rejects private, loopback, link-local and
  metadata addresses, before and after redirects.
- **Failures are labelled**: `classifyFetchFailure()` separates `blocked` from `download failed: HTTP 403`
  from `parser produced no text`. A wall is not an absence of evidence, and the journal keeps the reason.
- **Documents**: `parseDocument()` downloads bytes and hands `document_parse` a file with the right
  suffix, so scans go through OCR; if the direct GET is refused it falls back to the fetch tool, because
  a page of extracted text beats losing the source.

---

## 4. Retrieval: how passages are built and ranked

`src/research-library.ts`:

- **Segmentation**: text is split to ~900 characters (`PASSAGE_TARGET_CHARS`) on paragraph boundaries,
  dropping fragments under 8 words (`MIN_PASSAGE_WORDS`).
- **Deduplication**: 5-word shingles (`SHINGLE_SIZE`) remove near-duplicate passages across sources, so
  ten copies of one press release are one piece of evidence.
- **Scoring**: BM25 with positional information, plus a second index over Porter-stemmed terms
  (`src/porter.ts`, a hand-written Porter implementation). Stemming helps recall on morphological
  variants; the unstemmed stream preserves exact strings for quoting.
- **Selection**: max-passage aggregation scores a document by its best passage, then MMR
  (`MMR_LAMBDA`) trades relevance against redundancy so a packet is not four paragraphs of one article.
- **Packet**: 12 passages per need, 4 per source, with a floor of 2 passages and 2 sources per need.

Measured on the corpora three real runs collected (tasks 77/85/88, hand-labelled relevance):
**nDCG@10 0.428, MAP 0.576, R-Precision 0.521, BPref 0.480.** This is the gate: any change to
segmentation, stemming, ranking, packet width or per-source caps must re-run `npm run eval:retrieval`
and beat or hold those numbers.

---

## 5. Control flow, and how a run can end

| event | what happens |
|---|---|
| model replies, agent settles | the stage handler advances: brief → research → report |
| no reply at all | retried twice, then `Stopped in the <stage> stage without a report (…)` |
| provider error | retried with backoff; 429s get 6 attempts, 20 s → 120 s |
| provider silent | opt-in stall retry re-sends the stage prompt (3 tries), then a named stop |
| stage timeout | **off by default**; `PI_RESEARCH_STAGE_TIMEOUT_MS` enables it |
| round limit | `Reached the 10-round limit; writing from the corpus collected.` |
| user `/research-finish` | synthesis from what exists, and the report says so |

Two guards matter for correctness:

- **Stage allowlist** (`pi.on("tool_call")`): the brief stage admits only `research_brief`, the research
  stage admits round/inspect/add_urls/assess plus delegation, and the **report stage admits nothing**.
  A model cannot fetch while writing.
- **Retired turn**: the turn that just ended cannot collect or write evidence
  (`Research has finished; this turn cannot collect or write evidence.`). A later, ordinary user turn is
  free again — deliberately, since blocking a session forever would be wrong.

---

## 6. Delegation

When the question names three or more distinct approaches, the research stage may spawn `subagent`
("Explore") agents in the foreground and harvest the URLs they report through `research_add_urls`, so
delegated work becomes citable passages instead of prose. Delegated prose is never evidence: a subagent
cannot write to the library, and only fetched pages count. Delegation is disabled with
`PI_RESEARCH_NO_DELEGATION=1`, which is how the on/off comparison in `docs/EVAL.md` was run.

A measured caveat: the subagent tool is provided by `@gotgenes/pi-subagents`, loaded into the child
research session, not by the Pi binary — a parent session's `/tools` listing does not show it.

---

## 7. What the user sees

- **In run**: `Research · N sources · 4m12s` above a live activity line (`▸ Searching queries 1–9 of 21`,
  `▸ Reading sources 3–8 of 14`, `✓ Round 1 · 21 queries · 16 new · 73 passages · 4 failed`).
- **On finish**: `Report saved (2 rounds · 51 sources · 115 passages · 389s): <path>` and the citation
  resolution count.
- **After**: `/research-view` pages the journal — question, status, rounds with their queries, failures,
  assessments, delegations — inside the session, so the run stays auditable without leaving Pi.

The journal (`*.journal.json`) is the audit trail: every round, its queries, what each fetch did, the
per-need judgment, and the stop reason.

---

## 8. How it is evaluated

**Quality (online).** Eight DeepResearch Bench tasks, judged with the official RACE prompt by
`deepseek-v4.1-flash`, three calls per report, medians compared against the four shipped baselines
re-judged with the same judge. Result: mean **90.78** vs **87.76** (+3.02), six of eight bars met; task 88
−1.9 and task 85 −4.9.

**Retrieval (offline).** The gate metrics above, computed by `scripts/retrieval-eval.ts` over the corpora
runs actually collected, with labels, MAP, R-Precision, BPref and nDCG@10.

**Grounding (mechanical).** `npm run eval:citations` audits every report: links must equal anchors, no
dangling link, no unused anchor, no unresolved id, and uncited sentences are counted and split into
claims (carrying a figure or an attribution) versus reasoning over cited figures. All 28 reports produced
this session pass with zero unresolved ids.

**Environment.** Everything above was measured in a container built from `/tmp/eval/Dockerfile`
(node 22, tmux, pi 1.6.0, chromium), package mounted read-only at `/pkg`, `/agent` holding only
`auth.json`, `models.json` and a `settings.json` that declares no packages, session started as
`pi -ne -e /pkg`. That is what makes "pristine" checkable: a capability claim is only meaningful if the
tool was really there, which is why the tool inventory is captured per cycle.

---

## 9. Findings worth telling in a viva

1. **The silent stops were a parse failure, not the provider.** Three runs ended with no report and a
   journal blaming silence. The session files showed complete assessment replies; 3 of 145 such replies
   (2.1%) carried a stray brace, `JSON.parse` threw `Extra data`, and the error escaped the stage handler
   — the run died with its corpus unused. Fixed twice over: tolerant parsing, and structured payloads as
   schema-validated tool arguments.
2. **A guard can silently disable a feature.** The first live run of the tool-argument change was refused
   by the stage allowlist, which still listed only the old tools; the run sat at "planning" collecting
   nothing. Only a live run showed it — the unit tests were green.
3. **Caps are a quality lever, not just a cost lever.** A per-round source cap made one task 4.6× faster
   with its judged median unchanged; unbounded rounds had made it fetch 146 pages for 115 passages.
4. **Delegation costs quality when unconditional.** Same build, same task: delegation on took 1521 s and
   scored 88.75; off took 641 s and scored 84.03 — so it buys quality where the question is broad, but
   the prompt must decide whether to use it, and three subagent calls returned zero results.
5. **Judge noise is large.** Within a run the spread is 1–2 points; across runs of the same task it reached
   7. Single-run comparisons below ~4 points are not evidence, which is why the replicate runs exist and
   why task 85 (−4.9 over five runs) is reported as a shortfall rather than folded into noise.

---

## 10. Limits

- Task 85: brief produces too few needs for compound questions; the fix (one need per named part) moved it
  from 83.39 to 86.17 median but not to its 91.1 bar.
- Task 88: stable at 92.40 against a 94.3 bar; nothing tried so far moved it.
- BrowseComp-Plus offline numbers come from the earlier build's harness: the corpus is on disk
  (`/var/tmp/bcp`, 100,195 documents verified) but its queries and qrels are canary-encrypted and the old
  harness was never committed, so re-scoring the shipped engine there is unfinished work.
- Screenshots exist for cycles 5 and 14; cycles 6–13 were checked live but not captured.
- Fetch failures are recorded and reported, but a blocked page is still missing evidence; the archive and
  browser rungs recover some, not all.

---

## 11. Questions a viva will ask

**"How do you know the report didn't make something up?"**
It cannot fetch while writing — the report stage admits no tools — and every `[P..]`/`[I..]` is resolved by
`renderReport()` against stored passages; ids that do not exist render as `[unresolved citation]`. The
audit script checks links == anchors with zero dangling/unused/unresolved, and counts uncited sentences.
Entailment is not proven by that: a passage can be cited for a claim it does not support. That is stated
as a limitation, not hidden.

**"Is it actually better than the shipped deep researchers?"**
On eight tasks, median 90.78 against 87.76 for the best baseline re-judged with the same judge: six bars
met, two missed (88 by 1.9, 85 by 4.9). Better on average, not uniformly better.

**"Why passages rather than documents?"**
Passage segmentation with max-passage aggregation more than doubled whole-document BM25 on
BrowseComp-Plus (Evidence nDCG@10 3.70 → 8.47, R@100 9.50 → 21.32) with the same parameters, and it is
what makes a 700-character quotable citation possible.

**"What stops an infinite run?"**
The assessment, the 10-round bound, the optional stage timeout, and the stall retry. The original infinite
loop was diagnosed as query regeneration without a round bound; the bound ends the run and says so.

**"How much does it cost and how long does it take?"**
A run is 5–8 minutes at the median, tens of cents of `deepseek-v4.1-flash`; a three-task parallel cycle
finishes well inside an hour. The tail was 31 minutes before the per-round cap and is now ~20 at worst.

**"What would you do with more time?"**
Give task 85 a better need decomposition (it is the one clear quality gap), finish the BrowseComp-Plus
port so the offline table is the shipped engine's own, and add entailment checking on top of the
mechanical citation audit.

---

## 12. File map

| file | role |
|---|---|
| `src/research.ts` | command, stages, tool registration, guards, prompts (1294 lines) |
| `src/research-loop.ts` | needs, query selection, assessment, round bounds (294) |
| `src/research-library.ts` | sources → passages, BM25 + MMR, packet (280) |
| `src/research-acquisition.ts` | fetching, SSRF guard, failure classification (1018) |
| `src/research-host.ts` | spawns the child research session with its extensions (219) |
| `src/source-credibility.ts` | offline CRED-1 prior and host tiers (151) |
| `src/porter.ts` | Porter stemmer (156) |
| `src/research-browser.ts` | optional headless-browser rung (99) |
| `src/research-evidence.ts` | citation rendering and the Evidence section (45) |
| `scripts/retrieval-eval.ts` | retrieval gate (nDCG@10 / MAP / R-Prec / BPref) |
| `scripts/citation-audit.ts` | per-report citation and uncited-claim audit |
| `scripts/demo.sh` | builds, starts and opens a demo container |
| `docs/EVAL.md` | every cycle: command, commit, change, wall clock, medians, retrieval, citations |
| `docs/DECISIONS.md` | each trade-off and what was rejected |
