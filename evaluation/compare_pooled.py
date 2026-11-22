#!/usr/bin/env python3
"""Pool judge-vs-human agreement across several DeepResearch Bench tasks.

Reuses score.py for the official weighting, joins with human_RACE.jsonl, and
reports:
- pooled Pearson / Spearman / MAE over every (task, system) report pair
- per-task rank agreement (does the judge order systems as the humans do)
- the human-human baseline (annotator pairs) on the same reports
- per-dimension pooled statistics
"""

import json
import pathlib
import subprocess
import sys
from collections import defaultdict
from statistics import mean

DATA = pathlib.Path("/home/ayanp/research/drb")
TASKS = [1, 29, 20, 9, 41, 48]
DIM_MAP = {
    "comprehensiveness": "Comprehensiveness",
    "insight": "depth",
    "instruction_following": "instruction following",
    "readability": "readability",
}


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


def score(task_id, system):
    path = DATA / "judged" / f"task{task_id}-{system}.json"
    if not path.exists():
        return None
    out = subprocess.run(
        [sys.executable, str(DATA / "score.py"), "--id", str(task_id), "--judge", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)


def main() -> None:
    rows = [json.loads(line) for line in (DATA / "human_RACE.jsonl").open()]
    by_task = defaultdict(list)
    for row in rows:
        by_task[row["id"]].append(row)

    pairs = []          # (task, system, judge_total, human_overall)
    dim_pairs = defaultdict(list)
    rank_hits = []
    human_pair_diffs = []
    human_pair_corrs = []

    for task_id in TASKS:
        anns = by_task.get(task_id) or []
        if not anns:
            continue
        judged = {}
        for path in sorted((DATA / "judged").glob(f"task{task_id}-*.json")):
            system = path.stem[len(f"task{task_id}-") :]
            scored = score(task_id, system)
            if not scored:
                continue
            human_overall = mean(a["overall_scores"][system] for a in anns)
            judge_total = scored["target"]["total_0_10"] * 10
            judged[system] = (judge_total, human_overall)
            pairs.append((task_id, system, judge_total, human_overall))
            for dim, human_key in DIM_MAP.items():
                judge_dim = scored["target"]["dims"].get(dim, 0.0) * 10
                human_dim = mean(a["dimension_scores"][system][human_key] for a in anns)
                dim_pairs[dim].append((judge_dim, human_dim))

        # Rank agreement within a task (all judged systems for that task).
        systems = list(judged)
        if len(systems) >= 2:
            j = [judged[s][0] for s in systems]
            h = [judged[s][1] for s in systems]
            rank_hits.append(1.0 if spearman(j, h) == 1.0 else 0.0)

        # Human-human baseline over the same systems.
        if len(anns) >= 2 and len(systems) >= 2:
            for i in range(len(anns)):
                for k in range(i + 1, len(anns)):
                    a, b = anns[i], anns[k]
                    av = [a["overall_scores"][s] for s in systems]
                    bv = [b["overall_scores"][s] for s in systems]
                    human_pair_diffs.extend(abs(x - y) for x, y in zip(av, bv))
                    human_pair_corrs.append(pearson(av, bv))

    js = [p[2] for p in pairs]
    hs = [p[3] for p in pairs]
    report = {
        "tasks": sorted({p[0] for p in pairs}),
        "pairs": len(pairs),
        "pooled": {
            "pearson": round(pearson(js, hs), 3),
            "spearman": round(spearman(js, hs), 3),
            "mae": round(mean(abs(a - b) for a, b in zip(js, hs)), 2),
            "judge_mean": round(mean(js), 2),
            "human_mean": round(mean(hs), 2),
        },
        "per_dimension": {
            dim: {
                "pearson": round(pearson([p[0] for p in v], [p[1] for p in v]), 3),
                "mae": round(mean(abs(a - b) for a, b in v), 2),
            }
            for dim, v in dim_pairs.items()
        },
        "rank_agreement": {
            "tasks_with_2plus_reports": len(rank_hits),
            "perfect_task_rankings": int(sum(rank_hits)),
        },
        "human_human": {
            "pairs": len(human_pair_diffs),
            "mae": round(mean(human_pair_diffs), 2) if human_pair_diffs else None,
            "mean_pearson_within_task": round(mean(human_pair_corrs), 3)
            if human_pair_corrs
            else None,
        },
        "rows": [
            {
                "task": t,
                "system": s,
                "judge": round(j, 2),
                "human": round(h, 2),
                "err": round(abs(j - h), 2),
            }
            for t, s, j, h in sorted(pairs)
        ],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
