# Pi Research: Progressive Deep Research

## Assignment grounding and planning status

Course: **CSD358 — Information Retrieval**. Selected track: **T2 — Conversational and Agentic Search**.

This is an implementation plan, not a claim that the proposed system already exists. Numeric algorithm settings are development defaults to evaluate, not proven optimal values or assignment requirements.

The authoritative brief was found and read at:

`/mnt/c/Users/ayanp/Downloads/CSD358 IR Mid-term Assignment 2026.pdf`

Relevant requirements:

- **T2:** multi-turn search that retains context and rewrites or decomposes requests before retrieval (page 3).
- **Rubric:** IR principles 30, working system 20, evaluation 15, novelty 10, report 10, video 10, track relevance 5 (pages 7–8).
- **Deliverables:** reproducible repository, **5–8 minute live demonstration video without slides**, and **report of at most eight pages**, excluding references and appendix (pages 5–6).
- The video must expose actual code or intermediate IR output, evaluation, and at least one limitation. Every team member explains their component (page 6).
- Libraries, pretrained models, and AI assistance are allowed with disclosure. Direct copying of an existing project is prohibited (pages 7–8).
- Crawling must respect `robots.txt`, use per-host delays, and avoid collecting personal data (page 7).
- There is no minimum number of IR concepts. The corpus must be large enough that ranking matters, or its small size must be justified (pages 2 and 8).
- The brief specifies a **36-hour submission window**, but the announcement time, absolute deadline, and submission form link were not found (pages 1 and 8).

This plan retains the complete requested system. Its milestones establish dependency order, not a reduced hackathon scope. The submission window remains an actual course constraint to confirm and respect.

Source inspections checked **Pi 1.0.4**, the installed **`pi-web-access` 0.37.0**, and existing Pi research extensions. These were delegated, read-only, source-level investigations, not an end-to-end integration test. The controller and persistence design received bounded independent design review.

## 1. Refined pitch and concrete distinction

> Pi Research is a conversational research agent whose investigation changes because of what it retrieves. It builds a reusable passage corpus, discovers vocabulary and unanswered questions within that corpus, and exposes why each subsequent retrieval action is worthwhile.

The central artifact is an evolving, inspectable **research map**, not merely a final answer.

Its defining trace is:

```text
Source passage
  → candidate concept
  → expansion term or genuinely new question
  → prioritized retrieval action
  → additional evidence
  → revised report
```

Every connection is recorded.

### Difference from the supplied reference

The supplied reference uses MTRAG ClapNQ, a positional inverted index, BM25, LLM rewrites, rewrite fusion, a gate, Boolean queries, and optional dense retrieval/PPR reranking.

| Supplied reference | Pi Research |
|---|---|
| Retrieval over an existing conversational corpus | Acquisition and indexing of a growing web-source corpus |
| Query rewrites and fusion improve retrieval | Retrieved evidence changes the investigation itself |
| Primarily chooses how to retrieve an answer | Chooses whether to reuse evidence, read an unread source, search externally, or stop |
| Conversation influences the next query | Conversation revises objectives, branch priorities, evidence selection, and reports |
| Retrieval internals are the principal demonstration | Retrieval internals **and the consequences of retrieval** are demonstrated |

BM25 alone is not the novelty. Neither is adding a research map to a conventional agent. The distinction is the **operational connection between passage-level evidence, research expansion, and resource allocation**.

This remains general-purpose deep research: explanations, comparisons, technical investigations, policy questions, and practical recommendations—not a claim-verification workflow disguised as research.

## 2. Recommended architecture

Build **one TypeScript extension with a host-independent research engine**.

```text
Pi commands and conversation
            │
            ▼
 research_run orchestrator
            │
   Objective and facet planner
            │
            ▼
 Deterministic research controller
    ├── retrieve existing passages
    ├── fetch discovered source
    ├── perform discovery episode
    └── stop and report gaps
            │
            ▼
 Policy-controlled fetch → extraction → passage index
                                      │
                         BM25 → MMR → evidence
                                      │
                         concepts / answer needs
                                      │
                             research-map updates
                                      │
                         cited, versioned report
```

### Component responsibilities

| Component | Owns |
|---|---|
| **Pi adapter** | Commands, tool registration, model access, progress rendering, lifecycle events |
| **Objective manager** | Standalone requests, constraints, facet revisions, user feedback |
| **Discovery adapter** | Calling the existing web-search tool and normalizing its structured results |
| **Acquisition service** | Robots policy, host scheduling, redirects, fetching, extraction failures |
| **Passage store and index** | Immutable source snapshots, segmentation, positions, statistics, BM25 |
| **Evidence selector** | Relevance explanations, duplicate handling, diversification |
| **Expansion engine** | TF-IDF candidates, provenance, feedback, anchored expansion |
| **Research controller** | Action eligibility, priorities, yield accounting, budgets, stopping |
| **Report builder** | Evidence packets, citation validation, report revisions and differences |
| **Persistence layer** | Branch-sensitive state and separate, non-rewinding operational accounting |

