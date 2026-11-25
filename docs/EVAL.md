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
2. **The journal still cannot say why a run stopped.** `status=stopped` with
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
