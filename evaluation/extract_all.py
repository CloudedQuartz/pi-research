#!/usr/bin/env python3
"""Extract every judge JSON from the current session's subagent transcripts.

Each judge subagent is told to read one judge_input/task<id>-<system>.md file
and return a single JSON object. This scans the transcripts, pairs each with
the input file its prompt names, and writes judged/task<id>-<system>.json.
Nothing is repaired: a transcript without a parsable judgment is reported.
"""

import html
import json
import pathlib
import re

SESSIONS = pathlib.Path("/home/ayanp/.pi/agent/sessions")
OUT = pathlib.Path("/home/ayanp/research/drb/judged")
INPUT_RE = re.compile(r"judge_input/task(\d+)-([A-Za-z0-9.\-]+)\.md")


def message_text(entry: dict) -> str:
    msg = entry.get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content
    return "\n".join(
        block.get("text", "")
        for block in content or []
        if isinstance(block, dict) and block.get("type") == "text"
    )


def strip_fence(raw: str) -> str:
    raw = html.unescape(raw).strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    return m.group(1).strip() if m else raw


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    written = 0
    for transcript in SESSIONS.rglob("tasks/*.jsonl"):
        entries = [json.loads(line) for line in transcript.open()]
        texts = [message_text(e) for e in entries if e.get("type") == "message"]
        match = next((INPUT_RE.search(t) for t in texts if INPUT_RE.search(t)), None)
        if not match:
            continue
        task_id, system = match.group(1), match.group(2)
        best = None
        for entry in entries:
            if entry.get("type") != "message":
                continue
            if (entry.get("message") or {}).get("role") != "assistant":
                continue
            candidate = strip_fence(message_text(entry))
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if all(k in parsed for k in ("comprehensiveness", "insight")):
                best = parsed
        if best is None:
            print(f"no judgment: {transcript.name}")
            continue
        out = OUT / f"task{task_id}-{system}.json"
        out.write_text(json.dumps(best, ensure_ascii=False))
        counts = {k: len(v) for k, v in best.items() if isinstance(v, list)}
        print(f"{out.name}: {counts}")
        written += 1
    print(f"wrote {written} judgments")


if __name__ == "__main__":
    main()