**The LLM proposes and interprets; code controls execution.** The model must not supply authoritative budget counters, retrieval scores, source counts, or progress percentages.

### Discovery: reuse the installed web tool

The installed package is named **`pi-web-access`**, although the requested integration is described as `pi-web-search`.

Inside `research_run`, call the registered search tool through:

```ts
const outcome = await ctx.executeTool(searchToolName, {
  query,
  provider,
  numResults: 8,
  workflow: "none",
  includeContent: false,
}, { signal });
```

Check `outcome.isError`, then validate `outcome.result.structuredContent`.

The inspected structured result includes:

```text
responseId
queries[]
  query
  answer
  provider/providers
  results[]: title, url, snippet
  error
```

Use **one query and one explicitly selected provider per invocation**. Avoid `provider: "all"`, automatic summary workflows, and background content fetching.

Provider semantics matter:

- **Brave:** the adapter preserves provider-returned result order. Record it as returned rank.
- **Gemini/OpenAI grounded answers:** sources may be extracted from answer citations. Their order is **not a search ranking**.
- Multi-provider aggregation concatenates and deduplicates; it does not establish a meaningful fused ranking.

Record `rankingKind: ranked | citation-list | unknown`. Never infer ranking from a numbered citation list.

**Search answers and snippets are discovery metadata only. They never enter the evidence index.**

Validate tool availability at startup: names are configurable, and web tools may require activation. Do not import private package internals.

The search adapter must immediately copy normalized discovery records into investigation-owned storage. The web package's cache has a one-hour TTL and is not the investigation's durable source of truth. `get_search_content` can recover stored search content while available, but should not become the primary structured integration or evidence store.

### Fetching: own the policy boundary, reuse extraction libraries

The existing fetch transport has redirect/SSRF safeguards, but its public interface exposes no robots-policy or per-host scheduling hooks. Therefore, use a small owned acquisition service:

- Public HTTP(S), no browser cookies or authenticated fetching.
- Robots checks and per-host queues.
- Policy revalidation at every redirect, including destination host and private-address restrictions.
- Descriptive user agent, bounded redirects, timeouts, response-size limits, MIME checks, and bounded retries.
- HTML extraction using **Readability with a DOM library**.
- Deterministic PDF text extraction using **`unpdf`**.
- Raw response and extracted text retained separately.

Apply scheduling and security policy to every acquisition request, including robots retrieval, redirects, and retries. Use a robots parser rather than inventing matching semantics. Test unavailable robots responses and fail conservatively where policy cannot be established.

A blocked page, scanned PDF without extractable text, or failed extraction becomes an explicit failure. **Never substitute an LLM-generated description for source evidence.**

### Lessons from existing Pi research extensions

The inspected projects provide useful patterns:

