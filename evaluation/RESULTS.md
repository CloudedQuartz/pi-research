# DeepResearch Bench RACE with a deepseek-v4.1-flash judge

Purpose: check whether the model used here as a judge reproduces the benchmark's
human scores before trusting it on any new research output.

## Protocol

- Benchmark: **DeepResearch Bench** (`Ayanami0730/deep_research_bench`,
  dataset `muset-ai/DeepResearch-Bench-Dataset`).
- Human labels: `human_RACE.jsonl` — 3 annotators for each of the 50 Chinese
  tasks, 0-100 per dimension plus an overall score. The 50 English tasks have no
  annotations in this release.
- Task used so far: **id 1** (China's nine social strata, Chinese report).
- Reports judged: the four systems shipped with the dataset (OpenAI Deep
  Research, Gemini 2.5 Pro Deep Research, Grok Deeper Search, Perplexity
  Research).
- Judge: `opencode-go/deepseek-v4.1-flash`, official point-wise RACE prompt,
  official per-criterion list (weights withheld from the judge), scored with the
  official weighted formula (`score.py` mirrors `utils/score_calculator.py`).
- Judge saw no human scores and no reference report.

## Result (task 1, 4 reports, 3-annotator mean)

| system | judge | human | abs err |
|---|---:|---:|---:|
| openai-deepresearch | 62.61 | 79.00 | 16.39 |
| gemini-2.5-pro-deepresearch | 73.79 | 83.33 | 9.54 |
| grok-deeper-search | 51.45 | 47.00 | 4.45 |
| perplexity-Research | 55.73 | 70.00 | 14.27 |

Agreement (n = 4 system reports per dimension):

| dimension | Pearson | Spearman | MAE |
|---|---:|---:|---:|
| comprehensiveness | 0.975 | 1.00 | 14.27 |
| insight | 0.904 | 1.00 | 14.58 |
| instruction_following | -0.082 | 0.20 | 7.17 |
| readability | -0.203 | 0.20 | 21.27 |
| overall | 0.854 | 1.00 | 11.16 |

Human-human baseline for the same task: mean absolute difference **10.83**
points overall, mean pairwise Pearson **0.928**.

So on this task the judge reproduced the human ranking exactly (Spearman 1.0)
and its overall error (11.16) is in the same range as disagreement between two
human annotators (10.83). It scored every report 7-16 points below the humans,
and it is systematically harsher on readability (formatted Markdown with tables
scores lower than the human annotators gave).

## Addendum: drsh on the same task (deepseek-v4.1-flash generator)

drsh 0.38.1 ran task 1 with `deepseek-v4.1-flash` (session-header proxy to
OpenCode Go) and Exa-backed search, producing a 25-source report with 43
verified / 4 unverified claims and `confidence: medium`. The same judge scored
it:

| system | judge | human |
|---|---:|---:|
| gemini-2.5-pro-deepresearch | 73.79 | 83.33 |
| openai-deepresearch | 62.61 | 79.00 |
| **drsh (deepseek-v4.1-flash)** | **56.40** | — |
| perplexity-Research | 55.73 | 70.00 |
| grok-deeper-search | 51.45 | 47.00 |

drsh dimensions: comprehensiveness 50.2, insight 58.9, instruction following
51.2, readability 70.5. Claim verification with web search: 8 supported,
2 partially supported, 0 unsupported of 10 sampled claims. Its weakest
rubric area is the one the task asks for: it refused to build a nine-stratum
table and substituted quintile/wealth-percentile proxies.

Caveat: here the judge and the generator are the same model, so the score is
not judge-independent. The four benchmark rows are not affected by this.

## Limits

- One task, four benchmark reports plus one drsh report. Per-dimension
  correlations over four points are unstable; `instruction_following` and
  `readability` have almost no spread and their correlations are meaningless
  at this n.
- Only the Chinese subset has human labels, so English reports can only be
  judged, not calibrated.
- Benchmark rows: single judge run, no repeats and no variance estimate; the
  judge scored from report text alone and did not verify citations.
- The drsh row shares the judge's model family and is therefore optimistic in
  an unknown direction; re-judge with a different model before comparing it
  to the human-scored rows.

## Files

- `render_pointwise.py` renders the official prompt for one task/system.
- `score.py` applies the official weights and prints per-dimension and total
  scores.
- `compare.py` joins judge output with `human_RACE.jsonl` and prints
  correlations, MAE and both rankings.
- `judged/` holds the raw judge JSON per system.
