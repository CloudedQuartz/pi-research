# Pi Research — Progressive Deep Research

CSD358 Information Retrieval, T2: conversational and agentic search.

A Pi extension that builds a passage corpus from fetched public sources, retrieves with inspectable positional BM25, and uses evidence-derived concepts to expand and prioritize an investigation. Follow-ups revise the objective while retaining applicable evidence.

## Implementation status

[Live Pi RPC runs](docs/live-verification.md) verified Exa discovery, source acquisition, and reuse of stored snapshots without new searches or fetches. A separate live report update produced five resolving citations from a retained Google ML Crash Course snapshot. Its answer was limited by what that source covered.

A useful cited answer on both turns of one fresh session remains unverified. The latest attempt reached command authorization, but the outer model declined to invoke `research_run`, so discovery never started. The first-follow-up budget reserve and smaller synthesis packet passed offline regression checks; that live attempt did not exercise them. The [CISI benchmark](#cisi-benchmark-result) measures document retrieval separately.

## Development setup

- Node **24.13.1 or newer** (the ledger uses the experimental built-in `node:sqlite`).
- Run `npm ci` to install the pinned dependencies.
- `npm run typecheck` checks active TypeScript modules; drafts are excluded by their `.txt` extensions. The current modules pass typechecking; this establishes type consistency, not live behavior. The evaluation CLI and offline replay demo are available.
- `npm test` runs the permanent offline IR, engine, SDK/package-loading and evaluation regressions. `test:ir`, `test:engine`, `test:sdk` and `test:evaluate` can also run separately. No real model or network calls are made.
- Tests pin Pi SDK **1.0.4**. Live RPC checks used Pi **1.5.2** and **pi-web-access 0.48.0**. The integration uses registered tools rather than private web-provider modules.

The package registers `src/extension.ts`. SDK loading is tested against Pi 1.0.4; interactive research still requires an available model and discovery provider. To load explicitly:

```sh
pi --extension ./src/extension.ts
```

Load the web-access extension in the same Pi session. Select one authorized provider and the registered search tool name at `/research` startup; names may have been customized. If you use Pi’s `--tools` allowlist, include both `research_run` and the configured search tool (usually `web_search`). Leaving the search tool out removes it from the registry, including for nested calls. No global Pi settings are changed by this project.

## Workflow

```text
/research Why do ML models perform well offline but fail in production?
/research-map
/research-sources
/research-continue Focus on problems we can detect without labelled production data.
/research-report
```

Other controls:

- `/research-feedback useful|irrelevant|accept|reject|prioritize <id>` records feedback.
- `/research-budget` inspects confirmed spending, outstanding reservations and remaining allowance.
- `/research-budget add searches=2 fetches=6 http=24` explicitly authorizes more capacity; it does not start calls.
- `/research-report update` authorizes new synthesis.
- `/research-stop` requests cancellation while preserving committed evidence.

New investigations have no overall time deadline by default. The ledger still records active research time; operation caps, acquisition timeouts, and `/research-stop` remain in effect. Existing investigations keep their recorded time limits. On an investigation with no deadline, `/research-budget add elapsedMs=900000` sets a 15-minute total active-time limit, counting time already spent. On an investigation with a deadline, it adds 15 minutes to that limit.

External work requires explicit command authorization in TUI or RPC mode. Model-callable tools cannot grant themselves allowance. Resuming or forking does not restore spent allowance. Only one writer per investigation is supported, including across copied forks; explicit recovery revokes old requests permanently without refunding uncertain reservations.

## Required evidence and accounting boundaries

- Search answers and snippets are discovery metadata, **never indexed source evidence**.
- Only actual fetched and deterministically extracted source text enters the passage corpus.
- Reports cite immutable passage spans and snapshots; structural citation validity is not proof of semantic support.
- Answer coverage is not factual confidence. Page/domain counts are not confidence.
- Public-source acquisition must respect robots rules, hostname delays, redirect policy and public-address checks. No authenticated fetching, browser cookies or paywall bypass.
- Source snapshots are immutable; active Pi-branch manifests determine corpus membership. Orphan blobs are invisible to retrieval.
- Search invocations, page-fetch attempts, HTTP attempts and model usage are separate counters. Provider-hidden operations and unreported costs remain unknown.
- Model token control is estimated, not a guaranteed provider-side tokenizer limit or total monetary cap. The research ledger covers the extension's nested interpretation/synthesis calls, not the enclosing Pi conversation. The adapter marks incomplete/unreported usage explicitly; offline tests exercise conservative unknown-usage propagation. Pi-native money figures are model-rate estimates, not confirmed invoices.
- Choose non-personal research topics and screen sources before distributing corpora; fetched public pages can contain incidental personal metadata. No privacy-filtering guarantee is claimed.

## Web acquisition and crawling safeguards

Pi Research does not run an unconstrained web scraper. Because page fetches consume user-authorized budget, acquisition applies strict quality and efficiency safeguards:
- **URL deduplication & route filtering**: Normalizes candidate URLs (stripping tracking tags, AMP prefixes, and default ports) and skips non-article routes (video platforms, social feeds, login gateways) before spending fetch credits.
- **Bot-challenge & thin-content rejection**: Classifies Cloudflare challenges and thin pages (<80 characters) as blocked rather than indexing anti-bot text into the evidence corpus.
- **Host circuit breaker**: Stops requesting a domain for the rest of the run if it denies access (403, 429, or CAPTCHA).
- **Publication dates & canonical metadata**: Extracts `datePublished`, `dateModified`, and canonical URLs from JSON-LD / OpenGraph to trace source freshness.
- **In-article link harvesting**: Harvests links from model-judged relevant passages as free candidate sources without spending search credits.
- **Syndication & wire-service duplicate detection**: Groups identical passages across different domains into duplicate groups to prevent syndicated news copies from falsifying multi-source consensus.
- **Acquisition yield summary**: `/research-sources` displays an aggregated crawl report with yield rates and categorized failure reasons.

See [docs/web-acquisition.md](docs/web-acquisition.md) for the detailed architecture and implementation details.

## Offline replay demo

`npm run demo` exercises the real engine, index, immutable store and SQLite ledger with synthetic `example.org` sources and fake model/discovery/acquisition hosts. It prints source → TF-IDF candidate → branch/alias → selected action, BM25 contributions, follow-up corpus reuse, revised citation spans and simulated-operation counters. Its checks fail with a nonzero exit code. No real model or network calls are made; HTTP transport is not exercised. Random UUIDs can change tied action order; the canonicalized behavior digest is stable.

This three-source replay is a reproducibility aid, **not a live web demo or retrieval benchmark**. For the course video, use an explicitly authorized live provider/model, show the actual intermediate IR trace and follow-up, inspect a citation, and present measured human evaluation plus a real limitation. The proposed seven-minute sequence is in [the plan](docs/project-plan.md#9-demonstration-that-exposes-the-contribution).

## Evaluation and submission

### Frozen-corpus retrieval evaluation

`npm run --silent evaluate -- <judged-dataset.json>` compares BM25, anchored lexical PRF and PRF+MMR on one frozen passage index. The JSON input contains `passages` (the `Passage` schema in `src/types.ts`) and `queries`, each with a unique `id`, `text` and `judgments` mapping actual passage IDs to integer grades 0–3. Passage offsets are UTF-16 units with `end - start === text.length`.

1. Freeze development parameters before held-out evaluation. The plan targets two development and eight held-out conversations, each with an initial request and two follow-ups.
2. Pool competing methods' retrieved passages, then collect **human** relevance grades: 0 irrelevant, 1 marginal/contextual, 2 useful, 3 directly addresses the request. Keep near variants separately judged; remove exact-text aliases and recheck judgments for retained IDs. The CLI rejects corpora whose shared index folds aliases.
3. Double-judge a subset and record disagreements. Judge answer needs, evidence roles and semantic citation support separately; duplicate groups are not equivalence or confidence labels.
4. Run every method against the same frozen corpus/qrels. Report per-query scores and equal-query macro averages, including zero-positive-qrel queries. Outputs include fixed-denominator P@5/P@10, exponential-gain nDCG@10, **pooled recall** and index-group redundancy. Unjudged passages count as zero, not as verified irrelevant.

This CLI uses lexical feedback, not live contextual assessment. It does **not** measure research-policy allocation, conversational quality or citation faithfulness. For those planned comparisons, match provider, model, extraction and resource caps; preserve each run's manifests/snapshots and record actual consumption plus unresolved exposure. Human judgments must assess useful contributions, discovered needs, wasted queries/fetches, standalone-request fidelity, constraint satisfaction, relevant reuse and obsolete report statements. Replay is not a fair unrestricted-web benchmark.

### CISI benchmark result

On the [Glasgow CISI collection](https://ir.dcs.gla.ac.uk/resources/test_collections/cisi/), 76 queries with human judgments were scored against 1,459 documents (one document per index entry). The preparation excludes 36 unjudged queries and maps one exact duplicate to its canonical ID, collapsing one duplicate relevance pair. Unlisted pairs count as zero for scoring, not as human judgments of irrelevance.

| Method | Description | P@5 | P@10 | nDCG@10 | Pooled recall@10 |
|---|---|---:|---:|---:|---:|
| **BM25 + Stemming** | Porter-stemmed BM25 (Active live ranker) | **0.4263** | **0.3632** | **0.3984** | **0.1470** |
| BM25 | Original unstemmed BM25 baseline | 0.3895 | 0.3105 | 0.3607 | 0.1360 |
| QL (Dirichlet $\mu=2000$) | Language model with Dirichlet smoothing | 0.3684 | 0.2921 | 0.3390 | 0.1392 |
| SDM (MRF) | Sequential Dependence Model | 0.3605 | 0.2921 | 0.3338 | 0.1275 |
| Anchored lexical PRF | Original pseudo-relevance feedback | 0.2974 | 0.2566 | 0.2902 | 0.0955 |
| PRF + MMR | PRF with diversity re-ranking | 0.2868 | 0.2474 | 0.2821 | 0.0915 |

Porter-stemmed BM25 scored best with a **+10.46% relative gain in nDCG@10** and **+17.0% relative gain in P@10** ($p < 0.001$, paired Student's $t$-test), resolving morphological mismatch without altering surface citations. See [docs/information-retrieval.md](docs/information-retrieval.md) for full architecture details on stemming, Rocchio feedback, candidate pre-filtering, and passage clustering. [Per-query results and provenance](evaluation/cisi-results.json) omit source and query text. To reproduce with a local copy of the upstream archive:

```sh
node scripts/prepare-cisi.mjs --archive /path/to/cisi.tar.gz --out /tmp/cisi-dataset.json
npm run --silent evaluate -- /tmp/cisi-dataset.json
```

The course submission also needs the report of at most eight pages, a 5–8-minute live demonstration video, actual team work division, dependency/source credits and an AI-use declaration. A recorded fixture replay is a regression aid, not a substitute for a live demo.

## Dependencies and AI assistance

The approved extraction dependencies are Mozilla Readability, LinkeDOM and unpdf; robots-parser and ipaddr.js implement acquisition policy checks. Pi supplies model and terminal contracts. Version pins and transitive dependencies are in `package-lock.json`; each dependency retains its own license.

AI assistance was used to research integration contracts, develop the implementation plan and generate/review code. Source-level inspection and automated checks must be distinguished from live end-to-end verification. Final evaluation judgments, team contributions and demonstrated behavior require human confirmation.
