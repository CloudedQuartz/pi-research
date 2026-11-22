# Deep research in Pi

`/research` runs a tool-using deep-research workflow on the active Pi session model. Start it and walk away: the target is a substantial, cited Markdown report in about ten minutes. It writes a brief, searches and reads sources, follows gaps, ranks passages, and writes the report without asking for approval. The assistant draft is visible in Pi; the saved Markdown resolves its passage IDs into linked citations.

This is a Pi-native adaptation of [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research). Pi runs the model turns; the extension owns the evidence-building loop and uses the old Riya branch’s crawler.

## Requirements

Install the crawler dependencies with `npm ci` and enable `web_search` from `pi-web-access`. Search supplies URLs and metadata; the bundled crawler is the only page reader. A failed read is recorded rather than retried through another reader. Pi makes all model requests through the active session.

## Use

Run Pi from this directory:

```bash
pi -e src/research.ts
```

Then start a research run:

```text
/research How have water utilities used AI and remote sensing to detect leaks, and what economic outcomes are actually reported?
```

The brief appears as an ordinary assistant reply, and the run continues without a plan-approval gate. Pi handles the model requests, tool loop, streaming, and errors as it does for any other turn.

`/research` without a question opens the input dialog. In non-interactive modes, provide the question as part of the command.

## What a run does

1. **Build the evidence library.** The model breaks the question into evidence needs and writes initial search queries. Then the extension repeats this loop:
   - **Search → select → read:** Code runs queued queries, takes URLs directly from structured search results, and ranks and deduplicates unread candidates. The crawler reads the selected pages. Only extracted source text enters the library; never snippets or model summaries.
   - **Retrieve → assess → expand:** Code ranks passages for each need with BM25 and MMR. The model judges whether the passages answer each need, identifies gaps and contradictions, and proposes fresh queries. Code runs those queries in the next round. It stops when the needs are answered, no new queries remain, or the model recommends stopping and retrieval does not justify another round. There is no fixed round or read cap.
2. **Synthesize from the library.** The extension saves the evidence first. A separate writing turn sees the ranked passages and open needs, not the search transcript. It cites passage IDs, which code resolves to the source URL, retrieval date, and text offsets.

## Output and save condition

The report with resolved citations is saved as:

```text
research/<timestamp>-<slug>.md
```

A matching `.evidence.json` file holds sources, ranked passages, needs, search queries, and acquisition failures. The library is saved before synthesis; if the run is interrupted during collection, acquired text is saved on cancellation.

## Limitations

- **Crawl policy:** The bundled crawler applies `robots.txt`, per-host spacing, and public-address checks. It reports unreadable pages rather than switching readers.
- **Citation resolution is not claim validation.** The extension resolves passage IDs and reproduces their stored text; the writer still decides whether it supports each claim.
- **Timing depends on the research.** About ten minutes is a target, not a cutoff. The active Pi model plans, assesses, and writes.
- **Follow-up questions start a new run.** Gap-driven follow-up searches happen within a run, but this implementation does not yet reuse a previous run's stored evidence for a narrower follow-up question; that remains a later milestone.
- **Failures are gaps.** A blocked page, challenge screen, unreadable PDF, or empty extract is reported as a gap; it is never filled in from memory. The extension cannot make a failing source readable.

Measure report quality with the project’s separate evaluation. The evaluator is not part of `/research`.

## Attribution

The workflow and prompt structure are adapted from [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research), MIT License, Copyright (c) 2025 LangChain. See [NOTICE](NOTICE) for the license text. This is a Pi-native single-agent adaptation, not a full port of the upstream graph. The passage-backed evidence handoff takes its cue from [TheLoomLabs/pi-dr](https://github.com/TheLoomLabs/pi-dr). [timaliev/pi-deep-research](https://github.com/timaliev/pi-deep-research) also informed the staged research flow; this extension does not adopt its subprocess model calls or plan confirmation.

Use `/reload` after editing the extension.
