# Sandbox runs: what the extension produced

Three questions of different shapes, all run in the isolated sandbox
(`PI_CODING_AGENT_DIR=/tmp/sandbox/agent`, package installed with `pi install` from
a clean copy at `/tmp/sandbox/pkg`, provider `opencode-go/deepseek-v4.1-flash`).
Artifacts are in `/tmp/sandbox/work/research/`.

## Measurements

| Run | Shape | Wall | Rounds | Sources | Passages | Citations | Unresolved | Prose | Evidence | Failures | Inspections |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A · non-revenue water | definitional | 444 s | 4 | 8 | 27 | 47 | 0 | 7.1 KB | 16.7 KB | 12 | 19 |
| B · three leak-detection methods | comparative + numeric | 1350 s | 2 | 21 | 45 | 131 | 0 | 17.5 KB | 41.6 KB | 21 | 16 |
| C · three investors (benchmark task 52) | comparative, benchmark | 1043 s | 1 | 21 | 60 | 218 | 0 | 28.9 KB | 53.0 KB | 8 | 7 |

All three stopped because "the assessment found evidence for every essential research
need". No report left a citation unresolved.

## What it cost

Pi records per-message usage, so these are measured, not estimated:

| Run | Model calls | Input tokens | Output tokens | Cost |
|---|---:|---:|---:|---:|
| A · non-revenue water | 20 | 76,259 | 18,894 | $0.0234 |
| B · leak methods (aborted first attempt) | 4 | 22,727 | 2,324 | $0.0048 |
| C · three investors (task 52) | 11 | 101,482 | 24,687 | $0.0305 |
| B · leak methods (completed) | 8 | 85,734 | 16,946 | $0.0235 |
| **Total** | **43** | **286,202** | **62,851** | **$0.0822** |

Caveats: delegated agents run in their own sessions and this installation did not
persist those files, so their share of the tokens is not in the totals above — the
figure is a floor, not the full bill. The judge call is separate: `judge_one.py`
prints only scores, so its usage was not captured; it is one request against
`deepseek-v4.1-flash`.

## What the runs got right

- **Structure follows the question.** A opens with the water balance and splits real
  from apparent losses; B leads with "pressure management has the most credible
  measured reduction in this evidence set" and then a "how comparable are the
  numbers?" section; C gives three separate philosophies and a "three real
  differences" comparison. None is a generic essay.
- **Hedging is tied to evidence.** A and C state a confidence level explicitly. B
  says which of the three approaches has the *weakest* support (satellite, mostly
  vendor numbers), which is the honest reading of that literature.
- **Citation discipline holds under volume.** 396 citations across the three reports,
  zero unresolved, quotes bounded.
- **Delegation contributes.** B and C each pulled 2 pages through delegated agents
  (3 and 5 passages respectively), which then appeared in the corpus.

## What is wrong or weak

- **Fetch failures are the dominant defect, not reasoning.** 12/21/8 failures per run,
  almost all `HTTP 403` bot walls or documents whose parse produced no text. On B, 21
  failures against 21 successes is a coin flip; the report is built from half the
  candidate set it wanted. Two of these have since changed: a walled page is marked
  `[blocked]` in the journal and the round line (`13 failed (2 blocked)`), and a
  document whose direct download is refused now gets one attempt through the fetch
  tool before it counts as lost (`854a370`).
- **Length is driven by citations, not prose.** Evidence is 2.3×, 2.4× and 1.8× the
  prose. With 218 citations in C, the appendix dominates the file (53 KB vs 29 KB).
- **One round can be enough, and that is suspicious.** C stopped after a single round
  with six essential needs "answered", judged at 99.2 for instruction following — but
  a one-round answer to a three-person comparison was built from 60 passages without a
  second pass to close gaps. The stop rule trusts the assessor.
- **A reader still cannot see what was missed.** The `[blocked]` marker reaches the
  journal and the gap list the report is written from, but the saved report itself does
  not state "12 candidate sources were refused"; that remains the journal's job.
- **`research-acquisition.ts` is mostly unwired** (see DECISIONS.md): the module
  that looks like it hardens acquisition is not in the fetch path, and robots is not
  enforced anywhere.

## Evaluation (part D)

The repo's harness (`evaluation/`, DeepResearch Bench point-wise RACE judge) was run
against the sandbox build:

```bash
# judge: deepseek-v4.1-flash through evaluation/opencode_proxy.mjs on 127.0.0.1:8787
JUDGE_KEY=… python3 /home/ayanp/research/drb/judge_one.py \
  --id 52 --article <sandbox report> --label pi-research
```

Result — task 52, official criteria and weights:

| dimension | score /100 |
|---|---:|
| comprehensiveness | 90.97 |
| insight | 91.55 |
| instruction following | 99.20 |
| readability | 89.45 |
| **total** | **92.32** |

Provenance: one English task (id 52), one judge call, judge = `deepseek-v4.1-flash`,
official point-wise prompt and weights from `score_prompt_en.py`.

### Limits of that number

- **The judge is the same model as the researcher** (deepseek-v4.1-flash). This is a
  self-judged score and should be read as an upper bound, not a benchmark placement.
  The earlier project notes flagged the same issue for the `drsh` row.
- **The prompt was not identical to the benchmark's.** The run was asked the official
  question plus "Compare their principles with concrete examples." A report answering
  a slightly larger task can score higher on comprehensiveness than the task asks for.
- **One task is not a benchmark.** The Chinese half of the dataset (tasks 1–50) was not
  run at all, and no human baseline exists for task 52 to compare against.
- The rest of the harness (calibration against 50 human-scored Chinese tasks,
  pooled comparison) needs the per-system corpus that was not re-run here.
