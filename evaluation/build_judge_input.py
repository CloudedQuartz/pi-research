#!/usr/bin/env python3
"""Render the DeepResearch Bench RACE judge input for one task.

The protocol follows Ayanami0730/deep_research_bench: task prompt, the target
article, the benchmark's reference article, and the official per-criterion
list. Per-criterion weights are withheld from the judge, matching the upstream
format_criteria_list(). A claim-verification section is appended because the
judge runs with web search tools; it is scored separately from RACE.
"""

import argparse
import json
import pathlib

DATA = pathlib.Path("/home/ayanp/research/drb")


def load_by_id(name: str, task_id: int) -> dict:
    with (DATA / name).open() as fh:
        for line in fh:
            row = json.loads(line)
            if row.get("id") == task_id:
                return row
    raise SystemExit(f"id {task_id} not found in {name}")


def criteria_for_judge(criteria: dict) -> str:
    out = {}
    for dim, items in criteria["criterions"].items():
        out[dim] = [
            {"criterion": i["criterion"], "explanation": i["explanation"]} for i in items
        ]
    return json.dumps(out, ensure_ascii=False, indent=2)


TEMPLATE = """<system_role>You are a strict, meticulous, and objective research article
evaluation expert. You compare two articles on the same task, score every
criterion, and verify cited claims against the live web.</system_role>

**Task Background**
<task>
{task_prompt}
</task>

**Articles to Evaluate**
<article_1>
{article_1}
</article_1>

<article_2>
{article_2}
</article_2>

**Evaluation Criteria**
<criteria_list>
{criteria_list}
</criteria_list>

**Your Task**
1. Analyse each criterion for both articles and score each on a continuous
   0-10 scale (0-2 very poor, 2-4 poor, 4-6 average, 6-8 good, 8-10 excellent).
2. Then verify factual claims from article_1 with your search and fetch tools.
   Pick up to 10 claims that carry a citation or a concrete number. For each,
   open the cited source or search for an authoritative one and record whether
   it supports the claim. Do not score article_2's claims.

**Output format**
Return one JSON object and nothing else. Use `article_1_score` for the
article under `<article_1>` and `article_2_score` for `<article_2>`:

{{
  "comprehensiveness": [
    {{"criterion": "...", "analysis": "...", "article_1_score": 0.0, "article_2_score": 0.0}}
  ],
  "insight": [...],
  "instruction_following": [...],
  "readability": [...],
  "claim_checks": [
    {{"claim": "...", "cited_source": "...", "verdict": "supported|partially_supported|unsupported|unverifiable", "evidence_url": "...", "note": "..."}}
  ]
}}

Escape quotes so the JSON parses. Copy each criterion string exactly as given.
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, required=True)
    ap.add_argument("--article", required=True, help="path to the target article")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    query = load_by_id("query.jsonl", args.id)
    criteria = load_by_id("criteria.jsonl", args.id)
    reference = load_by_id("reference.jsonl", args.id)
    article = pathlib.Path(args.article).read_text()

    rendered = TEMPLATE.format(
        task_prompt=query["prompt"],
        article_1=article,
        article_2=reference["article"],
        criteria_list=criteria_for_judge(criteria),
    )
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(rendered)
    print(
        f"task {args.id}: {out} ({len(rendered)} chars, "
        f"target {len(article)}, reference {len(reference['article'])})"
    )


if __name__ == "__main__":
    main()
