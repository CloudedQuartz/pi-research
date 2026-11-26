# Evaluation: DeepResearch Bench RACE, four systems on four tasks

All numbers here are produced by `evaluation/` in this repo, judged by
`deepseek-v4.1-flash` through `opencode_proxy.mjs`, using the official point-wise
RACE prompt, the official per-criterion list and the official weighted formula.

## What was compared

The shipped baseline articles (`evaluation/{openai,gemini,grok,perplexity}-*.jsonl`)
were judged on the **same four tasks** the extension ran, with the same judge and
prompt. Their published numbers are not reused: the baseline articles were re-judged
so that any judge drift applies equally to both sides.

| task | prompt (short) | topic |
|---:|---|---|
| 52 | investment philosophies of Duan Yongping, Buffett, Munger | Finance |
| 77 | role of need for closure on misinformation acceptance | Health |
| 85 | components of a precision piezoelectric vibration isolation system | Industrial |
| 88 | how Netflix adapted *One Hundred Years of Solitude* | Art & Design |

Our side is the **median of repeated judge calls** per report (n=4 for 77/85/88, n=1
for 52), with the half-spread in brackets, because the judge is not reproducible -
see below.

## Result

| task | pi-research | gemini 2.5 Pro | openai | grok | perplexity |
|---|---:|---:|---:|---:|---:|
| 52 | **92.3** (±0.0) | 90.2 | 73.2 | 76.1 | 72.8 |
| 77 | 77.3 (±3.8) | **85.7** | 80.3 | 68.9 | 72.8 |
| 85 | 79.0 (±3.1) | **91.1** | 81.5 | 52.6 | 71.8 |
| 88 | 90.8 (±3.0) | **94.3** | 83.3 | 73.2 | 76.0 |
| **mean** | 84.9 | **90.3** | 79.6 | 67.7 | 73.3 |

Mean dimensions over tasks 77/85/88 (the three with repeat samples):

| | comprehensiveness | insight | instruction following | readability | total |
|---|---:|---:|---:|---:|---:|
| **pi-research** | 77.3 | 80.7 | 89.6 | 88.7 | **82.4** |
| gemini 2.5 Pro | 89.8 | 89.0 | 94.2 | 90.6 | 90.4 |
| openai | 84.0 | 76.5 | 90.1 | 80.2 | 81.7 |
| grok | 63.6 | 55.6 | 79.1 | 75.4 | 64.9 |
| perplexity | 73.7 | 64.0 | 86.2 | 83.2 | 73.5 |

