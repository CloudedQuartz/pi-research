#!/usr/bin/env python3
"""Compare judge RACE scores with the benchmark's human annotations.

Human labels live in human_RACE.jsonl (3 annotators per Chinese task, 0-100 per
dimension plus an overall score). Judge output is one JSON file per system,
scored with score.py (0-10 per criterion -> weighted dimension score).

Outputs per-dimension Pearson r, Spearman rho and mean absolute error between
judge and mean-human scores, plus the human-human baseline.
"""

import argparse
import json
import pathlib
import subprocess
import sys
from statistics import mean

DATA = pathlib.Path("/home/ayanp/research/drb")
SYSTEMS = [
    "openai-deepresearch",
    "gemini-2.5-pro-deepresearch",
    "grok-deeper-search",
    "perplexity-Research",
]
DIM_MAP = {
    "comprehensiveness": "Comprehensiveness",
    "insight": "depth",
    "instruction_following": "instruction following",
    "readability": "readability",
}


def pearson(xs: list[float], ys: list[float]) -> float:
    mx, my = mean(xs), mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
    return num / den if den else float("nan")


def ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            r[order[k]] = avg
        i = j + 1
    return r


def spearman(xs: list[float], ys: list[float]) -> float:
    return pearson(ranks(xs), ranks(ys))


def scored(system: str, task_id: int, judged_dir: pathlib.Path) -> dict:
    path = judged_dir / f"task{task_id}-{system}.json"
    if not path.exists():
        return {}
    out = subprocess.run(
        [sys.executable, str(DATA / "score.py"), "--id", str(task_id), "--judge", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, required=True)
    ap.add_argument("--judged-dir", default=str(DATA / "judged"))
    args = ap.parse_args()

    judged_dir = pathlib.Path(args.judged_dir)
    rows = [json.loads(line) for line in (DATA / "human_RACE.jsonl").open()]
    anns = [r for r in rows if r["id"] == args.id]
    if not anns:
        raise SystemExit(f"no human annotations for task {args.id}")

    report: dict = {"id": args.id, "annotators": len(anns), "systems": {}}
    for system in SYSTEMS:
        j = scored(system, args.id, judged_dir)
        if not j:
            continue
        human_dims = {
            d: mean(a["dimension_scores"][system][h] for a in anns) for d, h in DIM_MAP.items()
        }
        human_overall = mean(a["overall_scores"][system] for a in anns)
        judge_dims = {d: j["target"]["dims"].get(d, 0.0) * 10 for d in DIM_MAP}
        report["systems"][system] = {
            "judge_dims_0_100": {d: round(v, 2) for d, v in judge_dims.items()},
            "human_dims_0_100": {d: round(v, 2) for d, v in human_dims.items()},
            "judge_total_0_100": round(j["target"]["total_0_10"] * 10, 2),
            "human_overall": round(human_overall, 2),
            "dims": {
                d: {
                    "judge": round(judge_dims[d], 2),
                    "human": round(human_dims[d], 2),
                    "abs_err": round(abs(judge_dims[d] - human_dims[d]), 2),
                }
                for d in DIM_MAP
            },
        }

    systems = list(report["systems"])
    if len(systems) >= 2:
        report["agreement"] = {}
        for d in DIM_MAP:
            js = [report["systems"][s]["judge_dims_0_100"][d] for s in systems]
            hs = [report["systems"][s]["human_dims_0_100"][d] for s in systems]
            report["agreement"][d] = {
                "pearson": round(pearson(js, hs), 3),
                "spearman": round(spearman(js, hs), 3),
                "mae": round(mean(abs(a - b) for a, b in zip(js, hs)), 2),
            }
        js = [report["systems"][s]["judge_total_0_100"] for s in systems]
        hs = [report["systems"][s]["human_overall"] for s in systems]
        report["agreement"]["overall"] = {
            "pearson": round(pearson(js, hs), 3),
            "spearman": round(spearman(js, hs), 3),
            "mae": round(mean(abs(a - b) for a, b in zip(js, hs)), 2),
        }
        report["system_ranking"] = {
            "judge": [s for s in sorted(systems, key=lambda s: -report["systems"][s]["judge_total_0_100"])],
            "human": [s for s in sorted(systems, key=lambda s: -report["systems"][s]["human_overall"])],
        }

        # Human-human baseline: annotator pairs, absolute MAE and rank agreement.
        if len(anns) >= 2:
            pair_mae, pair_corr = [], []
            for a_i in range(len(anns)):
                for b_i in range(a_i + 1, len(anns)):
                    a, b = anns[a_i], anns[b_i]
                    av = [a["overall_scores"][s] for s in systems]
                    bv = [b["overall_scores"][s] for s in systems]
                    pair_mae.append(mean(abs(x - y) for x, y in zip(av, bv)))
                    pair_corr.append(pearson(av, bv))
            report["human_human"] = {
                "pairs": len(pair_mae),
                "mean_abs_diff_overall": round(mean(pair_mae), 2),
                "mean_pearson_overall": round(mean(pair_corr), 3),
            }

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
