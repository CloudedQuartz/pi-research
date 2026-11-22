#!/usr/bin/env python3
"""Render the official DeepResearch Bench point-wise RACE judge input.

Uses the upstream point_wise_score_prompt template (EN or ZH), the task prompt,
one generated report, and the official per-criterion list. Weights stay
withheld from the judge, as upstream does.
"""

import argparse
import json
import pathlib

DATA = pathlib.Path("/home/ayanp/research/drb")
SYSTEMS = [
    "openai-deepresearch",
    "gemini-2.5-pro-deepresearch",
    "grok-deeper-search",
    "perplexity-Research",
]

EN = """<system_role>You are a strict, meticulous, and objective research article evaluation expert.
You score an article against specific assessment criteria, giving precise scores and clear justifications.</system_role>

**Task Background**
<task>
"{task_prompt}"
</task>

**Article to Evaluate**
<target_article>
"{article}"
</target_article>

**Evaluation Criteria**
<criteria_list>
{criteria_list}
</criteria_list>

**Your Task**
Evaluate `<target_article>` strictly against each criterion: analyse how well the
article meets it, then score 0-10 (continuous).
0-2 very poor, 2-4 poor, 4-6 average, 6-8 good, 8-10 excellent.

**Output format**
Return one JSON object and nothing else:

{{
  "comprehensiveness": [{{"criterion": "...", "analysis": "...", "target_score": 0.0}}],
  "insight": [...],
  "instruction_following": [...],
  "readability": [...]
}}

Copy each criterion string exactly as given. Escape quotes so the JSON parses.
"""

ZH = """<system_role>你是一名严格、细致、客观的调研文章评估专家。你擅长根据具体的评估标准，对调研文章进行深入评估，并给出精确的评分和清晰的理由。</system_role>

<user_prompt>
**任务背景**
有一个深度调研任务，你需要评估针对该任务撰写的一篇调研文章。
<task>
"{task_prompt}"
</task>

**待评估文章**
<target_article>
"{article}"
</target_article>

**评估标准**
<criteria_list>
{criteria_list}
</criteria_list>

**你的任务**
请严格按照 `<criteria_list>` 中的每一条标准评估 `<target_article>`，逐条分析后打分（0-10 连续分数）。
0-2 很差，2-4 较差，4-6 中等，6-8 较好，8-10 出色。

**输出格式要求**
只输出一个 JSON 对象，不要包含其他内容：

{{
  "comprehensiveness": [{{"criterion": "标准原文", "analysis": "分析", "target_score": 0.0}}],
  "insight": [...],
  "instruction_following": [...],
  "readability": [...]
}}

criterion 字段必须与给定标准原文完全一致，并确保 JSON 可解析。
</user_prompt>
"""


def load_jsonl(name: str) -> list[dict]:
    with (DATA / name).open() as fh:
        return [json.loads(line) for line in fh]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, required=True)
    ap.add_argument("--system", choices=SYSTEMS)
    ap.add_argument("--article", help="judge this file instead of a bundled report")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    query = next(r for r in load_jsonl("query.jsonl") if r["id"] == args.id)
    criteria = next(r for r in load_jsonl("criteria.jsonl") if r["id"] == args.id)
    if args.article:
        article = pathlib.Path(args.article).read_text()
    elif args.system:
        article = next(r for r in load_jsonl(f"{args.system}.jsonl") if r["id"] == args.id)["article"]
    else:
        raise SystemExit("--system or --article is required")

    criteria_list = json.dumps(
        {
            dim: [{"criterion": i["criterion"], "explanation": i["explanation"]} for i in items]
            for dim, items in criteria["criterions"].items()
        },
        ensure_ascii=False,
        indent=2,
    )

    template = ZH if query["language"] == "zh" else EN
    rendered = template.format(
        task_prompt=query["prompt"],
        article=article,
        criteria_list=criteria_list,
    )
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(rendered)
    print(
        f"task {args.id} ({query['language']}) {args.system or args.article}: {out} "
        f"({len(rendered)} chars)"
    )


if __name__ == "__main__":
    main()