Reading it: the extension is mid-pack overall - ahead of grok and perplexity, behind
openai on two of three tasks and behind gemini on all three. Its weakness is
**comprehensiveness** (77.3 vs gemini's 89.8), which is what a thin corpus looks
like: one of these runs collected three sources. Its strength is instruction
following and readability, i.e. it writes what was asked, cleanly, from less material.

On task 52 it is the best of the five, but that number rests on a single judge call.

## The judge is not reproducible

Same report, same prompt, temperature 0, repeated calls:

| task | calls | median | spread |
|---|---|---:|---:|
| 77 | 4 | 77.3 | 7.6 |
| 85 | 4 | 79.0 | 6.1 |
| 88 | 4 | 90.8 | 6.0 |

A single call is worth roughly ±3 points, and one call in four landed 7.6 points below
the median. Any comparison that turns on a few points - including "beats gemini on
task 52" - is inside the noise. Differences under ~6 points are not meaningful here.

## The extension's own failure rate

Eight tasks were launched at once; three produced a report. Five did not:

| task | outcome | evidence |
|---:|---|---|
| 62 | no report | 8 consecutive `429 rate_limit_error` stops in the child session |
| 71 | no report | 2 rate-limit stops, then stopped |
| 97 | no report | 1 rate-limit stop, then stopped |
| 51, 57 | no report | journal `status=stopped`, `stopReason=None`, no errors recorded |

The four tasks without a rate-limit error are confounded: the installed package in
`/tmp/sandbox/pkg` was overwritten from the repo while those children were running, so
their processes were loading files that changed underneath them. Those four are not
evidence of a defect, and their re-runs are reported separately.

Two real findings stand:

1. **A throttled provider could end a run without a report.** Fixed: a retryable
   provider error now backs off (20s, 40s, 80s, capped 120s) with four attempts, while
   a permanent error still fails fast.
2. **The journal still cannot say why a run stopped.** A fired stage bound now records its
   reason, but `status=stopped` can still arrive with
   `stopReason=None` and an empty error list is what all five show, which is exactly
   the failure mode `8f5bd1a` was meant to remove. Reproducing it needs a run that
   stops on an error rather than an empty completion.

## Retrieval quality over each run's own corpus

`scripts/retrieval-eval.ts` rebuilds each run's library, ranks every passage for each
research need with the production retriever (BM25 then MMR, credibility-weighted),
and scores that ranking against relevance labels from the same judge. Labels are
cached beside the evidence file, so the numbers are reproducible offline.

| run | needs | passages | nDCG@10 | MAP | R-Precision | BPref |
|---|---:|---:|---:|---:|---:|---:|
| 77 · need for closure | 7 | 336 | 0.389 | 0.511 | 0.507 | 0.485 |
| 85 · piezo isolation | 7 | 599 | 0.502 | 0.621 | 0.527 | 0.500 |
| 88 · Netflix adaptation | 7 | 111 | 0.394 | 0.596 | 0.528 | 0.454 |
| **mean** | | | **0.428** | **0.576** | **0.521** | **0.480** |

Ranking is roughly half-right: MAP 0.58 says the first relevant passage usually
arrives early, nDCG@10 0.43 says the top ten are mixed. The corpus is the limit, not
the ranker - 111-599 labelled passages per run, from 3-12 sources.

Caveats: labels come from the same model that wrote the reports and judges them
(`deepseek-v4.1-flash`), three runs only, and the per-source cap of 2 was lifted for
this measurement while production keeps it, so these numbers describe the ranker
rather than the exact packet the writer sees.

## Failure modes found while evaluating

Three are worth recording because each one costs a whole run's work.

**A run can end without finalising.** t57's clean re-run collected 29 sources and
443 KB of evidence, then stopped: its journal still says `status: running` with no
`reportAt`, so no report was written and nothing recorded why.

**After that, the parent model writes its own report.** In the same session the
assistant called `bash` twelve times and produced `ai-consulting-firms-report.md` -
19 KB, hand-named, zero resolved citations, outside the pipeline that turns passage
IDs into linked footnotes. The tool guard only binds while `stage === "research"`, so
once the run ends the parent is free to improvise a report that is not evidence-linked
and would be scored as if it were.

**A refused download is recorded as an empty parse.** A GAO PDF was routed to
`document_parse`, whose own `GET` was refused with 403, and the source was logged as
"document parse produced no text". The fetch tool reads that same report (108 618
characters), so the run lost a document it could already reach. Fixed in `854a370`:
the parser stays first (it is the only path that OCRs a scan), then the fetch tool
gets one attempt, and the recorded reason is the real one.

Not every failure is recoverable, and that is worth stating plainly: SAGE,
ScienceDirect and DOI publisher links answer 403 to a browser-like request as well,
so only a hosted reader route can reach them, and that changes who sees the URL.

## The clean re-runs (frozen build, no mid-run edits)

Three of the failed tasks were re-run against a frozen copy of the installed package,
with no edits to it while they ran, so the earlier confound is gone:

| task | sources collected | journal | report |
|---|---:|---|---|
| 51 | 17 | `status=stopped`, `stopReason=None`, 0 errors | none |
| 62 | 18 | `status=stopped`, `stopReason=None`, 0 errors | none |
| 57 | 29 (443 KB of evidence) | `status=running`, never finalised | written by the parent model, uncited |

None of the three produced a pipeline report, and none recorded why it stopped. The
400 call rate limiting that killed task 62 on the first attempt does not appear in
these sessions at all, so throttling was a consequence of running eight at once, not
the cause of the silent stops.

That is the headline limitation of the current build: **the research usually works and
the finishing does not always happen**, and when it does not, the journal cannot say
what went wrong. Until that is fixed, any score in this document is drawn from the
runs that happened to finish, which is a biased sample - the three that produced
reports are exactly the three that collected 3-12 sources, while the runs that died
had collected 17-29.

To reproduce the retrieval numbers, with the judge proxy running
(`node evaluation/opencode_proxy.mjs 8787`) and `JUDGE_KEY` exported:

```bash
npm run eval:retrieval -- research/<run>.evidence.json ...
```

Labels are cached as `<run>.evidence.qrels.json` next to the evidence file, so a rerun
costs nothing and does not depend on the judge being reachable.

## Why runs stop without a report: the stage watchdog

Every clean re-run that collected sources and produced no report ended 1200s after its last
stage prompt, which is `STAGE_WATCHDOG_MS` exactly.

| run | last stage prompt | journal `finishedAt` | gap |
|---|---|---|---|
| t62 | `20:36:15.276Z` | `20:56:17.537Z` | 1202s |
| t57 | started `20:33:52Z` | `20:54:16.436Z` | 1224s total |

t62's session shows the model was still working when the extension gave up: its `bash` and
`write` calls land at `20:57:47` and `20:59:08`, 90 and 171 seconds after `finishedAt`. Once
the run is cleared those calls are not evidence collection — one wrote
`/tmp/sandbox/work/t62/ion-trap-scaling-report.md` (14,240 bytes, no citations, outside the
pipeline that resolves `[P123]` to a linked footnote).

The watchdog ended the run rather than writing from the evidence already collected, and its
path set no `stopReason`, so journals read `status=stopped` with `None`.

That bound is gone: it is opt-in through `PI_RESEARCH_STAGE_TIMEOUT_MS` and off by default, so a
turn ends because it is finished rather than because a clock expired. When the bound is set it
records why it fired. The tool guard also refuses calls once no run exists, which is what the
hand-written file above exploited.

An earlier note on `cba8398` attributed these stops to a settle/message_end race. That
ordering is real and now hardened against, but it is not the cause: the timing above rules it
out, and the runs that failed stayed alive for 20 minutes.

## What actually kills a run, measured

Two independent causes were found by reading the sessions, not by guessing at them.

| run | symptom | cause | evidence |
|---|---|---|---|
| t62, t57 (frozen build) | `status=stopped`, no report | stage watchdog fired 1202s / 1224s after the last stage prompt | `finishedAt` minus prompt timestamp; the model kept working 90-171s later |
| t62 (next build) | `Research stopped: The assessment did not judge each research need.` | one need missing from the assessment JSON threw away 4 rounds and 18 sources | tmux pane text, final assistant message |

Both are fixed: the bound is opt-in and off by default, and a partial assessment now leaves the
unjudged needs unanswered instead of ending the run.

## Where wall-clock goes

Three runs measured from their own sessions (`/tmp/eval/timing.py`):

| run | wall | model time | tool batches | largest batch |
|---|---|---|---|---|
| t51 | 486s | 137s | 6 | 105s |
| t57 | 398s | 33s | 4 | 198s |
| t62 | 476s | 127s | 19 | 225s |

Tool calls issued in one turn run concurrently, so summing their durations overstates cost; the
batches above are elapsed. Delegation is the single largest item: three `subagent` calls in one
turn returned together after ~400-460s each, about 7.6 minutes of wall clock for the batch.

The fastest complete run so far used no delegation at all: 35 sources, 104 passages, 271s,
`research/2026-11-25T23-26-53-276Z-how-should-a-deep-research-agent-retrieve-pages-that-block-p.md`.

## Recovering refused pages

Against the 44 URLs these runs recorded as walls, measured directly:

| rung | recovered |
|---|---|
| Wayback availability API + snapshot | 20 / 44 |
| local Chromium render (8 sampled from the remainder) | 5 / 8 with substantial text; the rest returned a challenge page |
| same URL, browser-like User-Agent (acquisition module) | not yet measured in a run |

The ladder is crawler → archive → browser, in that cost order, and a rung can only add a source.

## Cycle log

### Cycle 1 (impure sandbox, superseded)

Run on a sandbox that inherited globally installed extensions, so it measured a setup a user
would not have. Three tasks were started; two were still working after 21 minutes and t57 wedged
entirely - 1034s with no new event, waiting on a `subagent` call that never returned. That wedge is
the failure mode `PI_RESEARCH_SUBAGENT_WAIT_MS` exists for, and it is now set for the cycles.

`/research` in a pristine install also told the model to call `subagent` although no such tool was
installed; that is fixed by gating the delegation paragraph on the tool existing.

### Cycle 2 (pristine sandbox, current build)

Environment: `/tmp/sandbox3/agent`, credentials and settings only, this package installed with
`pi install`, extension list is `research.ts` alone. Model deepseek-v4.1-flash, delegation bounded
at 120s, fetch ladder enabled, archive fallback active.

### Environment note: what the container can and cannot exclude

`pi -ne -e /pkg` removes host extensions and configured packages, which is what the earlier host
runs leaked. It does not remove tools that pi itself provides: inside the container the session
still defines and calls `subagent` (`{"name":"subagent","description":"Laun...` followed by
`toolCall ... "name":"subagent"`), so delegation is a pi capability, not an optional extra.

The consequence for testing is specific: "works without the subagents extension" is not observable
in this environment. What can be verified is that the prompt no longer instructs a tool that is
absent (unit-tested in `test/research-prompt.test.ts`) and that `/research` runs when a capability
is missing.

### Baseline coverage on all eight comparison tasks

The four earlier tasks (52/77/85/88) had baseline articles; 51/57/62/97 did not, so an eight-task
claim would have compared our numbers against nothing. The shipped articles for those four were
extracted from `evaluation/{gemini-2.5-pro-deepresearch,openai-deepresearch,grok-deeper-search,perplexity-Research}.jsonl`
and judged with the same judge, prompt and weights (`/tmp/eval/judge_baselines8.sh`, results in
`/tmp/eval/baselines8.tsv`).

| task | gemini | grok | openai | perplexity |
|---|---|---|---|---|
| 51 | 81.7 | 55.5 | 78.2 | 56.7 |
| 57 | 73.7 | 77.2 | 67.7 | 78.6 |
| 62 | 90.2 | 75.8 | 74.3 | 75.6 |
| 97 | 90.3 | 60.5 | 73.8 | 55.4 |
| **mean** | **84.0** | 67.2 | 73.5 | 66.6 |

Per-task bar for "on par or better" is the bold number: 81.7 / 78.6 / 90.2 / 90.3. Single judge call
per baseline article, so these carry the same ~4-point noise as everything else here; our own
numbers are reported as medians of three.

### Concurrency and throttling (cycle 3)

Three container runs on one provider key throttle each other. In task 62's session the last
successful turn took 11s with 2,629 input tokens, then nothing for five minutes while the retry
budget waited (20+40+80+120s) - the wall clock goes into backoff, not into thinking or fetching.
That is a property of the environment, not of the extension: the same build does 271s runs when
the provider is not refusing.

Consequence for measurement: judging must not run at the same time as a cycle, since the judge uses
the same key, and per-run wall clock has to be reported with the concurrency it ran at.
