#!/usr/bin/env python3
"""Judge DeepResearch Bench reports with deepseek-v4.1-flash, in bulk.

Calls the OpenAI-compatible endpoint directly (the local OpenCode Go proxy),
so a corpus of dozens of reports needs no agent per report. Each call uses the
official point-wise RACE prompt and criteria; replies are stored raw, parsed,
and weighted with the official formula.

  node opencode_proxy.mjs 8787        # endpoint on 127.0.0.1:8787
  python3 judge_corpus.py --limit 20  # 20 tasks x 2 systems

Outputs:
  corpus/raw/task<id>-<system>.txt    exact model reply
  corpus/judged/task<id>-<system>.json parsed scores (official shape)
  corpus/scores.jsonl                 one scored row per report + human means
"""

import argparse
import collections
import json
import os
import pathlib
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from statistics import mean

sys.path.insert(0, "/home/ayanp/research/drb")
import render_pointwise as rp  # noqa: E402

DATA = pathlib.Path("/home/ayanp/research/drb")
RAW = DATA / "corpus" / "raw"
JUDGED = DATA / "corpus" / "judged"
DIMS = ["comprehensiveness", "insight", "instruction_following", "readability"]
HUMAN_DIM = {
    "comprehensiveness": "Comprehensiveness",
    "insight": "depth",
    "instruction_following": "instruction following",
    "readability": "readability",
}
MODEL = "deepseek-v4.1-flash"
ENDPOINT = os.environ.get("JUDGE_ENDPOINT", "http://127.0.0.1:8787/v1/chat/completions")
API_KEY = os.environ["JUDGE_KEY"]


def load(name):
    with (DATA / name).open() as fh:
        return [json.loads(line) for line in fh]


QUERIES = {r["id"]: r for r in load("query.jsonl")}
CRITERIA = {r["id"]: r for r in load("criteria.jsonl")}
HUMAN = collections.defaultdict(list)
for row in load("human_RACE.jsonl"):
    HUMAN[row["id"]].append(row)


def render(task_id, system):
    query = QUERIES[task_id]
    criteria = CRITERIA[task_id]
    article = next(r for r in load(f"{system}.jsonl") if r["id"] == task_id)["article"]
    criteria_list = json.dumps(
        {
            dim: [{"criterion": i["criterion"], "explanation": i["explanation"]} for i in items]
            for dim, items in criteria["criterions"].items()
        },
        ensure_ascii=False,
        indent=2,
    )
    template = rp.ZH if query["language"] == "zh" else rp.EN
    return template.format(
        task_prompt=query["prompt"], article=article, criteria_list=criteria_list
    )


def call(prompt, max_tokens=12000):
    body = json.dumps(
        {
            "model": MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "max_tokens": max_tokens,
        }
    ).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}",
            "User-Agent": "pi-research-eval/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        payload = json.loads(resp.read())
    choice = payload["choices"][0]
    return choice["message"]["content"], choice.get("finish_reason")


def parse_scores(text, task_id):
    """Prefer strict JSON; otherwise pair ordered target_score values with criteria."""
    clean = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        parsed = json.loads(clean)
        if all(d in parsed for d in DIMS):
            return parsed, "json"
    except json.JSONDecodeError:
        pass
    criteria = CRITERIA[task_id]["criterions"]
    out = {}
    bounds = []
    for dim in DIMS:
        m = re.search(rf'"{dim}"\s*:\s*\[', clean)
        bounds.append((dim, m.start() if m else -1))
    for i, (dim, start) in enumerate(bounds):
        end = bounds[i + 1][1] if i + 1 < len(bounds) and bounds[i + 1][1] > start else len(clean)
        scores = [float(x) for x in re.findall(r'"target_score"\s*:\s*([0-9]+(?:\.[0-9]+)?)', clean[start:end])]
        items = criteria[dim]
        if len(scores) != len(items):
            raise ValueError(f"{dim}: {len(scores)} scores for {len(items)} criteria")
        out[dim] = [
            {"criterion": item["criterion"], "analysis": "", "target_score": s}
            for item, s in zip(items, scores)
        ]
    return out, "ordered-recovery"


def weighted(dim_scores, task_id):
    criteria = CRITERIA[task_id]
    weights = criteria["dimension_weight"]
    cw = {
        dim: {i["criterion"]: i["weight"] for i in items}
        for dim, items in criteria["criterions"].items()
    }
    dims = {}
    for dim, items in dim_scores.items():
        pairs = [
            (float(i["target_score"]), cw[dim].get(i["criterion"], 0.0))
            for i in items
            if i.get("target_score") is not None
        ]
        pairs = [(s, w) for s, w in pairs if w > 0]
        if pairs:
            dims[dim] = sum(s * w for s, w in pairs) / sum(w for _, w in pairs)
    total = sum(dims[d] * weights[d] for d in dims) / sum(weights[d] for d in dims)
    return dims, total


def human_means(task_id, system):
    anns = HUMAN[task_id]
    return {
        "overall": mean(a["overall_scores"][system] for a in anns),
        "dims": {d: mean(a["dimension_scores"][system][h] for a in anns) for d, h in HUMAN_DIM.items()},
    }


def judge(task_id, system):
    prompt = render(task_id, system)
    text, finish = call(prompt)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / f"task{task_id}-{system}.txt").write_text(text)
    parsed, how = parse_scores(text, task_id)
    JUDGED.mkdir(parents=True, exist_ok=True)
    (JUDGED / f"task{task_id}-{system}.json").write_text(json.dumps(parsed, ensure_ascii=False))
    dims, total = weighted(parsed, task_id)
    human = human_means(task_id, system)
    row = {
        "task": task_id,
        "system": system,
        "judge_total_0_10": round(total, 4),
        "judge_dims_0_10": {k: round(v, 4) for k, v in dims.items()},
        "human_overall": round(human["overall"], 2),
        "human_dims": {k: round(v, 2) for k, v in human["dims"].items()},
        "parse": how,
        "finish": finish,
    }
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=10, help="number of zh tasks")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--tasks", help="comma-separated task ids (overrides --limit)")
    args = ap.parse_args()

    zh = sorted(t for t in HUMAN if QUERIES[t]["language"] == "zh")
    tasks = [int(t) for t in args.tasks.split(",")] if args.tasks else zh[: args.limit]

    jobs = []
    for task_id in tasks:
        anns = HUMAN[task_id]
        means = {s: mean(a["overall_scores"][s] for a in anns) for s in anns[0]["overall_scores"]}
        top = max(means, key=means.get)
        bottom = min(means, key=means.get)
        jobs.append((task_id, top))
        jobs.append((task_id, bottom))

    rows, errors = [], []
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(judge, t, s): (t, s) for t, s in jobs}
        for future in futures:
            t, s = futures[future]
            try:
                row = future.result()
                rows.append(row)
                print(f"ok   task{t} {s:32s} judge {row['judge_total_0_10']*10:6.2f} human {row['human_overall']:6.2f} ({row['parse']})", flush=True)
            except Exception as err:
                errors.append(f"task{t} {s}: {err}")
                print(f"FAIL task{t} {s}: {err}", flush=True)

    out = DATA / "corpus" / "scores.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        for row in sorted(rows, key=lambda r: (r["task"], r["system"])):
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"\n{len(rows)} judged, {len(errors)} failed -> {out}")


if __name__ == "__main__":
    main()
