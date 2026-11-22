#!/usr/bin/env python3
"""Recover a RACE judgment whose analysis text breaks strict JSON parsing.

Some judge replies are complete but contain unescaped quotes inside `analysis`,
so json.loads fails. The scores and their order are still intact, and the
prompt requires one entry per criterion in the listed order, so this pairs the
n-th `target_score` in a dimension with the n-th criterion from criteria.jsonl.
It refuses to write unless the counts match exactly.
"""

import argparse
import json
import pathlib
import re

DATA = pathlib.Path("/home/ayanp/research/drb")
DIMS = ["comprehensiveness", "insight", "instruction_following", "readability"]


def extract_scores(text: str) -> dict[str, list[float]]:
    bounds = []
    for dim in DIMS:
        match = re.search(rf'"{dim}"\s*:\s*\[', text)
        bounds.append((dim, match.start() if match else -1))
    out: dict[str, list[float]] = {}
    for i, (dim, start) in enumerate(bounds):
        if start < 0:
            out[dim] = []
            continue
        end = bounds[i + 1][1] if i + 1 < len(bounds) and bounds[i + 1][1] > start else len(text)
        out[dim] = [float(x) for x in re.findall(r'"target_score"\s*:\s*([0-9]+(?:\.[0-9]+)?)', text[start:end])]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", type=int, required=True)
    ap.add_argument("--system", required=True)
    ap.add_argument("--raw", required=True, help="file holding the raw judge reply")
    args = ap.parse_args()

    text = pathlib.Path(args.raw).read_text()
    criteria = next(
        json.loads(line) for line in (DATA / "criteria.jsonl").open() if json.loads(line)["id"] == args.task
    )
    scores = extract_scores(text)

    rebuilt = {}
    for dim in DIMS:
        items = criteria["criterions"][dim]
        got = scores.get(dim, [])
        if len(got) != len(items):
            raise SystemExit(f"{dim}: {len(got)} scores for {len(items)} criteria — refusing")
        rebuilt[dim] = [
            {"criterion": item["criterion"], "analysis": "", "target_score": score}
            for item, score in zip(items, got)
        ]

    out = DATA / "judged" / f"task{args.task}-{args.system}.json"
    out.write_text(json.dumps(rebuilt, ensure_ascii=False))
    print(f"{out.name}: recovered {sum(len(v) for v in rebuilt.values())} criterion scores")


if __name__ == "__main__":
    main()
