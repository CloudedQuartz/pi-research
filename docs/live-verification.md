# Live verification: fresh run with the former eight-minute default

New investigations no longer have an overall deadline by default. The [new-default rerun](#live-rerun-with-no-default-deadline) is recorded below. The original run used `14b0289`; existing recorded deadlines are unchanged.

**Result: partial.** On 2026-11-18, a fresh Pi RPC session at commit `14b0289` ran `/research` once with the unmodified extension. It discovered sources with Exa, attempted 12 fetches, and retained eight snapshots and 84 passages. The extension's eight-minute elapsed allowance interrupted an assessment before synthesis. No report, citations, or follow-up were produced in this session. No grant, rerun, or provider fallback was used.

This is a technical run record, not the course report, a retrieval benchmark, or evidence of a successful end-to-end run on the final defaults.

## Configuration and reproduction

| Component | Run configuration |
|---|---|
| Extension | Repository `src/extension.ts` at `14b0289`, loaded through a symlink; no profile constants overridden |
| Runtime | Node 24.13.1, Pi 1.5.2 in RPC mode, pi-web-access 0.48.0 |
| Model and discovery | `opencode-go/deepseek-v4.1-flash`; explicit provider `exa`; registered tool `web_search` |
| Isolation | Private agent, working, and session directories; existing authentication referenced locally, never copied into Git |
| Retries and compaction | Off in the private launcher settings (`retry.enabled=false`, `retry.maxRetries=0`, `retry.provider.maxRetries=0`, `compaction.enabled=false`) |
| Tool controls | Registry restricted to `research_run,web_search`; a test-only guard allowed one root call and only search calls with that root's native parent ID |
| Deadlines | Extension allowance 480,000 ms; separate launcher safety deadline 900,000 ms from prompt submission |

For a comparable manual run with Pi, the selected model, and pi-web-access already configured, start a **new** persistent session, load `src/extension.ts`, and submit this command:

```text
/research What do Google's Rules of ML recommend for detecting training-serving skew, and how does logging serving features help?
```

Choose `exa`, enter `web_search`, and review the authorization dialog. A live run sends real model and search requests. Search results, latency, and generated plans can vary. A manual run without the harness does not reproduce its one-root guard, retry settings, or tool isolation.

The recorded RPC launcher used the following invocation. The paths in uppercase are placeholders; the one-shot guard was a local test artifact, not part of the shipped extension. The launcher set `PI_CODING_AGENT_DIR` to its private agent directory, `PI_TELEMETRY=0`, `JITI_FS_CACHE=0`, and `PI_SMOKE_GUARD_EVIDENCE` to a private output path.

```sh
pi --mode rpc --offline --no-extensions --no-mcp --no-skills --no-prompt-templates \
  --no-context-files --no-themes --no-approve --no-builtin-tools \
  --tools research_run,web_search --session-dir "$SESSIONS" \
  --model opencode-go/deepseek-v4.1-flash \
  -e "$SMOKE_GUARD" -e "$RESEARCH_EXTENSION" -e "$WEB_ACCESS_ENTRY"
```

`--offline` suppresses startup network operations; it does **not** prevent explicit provider calls. The client checked `get_commands` and `get_state`, then sent a single `prompt`. It answered exactly three `extension_ui_request`s by ID: provider input `exa`, tool input `web_search`, and confirmation after matching the question, provider, and expected limits. A prompt-free preflight did not dispatch any provider calls. The actual start used a fresh session.

## Observed execution

1. Native authorization completed and the model invoked `research_run` once. The guard recorded three matched child `web_search` calls, no blocked calls, and one root failure.
2. Three discovery queries settled: `Rules of ML detection guidance`, `logging serving features`, and `skew detection workflow`. The state retained 24 candidates. Discovery records are not passage evidence.
3. Twelve acquisition attempts settled: eight snapshots survived extraction (seven HTML pages, one PDF); four attempts failed. Failures included certificate validation, two 20-second timeouts, and missing extractable article content. Acquisition HTTP accounting includes robots checks, not only page downloads.
4. Model work comprised one planning call, five classification calls, and 19 assessment calls, counting the interrupted attempt. One classification hit its output length limit. The session recorded 100 `pi-research/state` entries; that is a persistence count, not a count of useful discoveries.
5. The root returned `Request aborted`, the request and claim closed as `interrupted`, and the investigation paused with committed evidence retained. Ledger elapsed was 480,025 ms including unwind; the guard measured 480,028 ms from root dispatch to failure. The launcher's 900-second deadline did not fire. A clean Pi process exit only meant the RPC process closed normally.
6. No synthesis-lane operation was recorded and no report was persisted, including a fallback. The planned `/research-continue` was not sent: even though several operation counters still had capacity, the shared elapsed allowance had none. Resetting the timer or granting more time would not have been the same default-allowance test.

## Accounting

| Resource | Default limit | Confirmed or accrued | Unresolved | Remaining |
|---|---:|---:|---:|---:|
| Search tool invocations | 8 | 3 | 0 | 5 |
| Candidate fetch attempts | 18 | 12 | 0 | 6 |
| Acquisition HTTP requests | 72 | 26 | 0 | 46 |
| Nested model calls | 40 | 25 | 0 | 15 |
| Nested model tokens | 180,000 | 105,297 | 12,375 | 62,328 |
| Claimed elapsed time (ms) | 480,000 | 480,025 | — | −25 |

The two-call, 48,000-token synthesis reserve sits **inside** the total model allowance and was unused. The table shows aggregate remaining resources, not what a work-lane call could reserve. Of 66 operations, 65 settled and one aborted assessment retained unknown token exposure. No writer remained active. These are extension ledger counts, not the full cost of the enclosing Pi conversation, a provider invoice, or a count of hidden provider-side search requests.

## Source quality and interpretation

The [Google Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) and [Databricks endpoint monitoring guide](https://docs.databricks.com/aws/en/machine-learning/model-serving/monitor-diagnose-endpoints) were on-topic acquisitions. Others included image skew/OCR and general log-management pages. The query terms `skew` and `logging` were not specific enough on their own to keep all results in scope. The existence of a snapshot or passage does not establish that the source was relevant, that it was cited, or that it contributed to answer coverage.

Earlier, separate live checks showed a follow-up reusing two retained snapshots without new acquisition, and a report update yielding a non-fallback answer with five resolving passage citations using the 12,000-token synthesis ceiling. Neither result belongs to this run. What remains unverified is **one fresh default session that produces a useful passage-cited initial answer and then reuses those sources on a follow-up**. The observed failure points make two improvements worth testing: retain domain qualifiers in discovery queries, and leave enough wall-clock time for synthesis rather than reserving only model-call and token capacity. Neither improvement was made as part of this documentation.

## Evidence retained locally

Private artifacts were recorded under `/tmp/pi-research-live-final-77IiOs/`: `start-rpc.jsonl` (dialogs and events), `guard-start.json` (dispatch identity and timing), `start.out` (launcher result), and `sessions/` (Pi history, `pi-research/allowances.sqlite`, immutable `snapshots/` and `blobs/`). The run was checked against the persisted state, guard, and ledger rather than the exit status alone. Raw logs, source bodies, session files, and credential references are not published with this record.

## Live rerun with no default deadline

The same question was run with the unmodified extension at `9cbe38e`, using the same Pi, DeepSeek, and Exa versions and the same operation limits. The authorization dialog displayed `Time: no deadline` for both turns. No budget grants were added. The launcher's separate one-hour safety stop did not fire.

On the first launch, the outer model declined to invoke `research_run` after authorization; no research operations were dispatched. A fresh launch using the same setup did invoke it and completed the initial research request in about 20 minutes, well beyond the former eight-minute limit. It retained six snapshots and 46 passages. The work lane stopped when it could not reserve enough model tokens for its next call. The synthesis call then hit its 12,000-output-token ceiling, so the persisted answer used the extractive fallback. All 18 statement citations resolved to immutable passage spans; this check does not establish semantic support.

The follow-up used the same investigation and allowance, with unchanged snapshot IDs and corpus revision and no new searches, fetches, or acquisition HTTP calls. It recorded a new objective but had too little work-lane token capacity to assess evidence against that objective. Its fallback had zero statements and ten unresolved needs. Retaining the corpus is not the same as answering the follow-up from it.

Across the two dispatched requests, the ledger recorded 2 searches, 6 fetches, 14 acquisition HTTP requests, 21 nested model calls, 143,111 nested model tokens, and 1,186,451 ms of active time. All 43 operations settled; no writer or unknown exposure remained. The aggregate 36,889 tokens left included protected synthesis capacity and was not available in full to work-lane calls.

The rerun verifies that the old deadline is gone. It does **not** verify a useful synthesized answer and follow-up in one fresh session. The observed blockers are model dispatch reliability, synthesis output truncation, and insufficient work-lane capacity for follow-up assessment. Private artifacts are under `/tmp/pi-research-live-9cbe38e-UYCYcf/`.
