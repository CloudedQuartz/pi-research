#!/usr/bin/env python3
"""Agreement report for the judged DeepResearch Bench corpus.

Reads corpus/scores.jsonl (judge score vs three-annotator mean per report) and
prints pooled agreement, per-dimension agreement, per-task ranking accuracy,
and the human-human ceiling on the same reports.
"""

import collections
import json
import pathlib
from statistics import mean

DATA = pathlib.Path("/home/ayanp/research/drb")
DIMS = ["comprehensiveness", "insight", "instruction_following", "readability"]


def pearson(xs, ys):
    mx, my = mean(xs), mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    return num / den if den else float("nan")


def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    out = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out


def spearman(xs, ys):
    return pearson(ranks(xs), ranks(ys))


def main():
    rows = [json.loads(line) for line in (DATA / "corpus" / "scores.jsonl").open()]
    if not rows:
        raise SystemExit("corpus/scores.jsonl is empty")

    judge = [r["judge_total_0_10"] * 10 for r in rows]
    human = [r["human_overall"] for r in rows]

    by_task = collections.defaultdict(list)
    for r in rows:
        by_task[r["task"]].append(r)

    hits, gaps = 0, []
    for task, items in by_task.items():
        if len(items) < 2:
            continue
        j = [i["judge_total_0_10"] for i in items]
        h = [i["human_overall"] for i in items]
        if spearman(j, h) == 1.0:
            hits += 1
        gaps.append(
            {
                "task": task,
                "judge_gap": round((max(j) - min(j)) * 10, 1),
                "human_gap": round(max(h) - min(h), 1),
            }
        )

    human_diffs = []
    ann = collections.defaultdict(list)
    for line in (DATA / "human_RACE.jsonl").open():
        row = json.loads(line)
        ann[row["id"]].append(row)
    for r in rows:
        annotators = ann[r["task"]]
        for i in range(len(annotators)):
            for k in range(i + 1, len(annotators)):
                a, b = annotators[i], annotators[k]
                human_diffs.append(abs(a["overall_scores"][r["system"]] - b["overall_scores"][r["system"]]))

    report = {
        "reports": len(rows),
        "tasks": len(by_task),
        "pooled": {
            "pearson": round(pearson(judge, human), 3),
            "spearman": round(spearman(judge, human), 3),
            "mae": round(mean(abs(a - b) for a, b in zip(judge, human)), 2),
            "judge_mean": round(mean(judge), 2),
            "human_mean": round(mean(human), 2),
        },
        "per_dimension": {
            d: {
                "pearson": round(pearson([r["judge_dims_0_10"][d] * 10 for r in rows], [r["human_dims"][d] for r in rows]), 3),
                "mae": round(mean(abs(r["judge_dims_0_10"][d] * 10 - r["human_dims"][d]) for r in rows), 2),
            }
            for d in DIMS
        },
        "task_ranking": {
            "tasks_with_two_reports": len(gaps),
            "judge_matched_human_order": hits,
            "accuracy": round(hits / len(gaps), 3) if gaps else None,
        },
        "human_human": {
            "annotator_pairs": len(human_diffs),
            "mae": round(mean(human_diffs), 2),
        },
        "parse_paths": collections.Counter(r["parse"] for r in rows),
        "gap_examples": sorted(gaps, key=lambda g: g["judge_gap"] - g["human_gap"])[:3]
        + sorted(gaps, key=lambda g: g["judge_gap"] - g["human_gap"])[-3:],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, default=dict))


if __name__ == "__main__":
    main()
