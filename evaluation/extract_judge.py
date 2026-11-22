#!/usr/bin/env python3
"""Extract a judge JSON object from a subagent transcript.

The judge agents return one JSON object as their final assistant message. This
reads the transcript, finds the last assistant text that parses as a RACE
judgment, strips an optional markdown fence, and writes it where score.py
expects it. Nothing is repaired or re-scored.
"""

import argparse
import json
import pathlib
import re

SYSTEMS = [
    "openai-deepresearch",
    "gemini-2.5-pro-deepresearch",
    "grok-deeper-search",
    "perplexity-Research",
]


def texts(message: dict) -> list[str]:
    content = message.get("content")
    if isinstance(content, str):
        return [content]
    out = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            out.append(block.get("text", ""))
    return out


def strip_fence(raw: str) -> str:
    raw = raw.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if m:
        return m.group(1).strip()
    return raw


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--system", required=True, choices=SYSTEMS)
    ap.add_argument("--task", type=int, required=True)
    ap.add_argument("--out-dir", default="/home/ayanp/research/drb/judged")
    args = ap.parse_args()

    entries = [json.loads(line) for line in pathlib.Path(args.transcript).open()]
    best = None
    for entry in entries:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        for text in texts(msg):
            candidate = strip_fence(text)
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if all(k in parsed for k in ("comprehensiveness", "insight")):
                best = candidate

    if best is None:
        raise SystemExit(f"no parsable judgment in {args.transcript}")

    out = pathlib.Path(args.out_dir) / f"task{args.task}-{args.system}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(best)
    parsed = json.loads(best)
    counts = {k: len(v) for k, v in parsed.items() if isinstance(v, list)}
    print(f"{out}: {counts}")


if __name__ == "__main__":
    main()
