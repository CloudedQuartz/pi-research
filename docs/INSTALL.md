# Installing and running `/research`

Everything below is what was executed to validate the extension: a clean copy of
the package, its dependencies installed from `package.json` alone, an isolated
agent directory, and a first run.

## Prerequisites

- Node.js 20 or newer (the extension is ESM and uses `fetch`, `AbortSignal.any`).
- Pi installed and on `PATH` (`pi --version`).
- One provider reachable from Pi: either an existing `~/.pi/agent/auth.json`, or
  `/login` in Pi.

## Install

From the package directory:

```bash
npm install --omit=dev          # runtime dependencies only
pi install "$PWD"               # adds this package to Pi's settings
```

`pi install` records the package and Pi loads its `pi.extensions` entry
(`./src/research.ts`). Runtime dependencies come from `package.json`, so a fresh
install pulls `pi-web-access` (search and page reads) and `@aloth/cred1` (the source
prior) without any extra steps. Development dependencies (TypeScript, tsx) are not
needed to run.

To keep this off your everyday Pi configuration, isolate the agent directory:

```bash
export PI_CODING_AGENT_DIR=/tmp/sandbox/agent
mkdir -p "$PI_CODING_AGENT_DIR"
cp ~/.pi/agent/auth.json ~/.pi/agent/models.json "$PI_CODING_AGENT_DIR"/
printf '{"defaultProvider":"opencode-go","defaultModel":"deepseek-v4.1-flash","defaultThinkingLevel":"low"}\n' \
  > "$PI_CODING_AGENT_DIR/settings.json"
pi install /path/to/package
```

A minimal `settings.json` is optional; without `defaultModel`, Pi asks for a model.

## First run

```bash
cd /tmp/sandbox/work          # reports are written under ./research
pi
```

```text
/research What is non-revenue water, and how is it normally split between real and apparent losses?
```

The run happens in a child session. Your transcript shows a todo-style widget, one
line per round, and a notice when the report is saved. Reports and their journals go
to `research/`. A 4-round run took about 7 minutes, but turns are not bounded by default; expect 15–40 minutes depending on
the question and provider.

Afterwards:

```text
/research-view    # the last run's journal: rounds, queries, sources, assessments, delegated pages
/research-stop    # end a hosted run; the child saves the evidence it has
```

## Environment switches

| Variable | Effect |
|---|---|
| `PI_RESEARCH_TOOLS_EXT` | Extension that provides `web_search`/`fetch_content`. Default `npm:pi-web-access`. |
| `PI_RESEARCH_SUBAGENTS_EXT` | Delegation backend. Default `npm:@gotgenes/pi-subagents`; set to empty to disable delegation. |
| `PI_RESEARCH_OCR_EXT` | Document parser used for PDFs and scans. Default `npm:pi-docparser`. |
| `PI_RESEARCH_MODEL` | Pins the research session's model as `provider/id`. |
| `PI_RESEARCH_TRANCO` | Path to a locally cached Tranco list; a domain absent from it ranks slightly lower. |
| `PI_RESEARCH_SUBAGENT_WAIT_MS` | Bounds the wait when collecting a subagent's result. Unset means wait for it. |
| `PI_RESEARCH_STAGE_TIMEOUT_MS` | Unset by default: a stage may take as long as it needs. Set it to end a stage that never replies, e.g. `1800000` for 30 minutes. |

## Troubleshooting

- **`Research needs web_search and fetch_content from pi-web-access`** — the tools
  are not registered in the session. Install/enable `pi-web-access`, then rerun. The
  extension loads its own copy only when nothing has registered the tools.
- **No completed report** — the run stopped before writing (cancelled, provider
  error, or a stage that never returned). The evidence collected so far is saved
  next to where the report would be; `/research-view` shows the stop reason.
- **Nothing happens for ten minutes** — a delegated agent can take that long; the
  run waits for it by design. Bound it with `PI_RESEARCH_SUBAGENT_WAIT_MS`, or stop
  with `/research-stop`.
- **A scanned PDF contributed no text** — the parser needs `pi-docparser`; two
  documents are parsed per round because OCR on a 66-page report takes ~150 s.
- **Reports are small** — fetch failures dominate on hosts that block robots
  (`403`/`404`). The journal lists every failure per round.
