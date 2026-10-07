# Pi Research — Progressive Deep Research

CSD358 Information Retrieval, T2: conversational and agentic search.

A Pi extension that builds a passage corpus from fetched public sources, retrieves with inspectable positional BM25, and uses evidence-derived concepts to expand and prioritize an investigation. Follow-ups revise the objective while retaining applicable evidence.

## Implementation status

Implementation is paused for handover. Only the package setup and shared data/model/reporting modules exist. Acquisition, persistence, retrieval and the controller are not implemented; this is not a loadable research extension yet. Unfinished integration/evaluation code is preserved as non-runnable drafts under `docs/drafts/`. Start the next session with [the handover](docs/handover.md); [the implementation plan](docs/project-plan.md) remains the full specification.

## Development setup

- Node **24.13.1 or newer** (the planned ledger will use the experimental built-in `node:sqlite`).
- Run `npm ci` to install the pinned dependencies.
- `npm run typecheck` checks the current shared modules only; drafts are excluded by their `.txt` extensions. No tests, demo or evaluation commands are registered until their implementations exist.
- The installed Pi **1.0.4** host and **pi-web-access 0.37.0** supply conversation/model access and discovery. This project does not import private web-provider implementation modules.

After implementing and validating the entry point, restore package extension registration and load explicitly from this repository (this command does not work yet):

```sh
pi --extension ./src/extension.ts
```

Load the web-access extension in the same Pi session. Select one authorized provider and the registered search tool name at `/research` startup; names may have been customized. No global Pi settings are changed by this project.

## Intended workflow

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

External work requires explicit command authorization in TUI or RPC mode. Model-callable tools cannot grant themselves allowance. Resuming or forking does not restore spent allowance.

## Required evidence and accounting boundaries

- Search answers and snippets are discovery metadata, **never indexed source evidence**.
- Only actual fetched and deterministically extracted source text enters the passage corpus.
- Reports cite immutable passage spans and snapshots; structural citation validity is not proof of semantic support.
- Answer coverage is not factual confidence. Page/domain counts are not confidence.
- Public-source acquisition must respect robots rules, hostname delays, redirect policy and public-address checks. No authenticated fetching, browser cookies or paywall bypass.
- Source snapshots are immutable; active Pi-branch manifests determine corpus membership. Orphan blobs are invisible to retrieval.
- Search invocations, page-fetch attempts, HTTP attempts and model usage are separate counters. Provider-hidden operations and unreported costs remain unknown.
- Model token control is estimated, not a guaranteed provider-side tokenizer limit or total monetary cap.

## Evaluation and submission

The plan specifies fixed-corpus BM25 baselines and PRF/MMR ablations, budget-matched research-policy comparison, follow-up reuse/constraint judgments and citation assessments. Human relevance judgments and measured results must be collected; no benchmark outcomes are claimed here.

The course submission also needs the report of at most eight pages, a 5–8-minute live demonstration video, actual team work division, dependency/source credits and an AI-use declaration. A recorded fixture replay is a regression aid, not a substitute for a live demo.

## Dependencies and AI assistance

The approved extraction dependencies are Mozilla Readability, LinkeDOM and unpdf; robots-parser and ipaddr.js are installed for the planned acquisition service. Pi supplies model and terminal contracts. Version pins and transitive dependencies are in `package-lock.json`; each dependency retains its own license.

AI assistance was used to research integration contracts, develop the implementation plan and generate/review code. Source-level inspection and automated checks must be distinguished from live end-to-end verification. Final evaluation judgments, team contributions and demonstrated behavior require human confirmation.
