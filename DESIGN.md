# Deep research in Pi: the plan, from the user's side

What a person actually does, sees, and gets — and what we've learned so far that shapes it.

## 1. What we've established so far

### What "deep research" has to mean for a user

Run `/research <question>` in Pi and come back about ten minutes later to a substantial, standalone research report, like Gemini Deep Research. Pi takes responsibility for planning the investigation, pursuing missing evidence, and writing the report. The user does not approve the plan, steer individual searches, or reconstruct the answer from a list of sources. Ten minutes is the end-to-end target, not a reason to shorten the report.

Acceptance question for the whole feature:

> Can someone who never watched the run understand the findings, use the comparisons and recommendations, and check the evidence behind the main conclusions?

Search count, tool traces, and file output are not evidence that this happened.

### What people are already getting from existing tools

Reading LangChain's Open Deep Research as a user-facing product:

- You ask one question. It may ask you a clarifying question first.
- It shows a research plan or brief, then works: searching, reading pages, deciding what else to look for.
- It ends with one long Markdown report containing inline citations and a sources list.

An earlier version of the same project let you **edit and approve the plan** before research started, and wrote the report section by section. The current one removes that gate and writes the whole report at once.

### What the published reports actually look like

[ResearchRubrics, Table 9](https://proceedings.iclr.cc/paper_files/paper/2026/file/92808d4b229345ae40fce84b4bf038d0-Paper-Conference.pdf) reports medians of 5,481 words for ChatGPT Deep Research, 7,562 for Gemini Deep Research, and 1,579 for Perplexity Deep Research. For a broad question like the water-utility investigation, aim for roughly 5,000–8,000 words when the evidence warrants it. This is room for several concrete cases, a comparison, and recommendations, not a quota.

### What separates a useful report from a convincing-looking one

From reading a top-rated water-utility report and a published LangChain report on the same question:

- **Useful:** concrete deployed cases, what changed in practice, where numbers came from, a comparison the reader can follow, and recommendations tied to the evidence.
- **Not useful:** a precise top-ten ranking built by mixing savings, contract prices, and asset size as if they were one measure. A confident financial claim whose linked page does not establish it.

Both reports look substantial. Structure and length don't reveal the difference; checking the claims does.

The full water-utility investigation is the first end-to-end demonstration target. Use the reference report to judge the depth of the cases, comparison, and recommendations, not to copy its length or conclusions. Small fixtures can establish that individual steps work; they do not replace this demonstration.

### Decisions taken

- **Build the evidence library:** plan the needs and repeat search → select → read → retrieve → assess → expand while useful queries remain. Code owns acquisition and retrieval; the model judges the evidence and proposes expansion queries. Only extracted source text enters the library. Show the brief and progress without pausing for input.
- **Synthesize from the library:** save the evidence first, then write from ranked passages and unresolved needs, not the search transcript.
- The report is the deliverable: standalone, cited, readable cold.
- We start over in a clean workspace instead of trimming the old controller.
- We reuse Pi's web search and page reader, Riya's URL filtering, and passage-level retrieval for citations.

## 2. What the user does

### Asking

One request, in ordinary language, in Pi. Invoking `/research` starts the work using the active session model. No separate confirmation, provider picker, budget setup, or mode selection.

### Watching

Instead of a spinner, the user sees what is happening in a line or two at a time:

```text
Reading the question and planning what evidence would settle it…
Plan: compare deployed utility innovations by reported economic outcome, and say where the
      numbers are not comparable.
Searching: "utility leak detection economic savings case study" (2 of 5)
Reading 7 sources, skipped 2 (one blocked, one unreadable PDF)
Writing the report from 34 passages across 9 sources…
```

The brief is visible, but the run continues on its own. The user can interrupt if needed. Progress is described in terms of the work, not tool mechanics.

### Where the evidence comes from

Two pieces do this work, and both show up in what the user sees.

**Pi's page reader reads the pages.** Search results are only leads. The extension calls `fetch_content` in readable mode and retains the extracted text, its URL, and retrieval time. Blocked and unreadable pages are recorded as failures, not filled in by the model.

**Passage retrieval finds candidate evidence.** Read text is split into passages and ranked against each part of the research question. The writer sees relevant passages, not whole 80-page documents, and selects the exact supporting sentence or span for each citation. The reader can check that span in the stored source text without redoing the search.

These two pieces are also where the honest limits live. A claim with no retrieved passage behind it should not be in the report. A passage that ranks highly for similar words but does not actually support the claim — a projected saving answering a question about realized savings — is a judgment the writer has to make, and the reader can still see the text and disagree.

### Getting the report

The user gets a saved Markdown file, and the report itself in the conversation:

- **An answer up front.** What the investigation concluded and how strongly, in the first screen.
- **Evidence in the body.** Claims carry numbered citations that resolve to the supporting sentence or span in the stored source text, with the source URL and retrieval date listed at the end.
- **Comparisons where they're warranted**, including a plain statement when the available numbers cannot be ranked against each other.
- **Limits.** What could not be established, which sources failed, and what would change the conclusion.

### Checking it

A reader can follow any citation to the stored source text and see whether it supports the sentence. If it doesn't, that is our bug, not a reading difficulty. A blocked page or unreadable document appears as a gap in the report, never as silently invented content.

### Following up (later)

The same conversation can ask a narrower question — "focus on what's detectable without labelled data". What has already been read stays available; the new report says what changed. This is not in the first milestone.

### Stopping

At any point the user can stop. Whatever was read and written remains inspectable; nothing is retried silently.

## 3. Milestones, in terms of what the user sees

Milestones 1–3 check individual capabilities. Milestone 4 is the first end-to-end demonstration of the research agent.

| # | The user can… | Done when |
|---|---|---|
| 1 | Ask a question and see a research plan | The plan names what the report must settle and what evidence would count — and reads as aimed at their question |
| 2 | See which sources were read, and which failed and why | Sources are listed with what came out of each; failures are honest, not hidden |
| 3 | Check the report's evidence | Every numbered citation resolves to the supporting text in a stored source; a reader can check the main claims against it |
| 4 | Get a substantial report on the full water-utility question | It develops several concrete cases, compares outcomes where evidence permits, explains where it cannot compare them, and supports its findings and recommendations with checkable evidence |
| 5 | Refine the question and get a revised report | Reuses what was read; the new version says what changed |

For milestone 4, review the report without relying on the run trace. Check whether a reader can follow the cases and comparison, verify the main conclusions, and tell where the available evidence falls short. If a consequential gap remains, the agent should pursue it or explain why it could not close it. Follow-up revision comes later.

## 4. Evaluation is separate

Run the full water-utility question through `/research` and keep its output as produced. Separately, use DeepSeek 4.1 with search to judge the report against real evidence and prepare the final project report. The evaluator is not a stage, dependency, or provider requirement of `/research`.
