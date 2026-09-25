# pi-jev-compaction

**Keep the conversation. Clear stale tool output. Get the original back without running the command again.**

An automatic [Pi](https://pi.dev) extension powered by [TypeSafe Jev](https://typesafe.ai). It clears safely superseded reads and test runs directly; Jev scores other older tool outputs. Original session messages stay intact.

No extra agent. No summary model. No runtime dependencies beyond Pi.

## Install

```sh
pi install git:github.com/nourhelmi/pi-jev-compaction
export TYPESAFE_API_KEY="your-typesafe-api-key"
pi
```

Get a key from [TypeSafe](https://typesafe.ai). Set it in the environment where you launch Pi. Already running Pi? `/reload` reloads the extension, but a newly exported shell variable requires restarting Pi from that shell.

That's it. Clearing runs automatically. Interactive Pi always shows state plus cumulative estimated context saved, such as `Jev ready · 0 saved`, `Jev checking… · ~18k saved`, or `Jev paused · ~18k saved`, in the input editor's bottom border; `/jev-status` shows the full configuration and last result.

```sh
pi remove git:github.com/nourhelmi/pi-jev-compaction
```

Requires Node.js **22.19+**. Tested against Pi **0.87.1**. Works with models running inside Pi, not with standalone Claude Code or Codex CLI sessions.

## How it works

1. At live model/tool boundaries, once the next request reaches **120k tokens or 45% of the model's context window, whichever is smaller**, launch an evaluation concurrently with the next model request. Cleared outputs no longer count, so a successful clearing is its own hysteresis. A 1M-token window starts at 120k instead of 450k.
2. Protect the latest **12k estimated tokens**, including complete parallel tool batches.
3. Clear outputs that a later output restates, with no network call: a later complete read of the same path, a later successful run of the identical test command in the same working directory, a later advisor checkpoint read or write, a later plan for the same graph, a repeated skill read, a later `bg_list`, a later terminal `bg_output` for the same run, or identical diagnostics.
4. Ask Jev about up to **16 remaining large outputs**, sending bounded conversation, argument, and result excerpts in one request. Clear them only when their estimated probability of still being needed is below **0.25**.
5. Commit the batch only when its one-time cache rewrite repays within **20 later requests**. Clearing an output invalidates the cached prompt from that output onward, so a small old output waits until a larger batch justifies the rewrite.
6. Replace each cleared output's model-facing body with a stable marker. Keep the tool call, message order, metadata, and original evidence.

Example marker:

```text
[pi-jev: older tool output cleared from context; original retained in this session.
Retrieve with jev_read({"ref":"…"}). Do not rerun a side-effecting command to recover its output.]
```

The `jev_read` tool returns the original stored output in bounded pages. It does not reread a potentially changed file, rerun a deployment, or search another session. Retrieval works from the active session branch, including after normal compaction.

Clearing decisions are small append-only session entries. Reloads and branches recover their own decisions; original message records are never rewritten. `/jev-reset` appends a branch-local reset that releases every current mask without deleting evidence or history. Removing the extension also stops applying masks. Normal Pi summaries already created remain summaries.

## What stays

- User and assistant text, tool calls, thinking/signatures, custom messages and summaries.
- Recent tool batches, failed outputs, images and other non-text result blocks.
- `AGENTS.md` and `SKILL.md` file reads, deferred-tool loading results, `jev_read` responses.
- Launch receipts and coordination: `bg_agent`, `bg_stop`, `bg_watch`, `bg_await`, advisor session/launch/evidence tools, memory writes, goals, routines, teams, `agent_message`, `intercom` and `todo`.
- The latest advisor checkpoint, graph plan, skill read and run list. These are cleared only when superseded and are never sent to Jev.

Completed foreground `bg_run` output, `bg_output` tails and transcripts, and memory searches are ordinary evidence that Jev may score.

Only successful text outputs of at least **2,000 characters** are eligible. Unknown or ambiguous call/result pairing, credential-file access, and outputs containing obvious secret patterns are left alone. Jev sees excerpts, not complete evidence, and can make relevance mistakes; the retrieval tool exists for that reason.

## Compaction and caching

This is **context clearing before summarization**, not a promise of unlimited context.

Pi's normal manual, threshold and overflow compaction remain unchanged. Missing key? The extension is dormant. API error, timeout or invalid answer? No new outputs are cleared. Evaluation never delays the next provider request: a result applies to the next request available after it finishes, so a fast tool loop may carry the old output for one more cycle. Nothing can alter a provider request already in flight. Results are discarded if the branch changes, a new user task starts, or compaction begins; a large tool batch can still trigger ordinary compaction first.

Evaluations are spaced by at least **8k estimated tokens of raw-context growth**. The payback gate models an Anthropic-style cache (writes 1.25×, reads 0.1× input): clearing saves reads on every later request but rewrites everything after the earliest cleared output once. The gate favors large, recent batches; `PI_JEV_MAX_PAYBACK_TURNS` tunes it. Stable decisions are reapplied locally without another API call. The saved counter sums the estimated token footprints of successfully persisted clearing decisions across the entire session tree, so branch navigation, compaction, and `/jev-reset` do not erase it. It does not multiply savings across later requests or claim billing/cache savings. Changing old output invalidates the cached prompt prefix from that point onward; fewer context tokens do not automatically mean a cheaper session.

Don't co-load another general-purpose context-pruning extension. Pi Meta Harness's `codex-compaction` may be used for provider-native OpenAI Codex compaction: JEV handles earlier output, then pauses on that branch while the native encrypted checkpoint owns provider context. It still preserves `jev_read` retrieval, but cannot rewrite or migrate the checkpoint. Other providers, including Claude, continue using Pi's normal summarization; the native checkpoint is Codex-only.

Keep `jev_read` active. If your tool allowlist excludes it, the frame shows `Jev paused`, no new clearing decisions are made, and existing masks stop applying until retrieval is enabled again.

## Configuration

Environment variables are read when the extension loads. Invalid numeric settings fall back to defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Required to enable automatic clearing |
| `PI_JEV_MODEL` | `jev-1.13.0` | Jev model identifier |
| `PI_JEV_THRESHOLD` | `0.45` | Context fraction that triggers evaluation; `0.1`–`0.95` |
| `PI_JEV_TRIGGER_TOKENS` | `120000` | Absolute trigger; the smaller of this and the fraction applies; `8000`–`2000000` |
| `PI_JEV_MAX_PAYBACK_TURNS` | `20` | Commit a clearing batch only when its cache rewrite repays within this many requests; `1`–`1000` |
| `PI_JEV_KEEP_THRESHOLD` | `0.25` | Keep probabilities at or above this; lower is less aggressive |
| `PI_JEV_KEEP_RECENT_TOKENS` | `12000` | Protected recent token window; `2000`–`100000` |
| `PI_JEV_TIMEOUT_MS` | `5000` | Request deadline; `100`–`60000` |

## Data sent to TypeSafe

Installing this extension and supplying a key enables requests to `https://api.typesafe.ai/v1/systemone`.

Each request includes:

- Up to eight recent user/assistant text or summary excerpts, up to roughly 600 characters each.
- Candidate tool names and truncated arguments, up to roughly 400 characters each.
- Candidate result head/tail excerpts, up to roughly 800 characters each, plus output length.

The complete serialized request is capped at **24,000 UTF-8 bytes**. Thinking blocks, signatures, images, tool-result `details`, system instructions and custom-message contents are excluded. Common private-key, provider-token, bearer-token and credential-assignment patterns are redacted from uploaded excerpts, and obvious credential-file candidates are excluded. This is heuristic protection, not a general secret scanner—do not put credentials in prompts or ordinary text. Responses are capped at **64,000 bytes** and redirects are refused. Requests are billed separately by TypeSafe. Keys and response bodies are not logged.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
```

Tests use synthetic sessions and mocked Jev responses. They verify lifecycle, projection, protocol preservation, branch-local recovery, request bounds and failure handling—not live Jev relevance quality or a claimed cost reduction.

## Credits

Inspired by [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT). This package implements Pi's result-only projection and original-output retrieval directly; it does not bundle the Claude Code plugin.

MIT · [Nour Helmi](https://github.com/nourhelmi)
