# dsh-monitor

**A drop-in replacement for Claude Code's `Monitor` tool, built for DeepSeek Harness.**

`dsh-monitor` is a harness plugin that arms **persistent, background watchers** on message sources. When new content arrives, the plugin **wakes the owning agent** — delivering a plugin-sourced user message into the session, exactly like Claude Code's `<task-notification>` mechanism.

If you rely on Claude Code's Monitor to stay responsive to inbound messages while a shell is idle, this plugin gives you the same capability inside DeepSeek Harness.

## How it works

The model calls the `monitor` tool to arm a watcher on a source:

- **`source: file`** — an append-only NDJSON inbox. New lines are delivered as they land.
- **`source: command`** — a shell command re-run on an interval. Its output delta since the last run is delivered.

On each new message the plugin wakes the agent:

| Agent state | Behavior |
|---|---|
| **idle** | `agent.followup()` — opens a new turn (harness analog of Claude Code's `<task-notification>`) |
| **busy** | `agent.inject()` — queues the message into the next step |

Watchers are durable within the session, disarmable on demand, and torn down automatically when the plugin is unloaded.

## Installation

> `dsh plugin --profile <name> <args...>` is a thin pnpm forwarder: it runs
> `pnpm <args...>` in the profile directory, then adds any installed package
> that declares `dsh.bundle` to the profile's layer stack automatically.

### From npm

```bash
npx @deepseek-ai/dsh@latest plugin --profile web add dsh-monitor
```

### From git

```bash
npx @deepseek-ai/dsh@latest plugin --profile web add https://github.com/AbnerAI/dsh-monitor
```

### From a local directory

```bash
npx @deepseek-ai/dsh@latest plugin --profile web add /path/to/dsh-monitor
```

> When installing a local directory, run `pnpm install` inside the package
> first — `link:` installs do not resolve the package's own dependencies
> automatically.

Manual alternative: add `dsh-monitor` to the profile's `dsh.profile.bundles`
and include this package's `cordis.patch.yml` via its `dsh.bundle.patch`
declaration.

## Quick start

Tell the agent to arm a watcher on an inbox file:

```
monitor(source="file",
        path="/absolute/path/to/inbox.ndjson",
        name="my-inbox",
        poll_interval_ms=1000)
```

- `path` must be an **absolute path** (or start with `~` — the plugin expands it). Node's `fs` does not expand `~` itself.
- `poll_interval_ms` defaults to 2000; 1000 is a good balance for chat-like inboxes.

The tool returns a watcher id, e.g. `monitor-1`. From then on, every new line written to the file wakes the agent automatically.

Manage watchers at any time:

```
monitor_list                        # list armed watchers (id, source, delivered count)
monitor_stop(id="monitor-1")        # disarm one
```

To watch a command's changing output instead of a file:

```
monitor(source="command", command="tail -n 5 /var/log/app.log", poll_interval_ms=5000)
```

## Tools

### `monitor`

Arm a persistent watcher.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source` | `"file" \| "command"` | yes | `file` = watch an append-only NDJSON inbox; `command` = poll a shell command's output |
| `path` | string | for `file` | path of the NDJSON inbox (absolute, or `~`-prefixed) |
| `command` | string | for `command` | shell command to poll |
| `cwd` | string | no | working directory for the command (defaults to the process cwd) |
| `poll_interval_ms` | number | no | poll interval in ms (default 2000) |
| `name` | string | no | short label used in wake-up messages and `monitor_list` |

Returns a watcher id. Each new NDJSON line (or command-output delta) is delivered as a plugin-sourced notice that wakes the agent.

> **Implementation note.** Polling uses plain global `setInterval` with cleanup registered via `ctx.effect` — the same timer convention as `dsh-schedule`. The Cordis timer-service mixin (`ctx.setInterval`) is intentionally **not** used: it is only resolvable from the host context, not from tool-execution contexts, and calling it throws `cannot get property "timer" without inject`.

### `monitor_list`

List armed watchers with their ids, sources, and delivery counts. Empty output means nothing is armed.

### `monitor_stop`

Disarm a watcher by id. Returns whether it was still armed.

## NDJSON inbox format

Each line is a JSON object; the `content` field is delivered if present, otherwise the raw line:

```json
{"content":"hello","ts":1712345678}
```

Any append-only NDJSON file works. The format pairs naturally with messaging and notification brokers: a broker appends one record per inbound message, and a watcher on the file wakes the agent as new records land. This mirrors the contract Claude Code Monitor exposes for its own inbox watchers.

## Requirements

- DeepSeek Harness (dsh) with a Cordis-based plugin loader (bundles / `cordis.patch.yml`).
- Peer dependencies: `dsh-agent`, `dsh-llm`, `dsh-tools`, `cordis` (satisfied by the harness runtime).

## License

MIT
