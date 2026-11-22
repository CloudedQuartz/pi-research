# Evaluation package

This directory contains the DeepResearch Bench point-wise RACE judge, calibration scripts, official inputs, raw/parsed judge outputs, and the completed project runs. See [METHODOLOGY.md](METHODOLOGY.md) for the protocol and validation and [RESULTS.md](RESULTS.md) for the original pilot. The project reports and scores for tasks 19 and 20 are in [results/](results/).

The evaluator uses DeepSeek V4.1 Flash through `opencode_proxy.mjs`. Set `JUDGE_KEY` in the environment before running `judge_one.py --id N --article REPORT --label SYSTEM` or `judge_corpus.py`. The source is preserved as run; if running from another machine, replace the original `/home/ayanp/research/drb` data root with this `evaluation/` directory in the scripts that reference it. No credentials are included.

The benchmark inputs are redistributed from the [DeepResearch Bench dataset](https://huggingface.co/datasets/muset-ai/DeepResearch-Bench-Dataset), listed there under Apache-2.0. For the separate BrowseComp-Plus retrieval evaluation, see the submission report for metrics and the submission ZIP for the pinned corpus/query sources. The full BrowseComp-Plus corpus is not included.
