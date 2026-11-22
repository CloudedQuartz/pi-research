#!/usr/bin/env python3
"""Score a DeepResearch Bench RACE judge result with the official weights.

Mirrors utils/score_calculator.py from Ayanami0730/deep_research_bench:
per-dimension score is the weighted mean of its criterion scores, the total is
the dimension-weight-weighted sum, and the relative score is
target / (target + reference).
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


def weighted_dimension(scores_and_weights: list[tuple[float, float]]) -> float:
    total_weight = sum(w for _, w in scores_and_weights)
    if total_weight == 0:
        raise SystemExit("zero weight")
    return sum(s * w for s, w in scores_and_weights) / total_weight


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, required=True)
    ap.add_argument("--judge", required=True)
    args = ap.parse_args()

    criteria = load_by_id("criteria.jsonl", args.id)
    judged = json.loads(pathlib.Path(args.judge).read_text())

    weights = criteria["dimension_weight"]
    criterion_weights = {
        dim: {item["criterion"]: item["weight"] for item in items}
        for dim, items in criteria["criterions"].items()
    }

    target_dims: dict[str, float] = {}
    reference_dims: dict[str, float] = {}
    unmatched: list[str] = []

    for dim, items in judged.items():
        if dim not in weights or dim not in criterion_weights:
            continue
        dim_weights = criterion_weights[dim]
        tgt, ref = [], []
        for item in items:
            text = (item.get("criterion") or "").strip()
            weight = dim_weights.get(text)
            if weight is None:
                for key, val in dim_weights.items():
                    if text.lower() in key.lower() or key.lower() in text.lower():
                        weight = val
                        break
            if weight is None:
                unmatched.append(f"{dim}:{text[:60]}")
                weight = sum(dim_weights.values()) / len(dim_weights)
            if item.get("article_1_score") is not None:
                tgt.append((float(item["article_1_score"]), weight))
            elif item.get("target_score") is not None:
                tgt.append((float(item["target_score"]), weight))
            if item.get("article_2_score") is not None:
                ref.append((float(item["article_2_score"]), weight))
        if tgt:
            target_dims[dim] = weighted_dimension(tgt)
        if ref:
            reference_dims[dim] = weighted_dimension(ref)

    def total(dims: dict[str, float]) -> float:
        present = [(dims[d], weights[d]) for d in dims]
        denom = sum(w for _, w in present)
        return sum(s * w for s, w in present) / denom if denom else 0.0

    tgt_total = total(target_dims)
    ref_total = total(reference_dims)
    result = {
        "id": args.id,
        "target": {"dims": target_dims, "total_0_10": round(tgt_total, 4)},
        "reference": {"dims": reference_dims, "total_0_10": round(ref_total, 4)},
        "relative": round(tgt_total / (tgt_total + ref_total), 4)
        if (reference_dims and (tgt_total + ref_total))
        else None,
        "unmatched_criteria": unmatched,
        "claim_checks": judged.get("claim_checks", []),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
