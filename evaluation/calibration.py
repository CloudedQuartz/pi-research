#!/usr/bin/env python3
"""Calibration check: how well does a fitted judge->human line generalise?

Fits human = a + b*judge on judged DeepResearch Bench reports and reports the
error in-sample, by leave-one-out, and by k-fold cross-validation split by task
(repeated shuffles), so a report's own task never appears in its training fold.

  python3 calibration.py            # uses corpus/judged/*
"""

import collections
import json
import pathlib
import random
import sys
from statistics import mean, stdev

sys.path.insert(0, "/home/ayanp/research/drb")
import judge_corpus as jc  # noqa: E402

DATA = pathlib.Path("/home/ayanp/research/drb")


def fit(pairs):
    mx = mean(p[1] for p in pairs)
    my = mean(p[2] for p in pairs)
    slope = sum((x - mx) * (y - my) for _, x, y in pairs) / sum((x - mx) ** 2 for _, x, _ in pairs)
    return my - slope * mx, slope


def load():
    rows = []
    for path in sorted((DATA / "corpus" / "judged").glob("task*-*.json")):
        stem = path.stem
        task = int(stem[4 : stem.index("-")])
        system = stem[stem.index("-") + 1 :]
        if system.startswith("drsh"):
            continue
        _, total = jc.weighted(json.loads(path.read_text()), task)
        rows.append((task, total * 10, jc.human_means(task, system)["overall"]))
    return rows


def main() -> None:
    rows = load()
    tasks = sorted({r[0] for r in rows})
    a, b = fit(rows)
    raw = mean(abs(x - y) for _, x, y in rows)
    print(f"reports {len(rows)}  tasks {len(tasks)}")
    print(f"fit human = {a:.1f} + {b:.3f} * judge")
    print(f"raw MAE            {raw:.2f}")
    print(f"in-sample MAE      {mean(abs(a + b * x - y) for _, x, y in rows):.2f}")

    loo = []
    for i, row in enumerate(rows):
        ai, bi = fit(rows[:i] + rows[i + 1 :])
        loo.append(abs(ai + bi * row[1] - row[2]))
    print(f"leave-one-out MAE  {mean(loo):.2f}")

    for k in (5, 10):
        maes, slopes = [], []
        for seed in range(20):
            order = tasks[:]
            random.Random(seed).shuffle(order)
            folds = [order[i::k] for i in range(k)]
            errs = []
            for fold in folds:
                test = [r for r in rows if r[0] in fold]
                train = [r for r in rows if r[0] not in fold]
                af, bf = fit(train)
                slopes.append(bf)
                errs.extend(abs(af + bf * x - y) for _, x, y in test)
            maes.append(mean(errs))
        print(
            f"{k}-fold by task x20 MAE {mean(maes):.2f} ± {stdev(maes):.2f} "
            f"(slope {mean(slopes):.3f} ± {stdev(slopes):.3f})"
        )


if __name__ == "__main__":
    main()
