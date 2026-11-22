# Methodology: an LLM judge as a research-quality metric

Status: **final corpus — 100 judged reports across 50 tasks** (two human-best and
human-worst systems per task). Tables regenerate from `corpus_report.py` and
`calibration.py`; p-values are computed from those two outputs.

## 1. Question

Can a single LLM judge produce research-quality scores that are usable as a
metric, i.e. close enough to human expert judgement to compare systems on the
same task? And if so, in which form — absolute scores or relative comparison?

## 2. Data (all from DeepResearch Bench)

| file | contents |
|---|---|
| `query.jsonl` | 100 tasks (50 Chinese, 50 English) with full prompts |
| `criteria.jsonl` | official per-task rubrics: per-criterion text, explanation, weight; per-dimension weights |
| `human_RACE.jsonl` | 150 rows = 50 Chinese tasks × 3 human annotators, 0–100 per dimension + overall |
| `openai-deepresearch.jsonl`, `gemini-2.5-pro-deepresearch.jsonl`, `grok-deeper-search.jsonl`, `perplexity-Research.jsonl` | 100 generated reports per system |
| `reference.jsonl` | benchmark reference reports (unused in the point-wise protocol) |

Only the Chinese subset carries human labels, so the calibrated comparison is
Chinese-only by construction. English tasks can be judged but not validated.

## 3. Judge and protocol

- Judge model: `deepseek-v4.1-flash` through OpenCode Go's OpenAI-compatible
  endpoint (`https://opencode.ai/inference/go/openai/v1`), reached via
  `opencode_proxy.mjs`, which adds the required `x-opencode-session` header
  (§9). `temperature: 0`, `max_tokens: 12000`.
- Prompt: the benchmark's official **point-wise RACE** prompt
  (`prompt/score_prompt_zh.py`, both languages carried in
  `render_pointwise.py`). The judge sees the task prompt, one article, and the
  official criterion list. Per-criterion weights are withheld, matching the
  upstream `format_criteria_list()`.
- Scoring: reproduced from `utils/score_calculator.py` in `score.py` — dimension
  score is the weighted mean of its criterion scores, total is the
  dimension-weight-weighted sum, on a 0–10 scale (reported ×10).
- Selection: for each task the **human-best and human-worst** system are judged
  (maximal human separation), so every task yields a 2-report ranking test.
- Each report is one independent API call: no chat history, no other reports in
  context.

The drsh report is scored with the identical prompt and weights through
`judge_one.py`, with the article supplied from disk.

## 4. Metrics

- **Pooled Pearson / Spearman / MAE** over all (task, system) reports —
  judge total vs the three-annotator mean.
- **Within-task centered r**: subtract each task's judge mean and human mean,
  then correlate. This removes task difficulty and the judge's level bias, and
  measures whether the judge tracks the *difference* between systems.
- **Rank accuracy**: fraction of tasks where the judge orders the two systems
  as the humans do.
- **Per-dimension** Pearson and MAE on the same reports.
- **Human-human ceiling**: pairwise absolute difference between the task's three
  annotators on the same reports.
- **Calibration**: OLS fit `human = a + b·judge`, reported in-sample, by
  leave-one-out, and by k-fold cross-validation **split by task** (5- and
  10-fold, 20 shuffles each) so no report from a test task appears in the fit.
  A single half-task split is also reported to show how noisy one draw is.

Reproduce: `python3 judge_corpus.py --limit 50`, then `corpus_report.py`;
calibration figures from `calibration.py`.

## 5. Results (100 reports, 50 tasks)

| statistic | value | p |
|---|---:|---:|
| pooled Pearson | 0.462 | 1.3e-06 |
| pooled MAE | 13.71 | |
| mean judge vs human | 65.9 vs 72.3 (bias +6.4) | |
| within-task centered r | **0.690** (n = 100) | 2.1e-15 |
| rank accuracy | **44 / 50 tasks (0.880)** | 1.6e-08 (binomial) |

Per rubric dimension:

| dimension | Pearson | p | MAE |
|---|---:|---:|---:|
| comprehensiveness | 0.521 | 2.7e-08 | 14.23 |
| insight | 0.532 | 1.2e-08 | 17.37 |
| instruction following | 0.219 | 0.029 | 15.10 |
| readability | 0.286 | 0.004 | 11.40 |

