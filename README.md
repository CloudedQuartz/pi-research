# Deep research in Pi

`/research` runs a tool-using deep-research workflow on the active Pi session model. Start it and walk away: the target is a substantial, cited Markdown report in about ten minutes. It writes a brief, searches and reads sources, follows gaps, ranks passages, and writes the report without asking for approval. The assistant draft is visible in Pi; the saved Markdown resolves its passage IDs into linked citations.

This is a Pi-native adaptation of [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research). Pi runs the model turns; the extension owns the evidence-building loop and reuses Riya’s URL filtering.

## Requirements

`web_search` and `fetch_content` come from [`pi-web-access`](https://github.com/nicobailon/pi-web-access), declared in this package's `dependencies`, so installing the package through `pi install` installs it too. When `/research` starts it checks those tools; if nothing has registered them it loads the dependency itself, and if that fails it names the missing tool and the fix instead of starting a run that cannot work. Because it only loads `pi-web-access` when a tool is absent, a separately installed copy is not registered twice.

Host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`) are peer dependencies supplied by Pi and are not bundled.

For a source checkout, run `npm ci` and start Pi from the repository:

```bash
pi -e src/research.ts
```

`npm test` runs the offline RPC regression, and `npm run typecheck` checks the sources against the host Pi types. Both need the dev dependencies, which `npm ci` installs.

Search supplies URLs and metadata. The extension reads pages with `fetch_content` in readable mode and records failed reads without switching readers. Pi makes all model requests through the active session.
## Use

Run Pi from this directory, or load the extension isolated from your other extensions and give it the search tools explicitly:

```bash
pi -ne -e src/research.ts -e npm:pi-web-access
```

Then start a research run:

```text
/research How have water utilities used AI and remote sensing to detect leaks, and what economic outcomes are actually reported?
```

The brief appears as an ordinary assistant reply, and the run continues without a plan-approval gate. During evidence collection, enter `/research-finish` to finish the current turn and write from the evidence gathered so far. Escape cancels the run without starting synthesis.

`/research` without a question opens the input dialog. In non-interactive modes, provide the question as part of the command.

## Progress, and where the run lives

`/research` does not run in your session. It starts a child Pi session that owns every model turn, prompt and evidence packet, and this session only sees progress:

- the widget mirrors the child as a todo list, not a spinner: one row per finished round with its query, source, passage and failure counts, plus the step in progress and the elapsed time;
- one notice when the run starts and one when the report is saved, with the round, source and passage counts and the file path.

Because the run's turns belong to the child session, no part of the research transcript is in your context: a follow-up question after a run sends what it did before, not the run. The child session is an ordinary Pi session, so you can read the internals with `/resume` and pick it out by its start time; its fixes stay independent of your conversation history.

`/research-stop` ends a hosted run; the child saves the evidence it already collected. Research turns run with thinking off, and the writing turn restores your thinking level.

Collection stops when every essential need is answered, when no new queries are proposed, when two consecutive rounds add no new source or passage, when you run `/research-finish`, or when you cancel. Every stop states which condition ended it.

## What a run does

1. **Build the evidence library.** The model breaks the question into evidence needs and writes initial search queries. Then the extension repeats this loop:
   - **Search → select → read:** Code runs queued queries, takes URLs directly from structured search results, and ranks and deduplicates unread candidates. Pi’s `fetch_content` reads the selected pages. Only extracted source text enters the library; never snippets or model summaries.
   - **Retrieve → inspect → assess → expand:** Code ranks passages with BM25 and MMR. The model can inspect the stored extraction by offset or scan it for exact terms without any web calls. Inspection records keep the exact source version, range, and result; a zero match is not proof of semantic absence or complete extraction. Only essential gaps drive new web searches, and independent search batches overlap. Collection stops when essential needs are answered, useful queries run out, or you ask it to finish the current turn.
   - **Delegate, then harvest:** a need that covers several independent directions can be handed to a subagent, which researches in its own context window without touching this run. A subagent's prose is not evidence, so the extension harvests the page URLs from its reply and fetches them in the next round; `research_add_urls` is the explicit form of the same step. Either way the page only counts once it has been fetched into the library.
   - **Read documents as documents:** PDFs, Office files, CSV and images are fetched as bytes and parsed with `document_parse` and OCR, so a scanned paper still yields citable text instead of arriving empty. HTML keeps readable extraction. Two documents per round, because OCR on a 66-page report takes about 150 seconds.
2. **Synthesize from the library.** The extension saves the evidence first. A separate writing turn sees the ranked passages and open needs, not the search transcript. It cites passage IDs, which code resolves to the source URL, retrieval date, and text offsets.

## Reading a run

`/research-view` opens the last run's journal in a scrollable pager: the question, round by round queries with the sources each one added and the failures it hit, each assessment's coverage and its own reply, the inspections, the stop reason and where the report and child session live. The journal is written as the run goes (`research/<stamp>-<slug>.journal.json`), so it also works after a restart. `/research-stop` ends a hosted run and the child saves the evidence it already collected.

## Output and save condition

The report with resolved citations is saved as:

```text
research/<timestamp>-<slug>.md
```

A matching `.evidence.json` file holds sources, ranked passages, scoped inspections, needs, search outcomes, and acquisition failures. The library is saved before synthesis; if the run is interrupted during collection, acquired text is saved on cancellation.

Each citation in the report quotes at most 700 characters of its source, clipped at a word boundary and marked with an ellipsis, followed by the source title, URL, retrieval date and the text offsets it covers. A citation is a pointer with enough text to check the claim, not a reprint of the page.

## Limitations

- **Page acquisition:** Access and extraction depend on the configured `pi-web-access` reader. Blocked or unreadable pages are recorded as failures; summaries are not substitutes for original full text.
- **Citation resolution is not claim validation.** The extension resolves passage IDs and reproduces their stored text; the writer still decides whether it supports each claim.
- **Timing depends on the research.** About ten minutes is a target, not a cutoff. The active Pi model plans, assesses, and writes.
- **Follow-up questions start a new run.** Gap-driven follow-up searches happen within a run, but this implementation does not yet reuse a previous run's stored evidence for a narrower follow-up question; that remains a later milestone.
- **Failures are gaps.** A blocked page, challenge screen, unreadable PDF, or empty extract is reported as a gap; it is never filled in from memory. The extension cannot make a failing source readable.

Measure report quality with the [separate evaluation harness and results](evaluation/README.md). The evaluator is not part of `/research`. The [course report](submission/CSD358-project-report.pdf) and final archive are in [`submission/`](submission/).

## Attribution

The workflow and prompt structure are adapted from [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research), MIT License, Copyright (c) 2025 LangChain. See [NOTICE](NOTICE) for the license text. This is a Pi-native single-agent adaptation, not a full port of the upstream graph. The passage-backed evidence handoff takes its cue from [TheLoomLabs/pi-dr](https://github.com/TheLoomLabs/pi-dr). [timaliev/pi-deep-research](https://github.com/timaliev/pi-deep-research) also informed the staged research flow; this extension does not adopt its subprocess model calls or plan confirmation.

Use `/reload` after editing the extension.
