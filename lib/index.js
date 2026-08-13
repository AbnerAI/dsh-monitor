/**
 * dsh-monitor — persistent watchers that wake the agent on new messages.
 *
 * A Claude Code Monitor equivalent for DeepSeek Harness: the model calls the
 * `monitor` tool to arm a persistent watcher on a message source (an
 * append-only ndjson inbox file, or a shell command re-run on a poll
 * interval). When new content arrives, the plugin wakes the owning agent
 * (idle -> followup opens a new turn; busy -> inject into the next step),
 * delivering a plugin-sourced user message — the harness analog of Claude
 * Code's <task-notification>.
 *
 * v1 sources:
 *   - inbox file: append-only NDJSON lines; each new line is delivered as-is.
 *   - command:    a shell command re-run every poll_interval_ms; output delta
 *                 since the previous run is delivered.
 *
 * Companion tools: monitor_list (list armed watchers), monitor_stop (disarm).
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage, boundContextSummary } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

const execFileAsync = promisify(execFile);

/** Expand a leading `~` (and `~/`) to the user's home directory. */
function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join2(homedir(), p.slice(2));
  return p;
}
function join2(a, b) {
  return resolvePath(a, b);
}

const name = "dsh-monitor";
// Timers are NOT injected: the harness convention is plain global
// setTimeout/setInterval with cleanup registered through ctx.effect
// (the timer service mixin is only resolvable from the host context,
// not from tool-execution contexts). See dsh-schedule for the pattern.
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  // Cap on the model-facing wake-up message (UTF-8 bytes).
  maxNoticeBytes: z.number().min(64).default(4096),
  // Default poll interval for command sources (ms).
  defaultPollIntervalMs: z.number().min(100).default(2000)
});

/** One armed watcher. */
function makeWatcher(spec) {
  return {
    ...spec,
    cursor: null,          // file: byte offset; command: last output
    stopped: false,
    timer: null,           // disposer returned by ctx.setInterval
    delivered: 0
  };
}

/** Read new lines from an append-only NDJSON file after `fromOffset`. */
function readFileDelta(path, fromOffset) {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], offset: fromOffset };
  }
  if (size === fromOffset) return { lines: [], offset: size };
  // Reset on truncation.
  const start = fromOffset === null || size < fromOffset ? 0 : fromOffset;
  // Read as a Buffer and slice by exact bytes (readFileSync `start` is
  // unreliable with string encodings across Node versions).
  const buf = readFileSync(path);
  const text = buf.subarray(start).toString("utf8");
  const offset = size;
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // NDJSON records: prefer the `content` field, fall back to the raw line.
    try {
      const rec = JSON.parse(line);
      const content = typeof rec?.content === "string" ? rec.content : line;
      lines.push({ raw: line, content, meta: rec });
    } catch {
      lines.push({ raw: line, content: line, meta: null });
    }
  }
  return { lines, offset };
}

/** Run a command and return { stdout, stderr, ok }. */
async function runCommand(cmd, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", cmd], {
      cwd: cwd ?? process.cwd(),
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", ok: true };
  } catch (error) {
    return { stdout: "", stderr: String(error?.message ?? error), ok: false };
  }
}

/** Format a wake-up message body with a bounded summary. */
function noticeFor(watcher, content) {
  const head = `[monitor ${watcher.name ?? watcher.id}] ${content}`;
  const summary = boundContextSummary(head);
  return {
    text: summary,
    summary
  };
}