## 5b. Calibration, fitted per rubric

The score is a weighted sum of four rubric dimensions, so the calibration is
fitted per dimension and the calibrated total is recomputed with the official
dimension weights:

| dimension | fitted line |
|---|---|
| comprehensiveness | `human = 47.6 + 0.413·judge` |
| insight | `human = 45.1 + 0.439·judge` |
| instruction following | `human = 64.2 + 0.157·judge` |
| readability | `human = 49.5 + 0.334·judge` |
| total (for reference) | `human = 44.6 + 0.420·judge` |

The instruction-following slope of 0.16 is the same weakness its correlation
shows: the judge barely separates reports on that dimension.

| calibration | k-fold MAE (by task) |
|---|---:|
| raw | 13.71 |
| one global line | 10.89 ± 0.08 |
| **per rubric dimension** | **10.72 ± 0.07** |
| comp+insight per dimension, rest raw | 11.17 ± 0.06 |
| quadratic | 11.11 ± 0.14 |
| isotonic | 12.80 ± 0.98 |

"k-fold" = 5-fold split **by task**, 15-20 shuffles; no report from a test task
trains the fit. The fair human ceiling for comparison is one annotator against
the three-annotator mean: **9.62** points.

A 20-point-band view of the raw judge shows why a straight line is used rather
than a curve: bands 20-40, 40-60, 60-80, 80-100 map to human means 63.0, 62.9,
78.0, 78.0 (n = 8, 30, 41, 21). The apparent curvature sits in thin end bands,
and flexible fits generalise worse (quadratic 11.11, isotonic 12.80).

**Calibration never changes the ranking.** Every fitted line is monotone, so
within-task order is identical before and after: 44/50 either way. Calibration
fixes the level, not the order.

## 6. Interpretation

The judge is a **ranking** instrument, not an absolute one.

- Within a task it recovers the human ordering 44/50 times (0.880, binomial
  p = 1.6e-08) and tracks the human score difference between systems (centered
  r 0.690, p = 2.1e-15).
- Across tasks it correlates only 0.46 and sits ~6 points low, so raw judge
  scores are **not** comparable between tasks.
- A per-rubric calibration transfers stably: k-fold by task gives MAE
  10.72 ± 0.07 against a 9.62-point annotator-vs-mean ceiling, improving every
  fold over the raw 13.71.
- Dimension-level scores are only trustworthy for comprehensiveness and insight;
  instruction-following and readability are compressed (slopes 0.16 and 0.33)
  and should not be quoted on their own.

## 7. How the judge is used here

1. Compare systems **on the same task**: report the score delta and the rank;
   quote rank accuracy and within-task r.
2. If an absolute number is needed, report it as *judge-scale*, with the
   calibration line and its holdout error, never as a human score.
3. Do not aggregate per-dimension scores for instruction-following or
   readability.

## 8. Threats to validity

- **One task family, one language.** Calibration exists only for 50 Chinese
  tasks; English reports are judged blind.
- **Single judge, single run.** No repeats, so no variance estimate; a second
  run would cost the same as the first.
- **Self-judging row.** The drsh report was generated by the same model that
  judged it, so its score is not judge-independent. The four benchmark systems
  are unaffected.
- **Text-only RACE pass.** The calibration judges did not verify citations. The
  drsh report was additionally checked by a search-enabled judge: 8 supported,
  2 partially supported of 10 sampled claims.
- **Formatting-sensitive prompt.** The judge's judgments include document
  formatting; unescaped quotes in some replies forced an order-based recovery
  path (`judge_corpus.py`), which was used for a minority of reports and is
  recorded per row as `parse`.
- **n is small.** 26 paired tasks; per-dimension correlations remain fragile.

## 9. Reproducing the plumbing

```
node opencode_proxy.mjs 8787        # OpenAI-compatible endpoint + session header
node exa_searxng.mjs 8788           # SearXNG-shaped search over keyless Exa MCP, for drsh
export SEARXNG_URL=http://127.0.0.1:8788
drsh -p "<question>" --reports <dir> --trace --silent
```

`judge_corpus.py` needs `JUDGE_KEY` (the OpenCode Go key) and calls the proxy;
`judge_one.py --id N --article <file> --label <name>` scores any report against
a task's official criteria.