- [Lincoln504/pi-research](https://github.com/Lincoln504/pi-research): separation of engine and host, research rounds, persistent knowledge storage, progress UI.
- [timaliev/pi-deep-research](https://github.com/timaliev/pi-deep-research): code-owned state transitions, budgets, session persistence, and report artifacts.
- [czhiming-maker/pi-deep-research](https://github.com/czhiming-maker/pi-deep-research): checkpoint enforcement—but its model-supplied progress/confidence figures are a pattern to avoid.

Existing work already includes BM25-backed storage and deterministic budget controls. Claim novelty in **their evidence-driven coupling**, not their individual existence. Reuse libraries and architectural lessons, not another extension's implementation or prompts.

## 3. End-to-end behavior

### Initial investigation

```text
/research Why do ML models perform well offline but fail in production?
```

1. **Resolve the objective.** Produce an explicit question, scope, desired answer structure, and initial facets:
   - evaluation mismatch;
   - distribution changes;
   - data and pipeline problems;
   - deployment and monitoring.
2. **Create answer needs.** For example, the pipeline facet needs an explanation of failure mechanisms, observable symptoms, and mitigation approaches.
3. **Discover sources.** Issue bounded, facet-specific searches. Store returned URLs and discovery provenance.
4. **Acquire actual text.** Fetch eligible sources, preserve snapshots, segment passages, and update the index.
5. **Retrieve evidence.** Rank passages with BM25 and select a diverse evidence set.
6. **Discover concepts.** Suppose a relevant passage introduces *training-serving skew*. The candidate retains its passage ID and exact supporting span.
7. **Interpret the candidate.**
   - An alternate name for an existing concept becomes an alias.
   - A distinct issue becomes a proposed question: **“How do training and serving pipelines diverge, and how can that divergence be detected?”**
8. **Choose the next action.** The controller may retrieve cached evidence first, fetch an unread technical source, or search using the new concept.
9. **Produce a report.** Explain causes and relationships, provide practical implications, cite passages, and disclose unresolved areas.

### Conversational refinement

```text
/research-continue Focus on problems we can detect without labelled production data.
```

Resolve this into a visible standalone request:

> Within the offline-to-production performance problem, investigate detection methods that do not require labelled production outcomes; distinguish detectable symptoms from evidence of actual performance degradation.

Then:

- Preserve the original question and corpus.
- Create a new objective revision.
- Reprioritize pipeline consistency, feature/schema checks, missingness, and distribution monitoring.
- Deprioritize methods requiring production outcome labels.
- Retrieve from the existing corpus before acquiring anything new.
- Investigate genuine gaps, such as what drift signals cannot establish without labels.
- Publish a revised report with a **“what changed”** section.

Do not implement this constraint as `NOT label`: useful sources may discuss both labelled and unlabelled methods.

## 4. Research-state and provenance models

Use explicit records rather than a large mutable conversation summary.

| Record | Essential fields |
|---|---|
| **Investigation** | ID, original question, active objective, visible snapshot IDs, corpus revision, branch IDs, report versions |
| **ObjectiveRevision** | Original follow-up, standalone request, constraints, priorities, parent revision |
| **ResearchBranch** | Question, origin type, parent branch, introducing passages, concepts, answer needs, attempted queries, coverage, recent yield, status, next action and explanation |
| **SourceCandidate** | Requested URL, discovery query, provider, ranking kind/rank, title/snippet metadata, fetch status |
| **SourceSnapshot** | Requested/final/canonical URLs, fetch time, content hash, raw/text locations, MIME/status, extraction method/version, completeness and errors |
| **Passage** | Stable ID, snapshot ID, text, extracted-text offsets, section/page when available, token offsets, duplicate-group ID |
| **ConceptCandidate** | Term/phrase, introducing passage spans, TF-IDF components, classification, alias/branch decision and reason |
| **EvidenceContribution** | Objective, branch, answer need, passage/group, role—support/qualification/contradiction—and assessment |
| **ActionRecord** | Action type, inputs, prediction, explanation, reservation, observed result, yield, termination reason |
| **ReportVersion** | Objective and corpus revisions, structured sections, statements with passage references, superseded statements, unresolved gaps |

### Citation chain

```text
Report statement
 → passage ID
 → immutable extracted-text span
 → immutable source snapshot
 → original/final URL and retrieval time
```

Offsets refer to the stored extracted text—not guessed offsets in the original HTML. Page numbers appear only when extraction actually supplies them.

A changed page creates a new snapshot. It must not silently change what an old citation means. URL normalization must not merge materially different resources.

### Persistence and Pi branching

Use three storage responsibilities:

1. **Pi custom entries:** branch-sensitive objective, corpus membership, research-map and report references.
2. **Content-addressed files:** immutable source bodies, extracted text and passage artifacts.
3. **Small transactional allowance ledger:** irreversible reservations and observed usage; SQLite is suitable here, **not as the retrieval engine**.

Derive the storage location from the verified `ctx.sessionManager.getSessionDir()` API. Persist the investigation's storage reference.

Reconstruct logical state from **`getBranch()`**, not `getEntries()`. The latter includes abandoned histories.

Verified behavior:

- `getBranch()` returns the active path in chronological order.
- A normal copied-path fork includes custom entries.
- A new empty session with only a parent-session pointer does not inherit those entries.
- Compaction does not erase custom entries from the raw active path.

On resume, reload, or tree navigation:

- Restore the visible corpus and rebuild/load its derived index.
- Remain paused until the user continues.
- Never automatically repeat an uncertain external request.
- Reject late logical writes from an obsolete session/objective generation.

**Physical presence in the object store does not imply visibility in the current branch.**

Budget history must not rewind with the research map. Record stale request costs against their original allowance even when their evidence can no longer enter the active branch.

Persist blobs before committing manifest references. A crash between those steps leaves an invisible orphan, not a partially indexed source. Reconstructible indexes are caches; immutable snapshots and branch manifests are authoritative.

## 5. Explicit IR and controller rules

The following numeric settings are **initial development defaults**, not assignment requirements or proven optimal values.

### A. Passage construction and index maintenance

- Paragraph-aware passages targeting **180–300 tokens**, with limited contextual overlap.
- Preserve headings and source offsets.
- Keep positional surface tokens, including stopwords, for phrase checks.
- Use a separately normalized lexical stream for scoring.
- Start with English normalization; keep original text unchanged.

Maintain:

```text
term → passage postings {tf, positions}
passage lengths
document frequency
passage count N
total indexed token count
corpus revision
```

For each ingestion:

1. Detect exact duplicates.
2. Add accepted passages and postings.
3. Update `N`, total length and term document frequencies.
4. Increment the corpus revision.
5. Invalidate affected score, TF-IDF and feedback caches.

Compute IDF and average length from current statistics. Do not preserve stale BM25 scores as the corpus grows.

An essential invariant: **incremental indexing and rebuilding the same logical corpus must produce identical statistics and rankings.**

### B. BM25 with inspectable contributions

Use weighted BM25:

\[
S(q,p)=\sum_{t\in q} w_q(t)\,
\log\left(1+\frac{N-df(t)+0.5}{df(t)+0.5}\right)
\frac{tf(t,p)(k_1+1)}
{tf(t,p)+k_1(1-b+b|p|/\overline{|p|})}
\]

Start with \(k_1=1.2\), \(b=0.75\).

The inspector shows:

- query weights;
- term frequency and document frequency;
- IDF;
- passage-length normalization;
- each term's contribution;
- any phrase/proximity bonus.

Use a small positional bonus for exact or nearby occurrences of named concepts such as *training-serving skew*. Do not build a full Boolean query language merely to add another syllabus item.

### C. Duplicate suppression and diversification

- Exact source/text duplicates are indexed once, retaining URL aliases.
- Use token-shingle Jaccard similarity to identify near-duplicate groups.
- Keep near-duplicate variants available for inspection and retrieval.
- Suppress repeated groups in feedback and ordinary evidence selection.

Near-duplicate grouping is **not evidence equivalence**: a changed number or negation may matter.

Retrieve the top **30** BM25 candidates, then select approximately **8** using MMR:

\[
MMR(p)=\lambda\,rel(p)
 -(1-\lambda)\max_{s\in Selected}\cos(v_p,v_s)
\]

Use normalized BM25 relevance, TF-IDF passage vectors, and initial \(\lambda=0.75\).

Display source concentration as a warning, not as a confidence score. Neither more passages nor more domains establishes truth.

### D. Corpus-derived expansion and feedback

Select up to five feedback passages that:

- are relevant to the current facet;
- pass an anchor/context check;
- come from distinct duplicate groups, with source concentration controlled;
- have not been rejected by the user.

**Top-five rank alone is insufficient.** If none qualify, do not expand.

Extract unigram and two-to-four-token phrase candidates. Score them using weighted TF-IDF over the feedback passages, with phrase document frequencies obtained through positional matching.

Apply:

- boilerplate and navigation filters;
- discounts for already-used vocabulary;
- explicit negative-feedback penalties;
- positive-feedback preference;
- exact passage-span provenance.

Construct the expanded lexical query as:

\[
q' = 0.75\,norm(q_{\text{active facet}})
     +0.25\,norm(e_{\text{top candidates}})
\]

Use at most three added concepts initially. Keep query weights nonnegative; exclusions remain separate filters.

This gives the original/current facet at least **75% of lexical query mass**, limiting drift. Explicit user scope changes revise the anchor rather than being constrained by obsolete intent.

### E. Expansion versus a new branch

The LLM classifies promising candidates:

| Classification | Treatment |
|---|---|
| Synonym or alternate phrasing | Add alias/expansion term |
| Distinct, useful answer need | Propose child branch |
| Boilerplate | Reject |
| Irrelevant tangent | Reject |
| Unclear connection | Keep provisional; do not spend automatically |

A new branch requires:

1. A valid introducing passage span.
2. A demonstrated relationship to the active objective.
3. A distinct question not already answered or represented.
4. An explicit new or unmet answer need.

Prioritize eligible proposals with:

\[
B=0.45E+0.35A+0.20N
\]

where \(E\) is normalized expansion evidence, \(A\) is anchor relevance, and \(N\) is novelty relative to existing branches.

Semantic classification remains necessary: lexical novelty alone cannot distinguish an important subquestion from a tangent.

Initially admit at most two new branches per expansion cycle and eight active branches. Preserve additional proposals in a backlog. These are adjustable runtime controls.

One source can introduce a valuable concept. It does not make the concept's associated claims well-established.

### F. Coverage and observed yield

Give each branch explicit answer needs. Assess each as:

- open: `0`;
- partially addressed: `0.5`;
- adequately addressed with contextual evidence: `1`.

Coverage is the weighted mean, labelled **answer coverage**, never confidence.

Freeze the needs within a revision. Adding, merging or withdrawing needs creates a logged revision; the controller cannot improve coverage by silently deleting difficult requirements.

Maintain an evidence-contribution ledger keyed by:

```text
objective → branch → answer need → duplicate group → evidence role
```

An action has useful yield when it adds a previously uncounted contribution that:

- addresses an unmet need; or
- materially qualifies or contradicts an existing answer.

A repeated passage, renamed branch or paraphrased concept cannot earn yield again. Contradictory evidence can be valuable without increasing coverage. Adequately documented unresolved disagreement can be an addressed answer need, provided that status remains visible.

### G. Routing and utility before searching

Use a hierarchical controller with four choices:

| Action | Eligibility |
|---|---|
| **Local retrieval** | Query, objective, feedback or corpus revision changed |
| **Fetch candidate** | A relevant discovered URL remains unread and policy allows fetching |
| **Discovery episode** | A grounded, non-repeated query is available and acquisition budget remains |
| **Stop/pause** | No worthwhile eligible action remains, or a hard limit is reached |

A **discovery episode** consists of one web query followed by evaluation of up to three eligible new sources. Fetching remains separately checkpointed and budgeted, but the episode finishes before another discretionary episode begins. This makes search yield attributable.

Prioritize with:

\[
U(a,b)=
\frac{w_b\,D_b\,\hat p(a,b)\,N(a,b)}
{\widehat{cost}(a,b)}
\]

- \(w_b\): current user/facet priority.
- \(D_b\): unmet answer-need mass, including explicit unresolved issues.
- \(\hat p\): smoothed historical probability of a useful action of this type.
- \(N\): estimated novelty relative to previous queries and evidence.
- \(\widehat{cost}\): scheduling estimate including expected fetching and interpretation, with a positive floor.

Use action-type priors until branch-specific history exists. A simple initial estimator is Laplace smoothing, `(1 + successful actions) / (2 + completed actions)`. Calibrate cost estimates from development traces. This is a transparent heuristic—not a claim to know unseen evidence.

Count success once at the scheduling level: an episode's fetches cannot also manufacture independent episode successes. Local retrieval can succeed by finding previously unused evidence in an existing snapshot.

Metadata relevance and genuine returned rank can break fetch-priority ties. Citation order cannot.

Explore initially untested facets in priority order within the allowance. Facets that receive no attempt remain **unexplored**, not failed. Already-addressed branches receive no automatic exploration incentive unless a new need or conflict exists.

### H. Stopping and resource accounting

Maintain separate controls for:

- search-tool invocations;
- submitted query/provider combinations;
- page-fetch attempts;
- HTTP requests, including robots, redirects and retries;
- nested model calls and reported tokens;
- elapsed time;
- provider costs where actually exposed.

The inspected web package does not provide complete usage accounting. Hidden provider searches and unreported costs must remain **unknown**, not be reported as zero. Utility's estimated cost is a scheduling proxy; hard request, token, money and time constraints remain distinct.

Stopping rules:

1. Hard cancellation or exhausted allowance stops new discretionary work.
2. Two completed zero-yield discovery episodes put that branch's web searching into cooldown.
3. Cached retrieval and already-discovered sources may still be useful during cooldown.
4. New grounded evidence or an explicit scope change may reopen investigation.
5. Fetch failures, robots denials and interrupted episodes are **blocked/incomplete**, not evidence of saturation.
6. Stop when no eligible worthwhile action remains; report the actual reason and outstanding needs.

Reserve synthesis capacity. If unavailable, produce a deterministic evidence outline and gap list.

Persist reservations and request-ID bindings before dispatch. Repeated request IDs cannot dispatch twice; conflicting reuse is rejected. Resume and fork cannot replenish spent allowance. Continuing uses the remaining allowance unless the user explicitly authorizes additional allowance.

Unknown crash outcomes retain conservative reservations until reconciled and are not automatically retried. Report confirmed usage and unresolved exposure separately. Stale results still settle operational accounting even when they cannot be logically committed.

### Algorithms deliberately excluded from the core

- **RRF:** unnecessary without independent, meaningful ranked lists.
- **Dense retrieval/PPR:** not needed to establish the project's central contribution.
- **Broad Boolean parser:** unnecessary for the proposed user workflow.
- **LLM confidence gates:** not defensible as evidence quality measures.

## 6. Pi commands, tools and integration boundaries

### Commands

| Command | Behavior |
|---|---|
| `/research <question>` | Start an investigation with visible runtime limits |
| `/research-continue <follow-up>` | Revise the objective and continue using existing evidence |
| `/research-map` | Inspect branches, origins, coverage, yield and next actions |
| `/research-sources` | Inspect discovered, fetched, failed and duplicate sources |
| `/research-report` | Display or explicitly request an updated report |
| `/research-feedback` | Mark evidence useful/irrelevant or accept/reject/prioritize branches |
| `/research-budget` | Inspect allowances and explicitly authorize additions |
| `/research-stop` | Cancel further work while retaining committed results |

### Model-callable operations

- `research_run`: serial, model-only orchestrator.
- `research_retrieve`: ranked evidence and score explanations.
- `research_inspect`: passage, source, concept and decision provenance.
- `research_feedback`: validated feedback updates.
- `research_report`: report generation from a specified evidence revision.
- `research_fetch_source`: controlled acquisition for a validated pending action.

All mutation and acquisition paths use the same controller and accounting rules.

### Pi-specific boundaries

- Commands trigger the orchestrator with `pi.sendUserMessage`; they cannot call `ctx.executeTool` directly. Send a natural instruction carrying a validated request ID, not a recursive slash-command echo.
- Nested web calls use `ctx.executeTool`, preserving Pi's tool hooks. Tool failure is represented in the returned outcome and must be checked.
- Planning and synthesis use `ctx.modelRegistry.complete()` or `streamSimple()`, with structured validation and cancellation.
- Account for nested model usage explicitly; Pi already rolls up nested tool usage.
- Progress uses `onUpdate`, `setStatus` and `setWidget`.
- The interactive map/inspector uses `ctx.ui.custom()` only in TUI mode.
- RPC/print modes receive text and structured results instead.
- Restore from `session_start` and `session_tree`; invalidate active work at relevant session-switch, reload and shutdown boundaries. Maintain an owned generation guard because there is no public epoch API.

Do not spawn a replacement Pi agent, build another chat application, or change global web-tool configuration.

## 7. Dependency-ordered implementation plan

| Stage | Concrete deliverables | Acceptance gate |
|---|---|---|
| **1. Integration contract and scaffold** | Generated package scaffold; pinned versions; thin Pi extension; validated discovery adapter; model-call wrapper; fixture responses | Command triggers orchestrator; structured results survive nested execution; ranked and citation-list results remain distinct |
| **2. State and acquisition foundations** | Records, immutable storage, allowance transactions, lifecycle restoration, robots/host scheduler, HTML/PDF extraction | Resume/fork isolation; redirects and denied sources handled; raw and extracted content preserved |
| **3. Inspectable IR engine** | Tokenizer, passage segmenter, positional index, BM25, phrase checks, duplicate grouping, MMR | Hand-calculated score tests; incremental/rebuilt index equivalence; inspectable ranked results |
| **4. Complete initial-run pipeline** | Decomposition → discovery → acquisition → indexing → retrieval → cited report | A real question runs end to end; failed sources and unresolved facets remain visible |
| **5. Evidence-driven expansion/controller** | TF-IDF candidates, provenance, alias/branch classifier, action utility, episode yield, cooldown and stop rules | A source-introduced concept changes the next action; duplicate or irrelevant evidence does not manufacture progress |
| **6. Conversation and report revision** | Standalone follow-up resolver, revised priorities, corpus reuse, explicit feedback, report differences | Follow-up reuses relevant evidence, respects new constraints, acquires genuine gaps and removes obsolete recommendations |
| **7. Research map and evidence inspector** | Branch tree, score breakdown, concept lineage, source failures, budget/yield views | A viewer can explain why a passage ranked and why the next action was selected |
| **8. Robustness and evaluation** | Cancellation/crash tests, hostile-source tests, judged pools, baselines, ablations, resource traces | No stale commits or budget reset; reproducible metrics with documented limitations |
| **9. Submission package** | README, dependency/data credits, eight-page report, evaluation artifacts, live demo video, work division and AI declaration | Fresh setup reproduces the demonstrated workflow |

Develop tests alongside their components rather than deferring correctness work to Stage 8.

Suggested ownership for four members:

1. Index, ranking and retrieval evaluation.
2. Fetching, extraction, provenance and persistence.
3. Expansion, controller and conversation handling.
4. Pi integration, reporting, inspector and end-to-end evaluation.

For three members, merge the fourth role across the team.

## 8. Essential capabilities and worthwhile enhancements

### Essential for the finished project

- Full initial and follow-up research workflows.
- Actual-source acquisition with policy enforcement.
- Incremental positional BM25 and explanations.
- Anchored, passage-derived expansion.
- Provenance-backed branch creation.
- Adaptive routing, yield accounting and reliable stopping.
- Duplicate-aware diversified evidence.
- Explicit feedback.
- Session restoration and branch isolation.
- Versioned, passage-cited reports.
- Research map, inspector, baselines and evaluation.

### Enhancements after that system works

1. **Freshness-aware refresh:** selectively revisit stale evidence and compare snapshots.
2. **Scanned-PDF OCR:** clearly labelled extraction provenance.
3. **Improved structured-content extraction:** tables and technical documents.
4. **Multilingual normalization:** language-specific tokenization and evaluation.
5. **Dense retrieval experiment:** only if measured lexical misses justify it.

A separate frontend is not a priority. The brief explicitly says frontend choice is not graded.

## 9. Demonstration that exposes the contribution

Use the ML production-failure question and its unlabelled-data follow-up.

A useful terminal view would look like this—**illustrative layout, not fabricated results**:

```text
Objective v2: Detect problems without labelled production data

Pipeline mismatch
  Origin: initial facet
  Needs addressed: 2/3
  New concept: training-serving skew ← P17
  Next: retrieve cached passages
  Reason: objective changed; existing corpus not evaluated for v2

Distribution monitoring
  Origin: evidence from P31
  Unresolved: drift signal versus performance degradation
  Next: fetch unread source S12
  Reason: discovered source may address the missing limitation

Outcome-based evaluation
  Status: deprioritized by follow-up
  Existing evidence retained
```

### Seven-minute video sequence

1. **Problem and distinction:** explain what evidence-driven expansion means.
2. **Live initial request:** show decomposition and discovery.
3. **IR internals:** inspect postings and BM25 contributions for two competing passages.
4. **Expansion:** show an actual source phrase, its TF-IDF score and its branch decision.
5. **Controller:** show why it chooses cached retrieval, fetching or another search.
6. **Follow-up:** reveal the standalone request, evidence reuse and revised report.
7. **Limitation and evaluation:** show a real blocked/unsupported case and baseline results.

Also expose one rejection: a synonym merged instead of branching, boilerplate discarded, or a duplicate source contributing no additional yield.

Recorded fixtures support reproducible testing; they must not be presented as live web behavior.

## 10. Evaluation

Separate **retrieval quality**, **research policy quality**, and **conversation quality**.

### Dataset

Target approximately **10 multi-domain conversations**, each with an initial question and two follow-ups:

- two for development;
- eight held out after parameters are frozen.

Include explanations, comparisons, decision-oriented questions and investigations—not only ML topics.

Create human-judged passage pools from competing methods. Label relevance, redundancy, evidence role and usefulness to the active objective. Double-judge a subset and report disagreements.

### A. Retrieval quality

Evaluate all methods against the **same frozen source corpus**:

1. BM25 with the original/resolved query.
2. BM25 with anchored feedback expansion.
3. Full retrieval with diversification.

Measure:

- P@5/P@10;
- nDCG@10;
- recall relative to the judged pool;
- redundant-result rate;
- coverage of judged answer needs.

Call pooled recall **pooled recall**, not recall over the web.

### B. Research expansion and allocation

Compare:

- **Baseline:** initial facets, fixed round-robin acquisition, no evidence-created branches.
- **Full system:** passage-derived expansion and adaptive allocation.

Keep the search provider, extraction, underlying model, and resource caps matched. Report **actual consumption as well as caps**.

Measure:

- useful evidence contributions per fetch and per discovery episode;
- relevant new answer needs discovered;
- accepted-branch usefulness;
- synonym/tangent/boilerplate branch rate;
- repeated-query and duplicate-source waste;
- unresolved needs at stopping;
- latency and observed resource use.

Ablate separately:

- evidence-created branches;
- adaptive allocation;
- anchoring;
- diversification.

Run matched live trials close together and preserve their snapshots. Use replay primarily for regression tests; a cache lacking alternative queries is not a fair unrestricted-web benchmark.

### C. Conversation and reuse

Compare raw follow-up retrieval against resolved follow-up retrieval, and retained-corpus operation against restarting.

Measure:

- standalone-request fidelity;
- constraint satisfaction;
- relevance of reused passages;
- unnecessary repeat fetches avoided;
- acquisition of genuinely missing evidence;
- obsolete statements retained in revised reports.

A high reuse percentage is not automatically good: sometimes the follow-up requires new evidence.

### D. Citation and system correctness

Measure and test:

- all citation IDs and offsets resolve;
- cited passages actually support the associated statements;
- extraction failures never become evidence;
- branch/fork state does not leak;
- budget reservations survive interruption;
- duplicate requests do not redispatch.

Use human assessment for semantic citation support. Structural citation validation alone does not establish faithfulness.

## 11. Risks, fallbacks and remaining verification

| Risk | Chosen response |
|---|---|
| Search contract or tool exposure changes | Pin tested versions; validate structured results; fail clearly instead of scraping formatted answers |
| Provider returns citations rather than rankings | Retain source URLs but mark rank unavailable |
| Robots denial, JS-only pages, paywalls | Record the limitation and seek another source; no bypass |
| Scanned/encrypted PDF | Explicit unsupported extraction; OCR is an enhancement |
| Query drift | Anchor-preserving weights, contextual eligibility, explicit negative feedback and branch rejection |
| Branch explosion | Ranked proposal backlog and adjustable active-branch limits |
| Coverage mistaken for truth | Label answer coverage; retain qualifications and disagreements |
| Model-produced invalid JSON | One bounded repair; then retain current state or use an extractive fallback |
| Prompt injection in source text | Treat text as data; nested interpretation receives no execution authority; validate IDs and controller actions |
| Resume/fork changes costs | Non-rewinding allowance ledger separate from branch-visible evidence |
| Crash after external dispatch | Retain uncertain reservation; no automatic retry; distinguish confirmed usage from unresolved exposure |
| Late asynchronous completion | Reject stale logical commits but settle original operational accounting |
| Small evaluation set | Present exploratory findings and per-topic results, not broad superiority claims |

### Critical acceptance tests

Before calling the system complete:

1. **Spend → rewind → fork → continue:** allowance does not increase; only pre-fork evidence is visible.
2. **Duplicate request after restart:** no second external dispatch, including competing runtimes sharing an allowance.
3. **Crash after fetching but before manifest commit:** orphan content does not become searchable. Also test crashes before and after dispatch.
4. **Switch objective during a call:** late evidence cannot enter the wrong objective, but usage is still recorded.
5. **Corpus growth:** incremental and rebuilt rankings match.
6. **Hostile page:** embedded instructions cannot create branches, citations or tool actions without validation.
7. **Fetch policy:** robots denial, cross-host redirects, loops, private-address targets, DNS changes, host delays, oversized responses and timeouts obey policy.
8. **Extraction and citation identity:** malformed HTML, scanned/encrypted PDFs and two snapshots of one URL cannot produce misleading source text or offset resolution.
9. **Controller accounting:** duplicate pages, repeated queries, renamed branches and contradictions cannot manufacture yield or erase unresolved needs.
10. **Budget exhaustion mid-episode:** no new discretionary call starts; interrupted work is distinct from completed zero yield; a partial report remains available.

### Facts still needing implementation-time verification

- Which configured search provider is available and authorized for evaluation.
- A live nested-tool integration smoke test on the installed versions.
- Extraction quality across representative HTML and PDF sources.
- Storage/ledger behavior under interruption and concurrent session access.
- The actual submission deadline and form link.

**Confidence:** high in the architectural fit and distinction; moderate in the initial controller heuristics until evaluated. The principal uncertainty is whether evidence assessments and yield estimates consistently improve acquisition decisions—not whether an inspectable lexical research system can be built.

## References and verification anchors

### Assignment

- `CSD358 IR Mid-term Assignment 2026.pdf`, local path recorded above. Track: page 3; deliverables/report/video: pages 5–6; rules: pages 6–7; rubric: pages 7–8.

### Methodological references

- Stephen Robertson and Hugo Zaragoza, [*The Probabilistic Relevance Framework: BM25 and Beyond*](https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf), 2009.
- Jaime Carbonell and Jade Goldstein, [*The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries*](https://www.cs.cmu.edu/~jgc/publication/MMR_DiversityBased_Reranking_SIGIR_1998.pdf), SIGIR 1998.

### Pi verification anchors

Installed package root:

`/home/ayanp/.local/share/mise/installs/node/24.13.1/lib/node_modules/@earendil-works/pi-coding-agent`

Relevant files and source-inspection anchors:

- `docs/extensions.md`: extension contracts, nested tools, model calls, state and UI.
- `docs/session-format.md`: custom entries and session-tree persistence.
- `docs/tui.md` and `docs/rpc-extension-ui.md`: rendering and mode boundaries.
- `dist/core/extensions/types.d.ts:262–281`: `ExtensionToolContext` and nested execution.
- `dist/core/extensions/types.d.ts:286–322`: command context, without nested execution.
- `dist/core/extensions/types.d.ts:1236–1249`: entry persistence and messages.
- `dist/core/session-manager.js:1062–1072`: chronological active-branch path.
- `dist/core/session-manager.js:1205–1283`: copied-path branching includes custom entries.
- `examples/extensions/todo.ts`: reconstructing state from the active branch.

### Web integration verification anchors

Installed package root:

`/home/ayanp/.pi/agent/npm/node_modules/pi-web-access`

Relevant files and source-inspection anchors:

- `package.json:2–3`: package identity and version.
- `web-tool-contract.ts:19–30`: structured search/fetch results.
- `index.ts:1364–1392`: search registration, parameters and output schema.
- `brave.ts:197–215`: preservation of provider-returned order.
- `gemini-search.ts:887–894,966–985`: generated answers and grounding-source extraction.
- `web-tool-core.ts:646–660`: additional fetching triggered by `includeContent`.
- `storage.ts:9,481–493`: cache TTL and session restoration.
- `ssrf-protection.ts:239–271`: manual redirects and per-hop validation.
- `extract.ts:356–373`: public extraction options; no robots/per-host policy hook.

These anchors refer to inspected installed versions; pin or reverify before relying on line numbers after upgrades.

## Decision

Build an evidence-driven research engine inside Pi, not a wrapper around existing deep research. The demonstration should make one thing unmistakable: **a passage introduced a useful concept, that concept changed the investigation, and the resulting evidence improved the answer.**