function apply(ctx, config) {
  const maxNoticeBytes = config.maxNoticeBytes ?? 4096;
  const defaultPollMs = config.defaultPollIntervalMs ?? 2000;
  /** id -> watcher */
  const watchers = new Map();
  let seq = 0;

  ctx.systemPrompt.section({
    name: "tool:monitor",
    order: 120,
    text: "You can arm persistent watchers with the monitor tool. A watcher delivers a message into this session whenever new content appears in its source — you are woken even while idle. Do not busy-poll a source you already watch; monitor_list shows what is armed, and monitor_stop disarms a watcher you no longer need."
  });

  function armWatcher(spec, owner) {
    const id = `monitor-${++seq}`;
    const watcher = makeWatcher({ ...spec, id, owner });
    watchers.set(id, watcher);

    // File sources start watching from the current end of the file: only new
    // lines are delivered, never the pre-existing backlog.
    if (watcher.source === "file") {
      watcher.path = expandHome(watcher.path);
      try {
        watcher.cursor = statSync(watcher.path).size;
      } catch {
        watcher.cursor = 0; // file may not exist yet; will be created later
      }
    }

    const tick = async () => {
      if (watcher.stopped) return;
      try {
        if (watcher.source === "file") {
          const { lines, offset } = readFileDelta(watcher.path, watcher.cursor);
          watcher.cursor = offset;
          if (lines.length > 0) {
            for (const line of lines) await deliver(watcher, line.content);
          }
        } else if (watcher.source === "command") {
          const { stdout } = await runCommand(watcher.command, watcher.cwd);
          const current = stdout.endsWith("\n") ? stdout : `${stdout}\n`;
          const prev = watcher.cursor ?? "";
          if (prev !== current) {
            const delta = current.startsWith(prev)
              ? current.slice(prev.length)
              : current;
            watcher.cursor = current;
            const trimmed = delta.trim();
            if (trimmed) await deliver(watcher, trimmed);
          } else {
            watcher.cursor = current;
          }
        }
      } catch (error) {
        ctx.logger.warn(`dsh-monitor ${watcher.id}: ${String(error?.message ?? error)}`);
      }
    };

    const deliver = async (w, content) => {
      if (w.stopped) return;
      const { text, summary } = noticeFor(w, content);
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "plugin",
          plugin: "dsh-monitor",
          form: "notice",
          summary
        }
      });
      const agent = w.owner;
      if (agent) {
        if (agent.status === "idle") {
          agent.followup(message);
        } else {
          agent.inject(message);
        }
      }
      w.delivered += 1;
    };

    const interval = Math.max(watcher.pollIntervalMs ?? defaultPollMs, 100);
    // Global setInterval (harness convention). Cleanup is registered through
    // ctx.effect so every armed timer is torn down with the plugin fiber.
    const timer = setInterval(() => {
      void tick();
    }, interval);
    watcher.timer = () => clearInterval(timer);
    ctx.effect(() => () => {
      if (!watcher.stopped) {
        watcher.stopped = true;
        clearInterval(timer);
        watchers.delete(watcher.id);
      }
    });

    return watcher;
  }

  function stopWatcher(id) {
    const w = watchers.get(id);
    if (!w) return false;
    w.stopped = true;
    if (w.timer) w.timer();
    watchers.delete(id);
    return true;
  }

  ctx.tools.register(defineTool({
    name: "monitor",
    description: "Arm a persistent watcher that wakes you when new messages arrive. Use `source: file` with an append-only NDJSON inbox path (each new line is delivered), or `source: command` with a shell command re-run on an interval (its output delta is delivered). Returns the watcher id; disarm with monitor_stop. A watcher delivers into this session even while you are idle.",
    parameters: {
      source: {
        type: "string",
        required: true,
        enum: ["file", "command"],
        description: "file = watch an append-only ndjson inbox; command = poll a shell command's output."
      },
      path: {
        type: "string",
        description: "Absolute path of the ndjson inbox file (required when source is file)."
      },
      command: {
        type: "string",
        description: "Shell command to poll (required when source is command)."
      },
      cwd: {
        type: "string",
        description: "Working directory for the command (command source only; defaults to the process cwd)."
      },
      poll_interval_ms: {
        type: "number",
        description: `Poll interval in ms (default ${defaultPollMs}).`
      },
      name: {
        type: "string",
        description: "Short label shown in wake-up messages and monitor_list."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          source: { type: "string", required: true },
          description: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `Monitor started (${value.id}, ${value.source}: ${value.description}). You will be woken when new messages arrive.`
      }]
    },
    async execute(args, exec) {
      if (args.source === "file" && !args.path) {
        throw new Error("monitor: source 'file' requires a non-empty path");
      }
      if (args.source === "command" && !args.command) {
        throw new Error("monitor: source 'command' requires a non-empty command");
      }
      const spec = {
        source: args.source,
        path: args.path,
        command: args.command,
        cwd: args.cwd,
        pollIntervalMs: args.poll_interval_ms,
        name: args.name
      };
      const watcher = armWatcher(spec, exec.agent);
      const description =
        args.source === "file" ? args.path : args.command;
      return {
        id: watcher.id,
        source: args.source,
        description
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: args.source === "file"
        ? `Watch inbox ${args.path}`
        : `Watch command ${args.command}`,
      kind: "execute"
    })
  }));

  ctx.tools.register(defineTool({
    name: "monitor_list",
    description: "List armed persistent watchers with their ids, sources, and delivery counts.",
    parameters: {},
    output: {
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            source: { type: "string", required: true },
            description: { type: "string", required: true },
            delivered: { type: "integer", required: true }
          }
        }
      },
      render: (_args, watchersList) => [{
        type: "text",
        text: watchersList.length === 0
          ? "(no armed watchers)"
          : watchersList.map((w) => `${w.id} [${w.source}] ${w.description} (delivered ${w.delivered})`).join("\n")
      }]
    },
    execute(_args, exec) {
      const visible = [];
      for (const w of watchers.values()) {
        visible.push({
          id: w.id,
          source: w.source,
          description: w.source === "file" ? w.path : w.command,
          delivered: w.delivered
        });
      }
      return Promise.resolve(visible);
    },
    presentCall: () => ({ card: "generic", title: "List armed monitors", kind: "read" })
  }));

  ctx.tools.register(defineTool({
    name: "monitor_stop",
    description: "Disarm a persistent watcher by id (see monitor_list). Returns whether it was still armed.",
    parameters: {
      id: {
        type: "string",
        required: true,
        description: "Watcher id returned by monitor."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stopped: { type: "boolean", required: true },
          id: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.stopped
          ? `Monitor ${value.id} disarmed.`
          : `No armed watcher ${value.id}.`
      }]
    },
    execute(args) {
      const stopped = stopWatcher(args.id);
      return Promise.resolve({ stopped, id: args.id });
    },
    presentCall: (args) => ({ card: "generic", title: `Disarm monitor ${args.id}`, kind: "execute" })
  }));
}

export { Config, apply, inject, name };
