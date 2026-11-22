#!/usr/bin/env python3
"""
Official NIST trec_eval scoring for BrowseComp-Plus TREC run files using pytrec_eval
(pytrec-eval-terrier, wrapping NIST trec_eval).

Equivalent to:
  python -m pyserini.eval.trec_eval -c -m recall.5,100,1000 -m ndcg_cut.10 <qrels> <run>

Outputs both macro-averaged aggregate scores and per-query scores (for paired t-tests)
as JSON.
"""

import argparse
import json
import sys
import pytrec_eval


METRICS = {"recall_5", "recall_100", "recall_1000", "ndcg_cut_10"}


def load_qrels(path: str) -> dict[str, dict[str, int]]:
    qrels: dict[str, dict[str, int]] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            qid, _iter, docid, rel = line.split()
            qrels.setdefault(qid, {})[docid] = int(rel)
    return qrels


def load_run(path: str) -> dict[str, dict[str, float]]:
    run: dict[str, dict[str, float]] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            qid, _q0, docid, _rank, score, _tag = line.split()
            run.setdefault(qid, {})[docid] = float(score)
    return run


def evaluate_run(qrels_path: str, run_path: str) -> dict:
    qrels = load_qrels(qrels_path)
    run = load_run(run_path)
    evaluator = pytrec_eval.RelevanceEvaluator(qrels, METRICS)
    # Only pass queries present in qrels; missing queries get 0.0 (-c behavior)
    filtered_run = {qid: run.get(qid, {}) for qid in qrels}
    per_query = evaluator.evaluate(filtered_run)

    qids = sorted(qrels.keys(), key=lambda x: (int(x) if x.isdigit() else float("inf"), x))
    aggregate = {}
    for m in sorted(METRICS):
        vals = [per_query[qid][m] for qid in qids]
        aggregate[m] = sum(vals) / len(vals) if vals else 0.0

    return {
        "evaluator": "pytrec_eval (NIST trec_eval)",
        "queryCount": len(qids),
        "aggregate": aggregate,
        "aggregatePercent": {m: round(v * 100.0, 4) for m, v in aggregate.items()},
        "perQuery": {qid: per_query[qid] for qid in qids},
    }


def main():
    parser = argparse.ArgumentParser(description="Score TREC runs with pytrec_eval.")
    parser.add_argument("--evidence-qrels", required=True)
    parser.add_argument("--gold-qrels", required=True)
    parser.add_argument("--run", action="append", required=True, help="name=path pairs")
    parser.add_argument("--out", required=True, help="Output JSON path")
    args = parser.parse_args()

    results = {}
    for spec in args.run:
        if "=" not in spec:
            raise ValueError(f"--run must be name=path, got: {spec}")
        name, path = spec.split("=", 1)
        results[name] = {
            "runFile": path,
            "evidence": evaluate_run(args.evidence_qrels, path),
            "gold": evaluate_run(args.gold_qrels, path),
        }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"Scored {len(results)} run(s) -> {args.out}")


if __name__ == "__main__":
    main()
