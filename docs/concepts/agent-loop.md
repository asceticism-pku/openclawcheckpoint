---
summary: "Agent loop lifecycle, streams, and wait semantics"
read_when:
  - You need an exact walkthrough of the agent loop or lifecycle events
title: "Agent Loop"
---

# Agent Loop (OpenClaw)

An agentic loop is the full “real” run of an agent: intake → context assembly → model inference →
tool execution → streaming replies → persistence. It’s the authoritative path that turns a message
into actions and a final reply, while keeping session state consistent.

In OpenClaw, a loop is a single, serialized run per session that emits lifecycle and stream events
as the model thinks, calls tools, and streams output. This doc explains how that authentic loop is
wired end-to-end.

## Entry points

- Gateway RPC: `agent` and `agent.wait`.
- CLI: `agent` command.

## How it works (high-level)

1. `agent` RPC validates params, resolves session (sessionKey/sessionId), persists session metadata, returns `{ runId, acceptedAt }` immediately.
2. `agentCommand` runs the agent:
   - resolves model + thinking/verbose defaults
   - loads skills snapshot
   - calls `runEmbeddedPiAgent` (pi-agent-core runtime)
   - emits **lifecycle end/error** if the embedded loop does not emit one
3. `runEmbeddedPiAgent`:
   - serializes runs via per-session + global queues
   - resolves model + auth profile and builds the pi session
   - subscribes to pi events and streams assistant/tool deltas
   - enforces timeout -> aborts run if exceeded
   - returns payloads + usage metadata
4. `subscribeEmbeddedPiSession` bridges pi-agent-core events to OpenClaw `agent` stream:
   - tool events => `stream: "tool"`
   - assistant deltas => `stream: "assistant"`
   - lifecycle events => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` uses `waitForAgentJob`:
   - waits for **lifecycle end/error** for `runId`
   - returns `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Queueing + concurrency

- Runs are serialized per session key (session lane) and optionally through a global lane.
- This prevents tool/session races and keeps session history consistent.
- Messaging channels can choose queue modes (collect/steer/followup) that feed this lane system.
  See [Command Queue](/concepts/queue).

## Session + workspace preparation

- Workspace is resolved and created; sandboxed runs may redirect to a sandbox workspace root.
- Skills are loaded (or reused from a snapshot) and injected into env and prompt.
- Bootstrap/context files are resolved and injected into the system prompt report.
- A session write lock is acquired; `SessionManager` is opened and prepared before streaming.

## Prompt assembly + system prompt

- System prompt is built from OpenClaw’s base prompt, skills prompt, bootstrap context, and per-run overrides.
- Model-specific limits and compaction reserve tokens are enforced.
- See [System prompt](/concepts/system-prompt) for what the model sees.

## Hook points (where you can intercept)

OpenClaw has two hook systems:

- **Internal hooks** (Gateway hooks): event-driven scripts for commands and lifecycle events.
- **Plugin hooks**: extension points inside the agent/tool lifecycle and gateway pipeline.

### Internal hooks (Gateway hooks)

- **`agent:bootstrap`**: runs while building bootstrap files before the system prompt is finalized.
  Use this to add/remove bootstrap context files.
- **Command hooks**: `/new`, `/reset`, `/stop`, and other command events (see Hooks doc).

See [Hooks](/automation/hooks) for setup and examples.

### Plugin hooks (agent + gateway lifecycle)

These run inside the agent loop or gateway pipeline:

