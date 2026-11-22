#!/usr/bin/env python3
"""Judge one arbitrary report against a DeepResearch Bench task's criteria.

Same protocol as judge_corpus.py (official point-wise RACE prompt, official
weights) but the article comes from a file, so a system that is not part of the
benchmark — drsh, or a local extension — can be scored on the same scale.

  python3 judge_one.py --id 1 --article run1/<report>.md --label drsh
"""

import argparse
import json
import pathlib
import sys

sys.path.insert(0, "/home/ayanp/research/drb")
import judge_corpus as jc  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, required=True)
    ap.add_argument("--article", required=True)
    ap.add_argument("--label", required=True)
    args = ap.parse_args()

    query = jc.QUERIES[args.id]
    criteria = jc.CRITERIA[args.id]
    article = pathlib.Path(args.article).read_text()
    criteria_list = json.dumps(
        {
            dim: [{"criterion": i["criterion"], "explanation": i["explanation"]} for i in items]
            for dim, items in criteria["criterions"].items()
        },
        ensure_ascii=False,
        indent=2,
    )
    template = jc.rp.ZH if query["language"] == "zh" else jc.rp.EN
    prompt = template.format(
        task_prompt=query["prompt"], article=article, criteria_list=criteria_list
    )

    text, finish = jc.call(prompt)
    jc.RAW.mkdir(parents=True, exist_ok=True)
    (jc.RAW / f"task{args.id}-{args.label}.txt").write_text(text)
    parsed, how = jc.parse_scores(text, args.id)
    jc.JUDGED.mkdir(parents=True, exist_ok=True)
    (jc.JUDGED / f"task{args.id}-{args.label}.json").write_text(json.dumps(parsed, ensure_ascii=False))
    dims, total = jc.weighted(parsed, args.id)
    print(
        json.dumps(
            {
                "label": args.label,
                "task": args.id,
                "total_0_100": round(total * 10, 2),
                "dims_0_100": {k: round(v * 10, 2) for k, v in dims.items()},
                "parse": how,
                "finish": finish,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