- **`before_model_resolve`**: runs pre-session (no `messages`) to deterministically override provider/model before model resolution.
- **`before_prompt_build`**: runs after session load (with `messages`) to inject `prependContext`, `systemPrompt`, `prependSystemContext`, or `appendSystemContext` before prompt submission. Use `prependContext` for per-turn dynamic text and system-context fields for stable guidance that should sit in system prompt space.
- **`before_agent_start`**: legacy compatibility hook that may run in either phase; prefer the explicit hooks above.
- **`agent_end`**: inspect the final message list and run metadata after completion.
- **`before_compaction` / `after_compaction`**: observe or annotate compaction cycles.
- **`before_tool_call` / `after_tool_call`**: intercept tool params/results.
- **`tool_result_persist`**: synchronously transform tool results before they are written to the session transcript.
- **`message_received` / `message_sending` / `message_sent`**: inbound + outbound message hooks.
- **`session_start` / `session_end`**: session lifecycle boundaries.
- **`gateway_start` / `gateway_stop`**: gateway lifecycle events.

See [Plugin hooks](/plugins/architecture#provider-runtime-hooks) for the hook API and registration details.

## Streaming + partial replies

- Assistant deltas are streamed from pi-agent-core and emitted as `assistant` events.
- Block streaming can emit partial replies either on `text_end` or `message_end`.
- Reasoning streaming can be emitted as a separate stream or as block replies.
- See [Streaming](/concepts/streaming) for chunking and block reply behavior.

## Tool execution + messaging tools

- Tool start/update/end events are emitted on the `tool` stream.
- Tool results are sanitized for size and image payloads before logging/emitting.
- Messaging tool sends are tracked to suppress duplicate assistant confirmations.

## Reply shaping + suppression

- Final payloads are assembled from:
  - assistant text (and optional reasoning)
  - inline tool summaries (when verbose + allowed)
  - assistant error text when the model errors
- `NO_REPLY` is treated as a silent token and filtered from outgoing payloads.
- Messaging tool duplicates are removed from the final payload list.
- If no renderable payloads remain and a tool errored, a fallback tool error reply is emitted
  (unless a messaging tool already sent a user-visible reply).

## Compaction + retries

- Auto-compaction emits `compaction` stream events and can trigger a retry.
- On retry, in-memory buffers and tool summaries are reset to avoid duplicate output.
- See [Compaction](/concepts/compaction) for the compaction pipeline.

## Event streams (today)

- `lifecycle`: emitted by `subscribeEmbeddedPiSession` (and as a fallback by `agentCommand`)
- `assistant`: streamed deltas from pi-agent-core
- `tool`: streamed tool events from pi-agent-core

## Chat channel handling

- Assistant deltas are buffered into chat `delta` messages.
- A chat `final` is emitted on **lifecycle end/error**.

## Timeouts

- `agent.wait` default: 30s (just the wait). `timeoutMs` param overrides.
- Agent runtime: `agents.defaults.timeoutSeconds` default 600s; enforced in `runEmbeddedPiAgent` abort timer.

## Where things can end early

- Agent timeout (abort)
- AbortSignal (cancel)
- Gateway disconnect or RPC timeout
- `agent.wait` timeout (wait-only, does not stop agent)

## Checkpoint auto-restore on loop detection

When the tool-loop detector identifies a **critical** stuck loop (for example, `global_circuit_breaker`
triggers after 30 repeated identical tool calls with no progress), OpenClaw attempts to automatically
restore the sandbox to its most recent checkpoint before blocking the session.

### How it works

1. `detectToolCallLoop()` returns `{ stuck: true, level: "critical", detector: "..." }`.
2. `maybeRestoreCheckpointOnLoop()` is called with the loop result and the session's sandbox context.
3. If a restorable checkpoint exists, `restoreCheckpoint()` recreates the container from the committed
   Docker image and the stride counter is reset so the next run starts fresh.
4. The tool call is blocked regardless of whether the restore succeeds, but the reason injected into
   the model context differs:
   - **Restore succeeded**: `"⚠️ Detected stuck loop (<detector>). Sandbox has been restored to the last checkpoint. Please try a different approach."`
   - **No restore available**: the original loop message is used as the block reason.

### Requirements

- The sandbox backend must support checkpoints (`backend.capabilities.checkpoint = true`).
- `checkpoint.enabled` must be `true` in the agent config.
- At least one successful checkpoint must exist for the container.

## `/undo` command

Users can manually trigger a sandbox checkpoint restore at any time with the `/undo` command.

### Behavior

1. Resolves the sandbox context for the current session.
2. If no sandbox or checkpoints are not enabled: replies with `"⚠️ Undo is not available — no sandbox checkpoint is configured for this session."`
3. If no checkpoint exists: replies with `"⚠️ No checkpoint available to restore."`
4. Calls `restoreCheckpoint()` to recreate the container from the last committed image.
5. On success: replies with `"✅ Sandbox restored to checkpoint from <relative time> (tool: <toolName>). The last mutating change has been undone."` and resets the stride counter.
6. On failure: replies with `"❌ Failed to restore checkpoint. Please check sandbox status."`

## Checkpoint strategies

OpenClaw supports multiple checkpoint strategies for sandbox containers. The strategy is configured
via `checkpoint.strategy` in the agent config.

### `docker-commit` (default)

Creates a full snapshot of the container filesystem using `docker commit`. On restore, the container
is stopped and recreated from the committed image. Simple and reliable but slow for large containers
because the entire filesystem is snapshotted on every checkpoint.

### `overlay` (incremental diff)

Instead of a full filesystem snapshot, `overlay` captures only the files that changed since the
container was last snapshotted — an incremental diff. This is dramatically faster for OSWorld
benchmark tasks where the agent makes small, targeted changes to the container.

**How it works:**

1. `docker diff <container>` lists all files that were added (A), changed (C), or deleted (D).
2. Changed/added files are extracted via streaming `docker cp` and stored as a gzipped tar archive
   on the host at `~/.openclaw/sandbox/checkpoints/<container>/<id>.tar.gz`.
3. Deleted paths are stored in a JSON sidecar (`<id>.meta.json`).
4. Each overlay checkpoint records a `parentCheckpointId` to form an incremental chain.

**Restore:** The chain is replayed from root to target — the container is recreated from the base
image, then each overlay layer is applied in order (tar extracted, deleted paths removed).

**Performance benefit:** For a container where a benchmark step modifies only a handful of files,
the overlay tar is typically a few kilobytes vs. hundreds of megabytes for a full `docker commit`.

### `auto`

Probes the container runtime at checkpoint time. Uses `overlay` if `docker diff` is supported,
otherwise falls back to `docker-commit`. Recommended for most use cases.

### `criu`

Not yet implemented. Selecting `criu` will cause checkpoints to be skipped with a warning.

## In-memory session state checkpointing

When `checkpoint.memoryCheckpoint` is `true` (the default), OpenClaw also snapshots the agent's
in-memory session state alongside the container checkpoint:

- **Tool call history** used by the loop detector to identify stuck patterns.
- **Stride counter** for checkpoint throttling.

The snapshot is stored as a JSON file next to the overlay tar (or alongside the docker-commit
registry entry). On restore, the session state is reinstated so the loop detector starts from the
correct baseline — preventing false-positive loop detections after a rollback.

## Adaptive stride

When `checkpoint.adaptiveStride` is `true`, the checkpoint stride interval adjusts automatically
based on tool call frequency:

- **Fast calls** (arriving faster than 2 seconds apart on average): stride increases (fewer
  checkpoints, less overhead) up to a maximum of 8.
- **Slow calls**: stride decreases back toward 1 (checkpoint every call).

This is useful for OSWorld benchmark workloads where the agent alternates between rapid exploratory
tool calls and longer-running setup steps.

## Disk budget pruning

When `checkpoint.maxTotalSizeBytes` is configured, checkpoints are pruned oldest-first whenever
the cumulative size of all checkpoint artifacts exceeds the budget. This works in combination with
`maxSnapshots` (count-based pruning) and `ttlMs` (age-based pruning).

Each checkpoint entry tracks a `sizeBytes` field (populated for overlay checkpoints; not available
for docker-commit entries since Docker image sizes are not easily queried at commit time).
