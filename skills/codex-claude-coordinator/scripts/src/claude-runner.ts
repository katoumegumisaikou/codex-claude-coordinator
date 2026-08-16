import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJsonLine,
  atomicWriteJson,
  createRunId,
  ensureRuntimeIgnored,
  extractFinalReport,
  isRecord,
  normalizeHookEvent,
  normalizeStreamEvent,
  numberField,
  phaseLabel,
  redactText,
  reportIndicatesBlocker,
  stringField,
  type NormalizedEvent,
  type RunPhase,
  type RunState,
} from "./monitor.js";

type PermissionMode = "acceptEdits" | "auto" | "manual" | "dontAsk" | "plan";

interface Options {
  workdir: string;
  taskFile: string;
  reportFile?: string;
  permissionMode: PermissionMode;
  model?: string;
  maxBudgetUsd?: string;
  maxRuntimeSeconds: number;
  idleTimeoutSeconds: number;
  heartbeatSeconds: number;
  maxSubagents: number;
  maxRepairRounds: number;
}

interface AgentStatus {
  id: string;
  type?: string;
  state: "running" | "completed";
  startedAt: string;
  endedAt?: string;
  currentTool?: string;
}

interface Activity {
  kind: "tool" | "subagent" | "runner";
  label: string;
  startedAt: string;
  agentId?: string;
  toolName?: string;
}

interface RunStatus {
  schemaVersion: 1;
  runId: string;
  projectRoot: string;
  runDirectory: string;
  state: RunState;
  phase: RunPhase;
  phaseLabel: string;
  startedAt: string;
  updatedAt: string;
  lastEventAt: string;
  elapsedSeconds: number;
  sessionId?: string;
  claudePid?: number;
  currentActivity?: Activity;
  agents: AgentStatus[];
  counters: {
    streamEvents: number;
    hookEvents: number;
    toolCalls: number;
    subagentsStarted: number;
  };
  limits: {
    maxRuntimeSeconds: number;
    idleTimeoutSeconds: number;
    maxSubagents: number;
    maxRepairRounds: number;
  };
  files: {
    events: string;
    stderr: string;
    finalReport: string;
    status: string;
  };
  result?: {
    subtype?: string;
    turns?: number;
    costUsd?: number;
  };
  failureReason?: string;
}

const usage = `用法：delegate-to-claude.sh --workdir DIR --task-file FILE [选项]

选项：
  --report-file FILE             额外复制最终 Claude 报告。
  --permission-mode MODE         Claude 权限模式（默认：auto）。
  --model MODEL                  可选 Claude 模型或别名。
  --max-budget-usd AMOUNT        可选最高 API 花费。
  --max-runtime-seconds N        总运行时限（默认：3600）。
  --idle-timeout-seconds N       无事件时限（默认：900）。
  --heartbeat-seconds N          状态心跳间隔（默认：30）。
  --max-subagents N              单次委派最多子代理数（默认：10）。
  --max-repair-rounds N          契约允许的最多修复轮数（默认：3）。
  -h, --help                     显示帮助。`;

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} 必须是正整数。`);
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    }
    if (!argument?.startsWith("--")) throw new Error(`未知参数：${argument ?? ""}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} 需要一个值。`);
    values.set(argument, value);
    index += 1;
  }

  const workdir = values.get("--workdir");
  const taskFile = values.get("--task-file");
  if (!workdir || !taskFile) throw new Error("--workdir 和 --task-file 为必填项。\n\n" + usage);
  const permissionMode = values.get("--permission-mode") ?? "auto";
  if (!["acceptEdits", "auto", "manual", "dontAsk", "plan"].includes(permissionMode)) {
    throw new Error(`不支持的权限模式：${permissionMode}`);
  }

  const known = new Set([
    "--workdir", "--task-file", "--report-file", "--permission-mode", "--model", "--max-budget-usd",
    "--max-runtime-seconds", "--idle-timeout-seconds", "--heartbeat-seconds", "--max-subagents", "--max-repair-rounds",
  ]);
  for (const option of values.keys()) if (!known.has(option)) throw new Error(`未知参数：${option}`);

  return {
    workdir: resolve(workdir),
    taskFile: resolve(taskFile),
    reportFile: values.get("--report-file") ? resolve(values.get("--report-file")!) : undefined,
    permissionMode: permissionMode as PermissionMode,
    model: values.get("--model"),
    maxBudgetUsd: values.get("--max-budget-usd"),
    maxRuntimeSeconds: positiveInteger(values.get("--max-runtime-seconds") ?? "3600", "--max-runtime-seconds"),
    idleTimeoutSeconds: positiveInteger(values.get("--idle-timeout-seconds") ?? "900", "--idle-timeout-seconds"),
    heartbeatSeconds: positiveInteger(values.get("--heartbeat-seconds") ?? "30", "--heartbeat-seconds"),
    maxSubagents: positiveInteger(values.get("--max-subagents") ?? "10", "--max-subagents"),
    maxRepairRounds: positiveInteger(values.get("--max-repair-rounds") ?? "3", "--max-repair-rounds"),
  };
}

function projectRootFor(workdir: string): string {
  const result = spawnSync("git", ["-C", workdir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`工作目录不在 Git 仓库中：${workdir}`);
  const root = result.stdout.trim();
  if (!root) throw new Error(`无法解析项目根目录：${workdir}`);
  return resolve(root);
}

function acquireLock(lockPath: string, runId: string): number {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    writeSync(descriptor, `${JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() })}\n`);
    return descriptor;
  } catch (error) {
    let stale = false;
    try {
      const previous: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
      const previousPid = isRecord(previous) ? previous.pid : undefined;
      if (typeof previousPid === "number") {
        try {
          process.kill(previousPid, 0);
        } catch {
          stale = true;
        }
      } else stale = true;
    } catch {
      stale = true;
    }
    if (stale) {
      rmSync(lockPath, { force: true });
      return acquireLock(lockPath, runId);
    }
    throw new Error(`已有 Claude 写入任务占用当前项目：${lockPath}`, { cause: error });
  }
}

function buildPrompt(task: string, options: Options): string {
  return `你是为 Codex 主代理工作的、边界受限的实现子代理。

严格遵守下方任务契约。编辑前先检查仓库；实现要求的代码和测试，然后执行指定验证。不要提交、推送、重置、变基、切换分支、编辑密钥或删除无关工作。遇到阻塞或需求冲突时停止并报告。

如果契约指定 oh-my-claudecode 工作流，必须实际调用准确的 OMC skill；一个会话只允许一个主循环控制者。不可用时报告阻塞，不要静默降级。最多启动 ${options.maxSubagents} 个子代理，最多进行 ${options.maxRepairRounds} 轮修复；达到边界时停止并报告。外部监控会在 ${options.maxRuntimeSeconds} 秒总时限或 ${options.idleTimeoutSeconds} 秒无事件后终止任务。

最终报告必须使用以下标题：
任务摘要
修改文件
执行测试
验证结果
风险
阻塞问题

--- 任务契约 ---
${task}
--- 任务契约结束 ---`;
}

function claudeArgs(options: Options, pluginDirectory: string): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--include-hook-events",
    "--permission-mode", options.permissionMode,
    "--no-session-persistence",
    "--name", "codex-implementation-subagent",
    "--plugin-dir", pluginDirectory,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.maxBudgetUsd) args.push("--max-budget-usd", options.maxBudgetUsd);
  return args;
}

function extraClaudeArguments(): string[] {
  const serialized = process.env.CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON;
  if (!serialized) return [];
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON 必须是字符串数组 JSON。");
  }
  return parsed;
}

async function run(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.workdir)) throw new Error(`工作目录不存在：${options.workdir}`);
  if (!existsSync(options.taskFile)) throw new Error(`任务文件不存在：${options.taskFile}`);

  const projectRoot = projectRootFor(options.workdir);
  ensureRuntimeIgnored(projectRoot);
  const coordinatorRoot = join(projectRoot, ".codex", "claude-coordinator");
  const runId = createRunId();
  const runDirectory = join(coordinatorRoot, "runs", runId);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(coordinatorRoot, "active.lock");
  const lockDescriptor = acquireLock(lockPath, runId);

  const eventsPath = join(runDirectory, "events.jsonl");
  const hookEventsPath = join(runDirectory, "hook-events.jsonl");
  const stderrPath = join(runDirectory, "stderr.log");
  const finalReportPath = join(runDirectory, "final-report.txt");
  const runStatusPath = join(runDirectory, "status.json");
  const currentStatusPath = join(coordinatorRoot, "status.json");
  for (const path of [eventsPath, hookEventsPath, stderrPath, finalReportPath]) {
    writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
  }
  const startedAtMs = Date.now();
  let lastEventAtMs = startedAtMs;
  let finalReport = "";
  let forcedState: RunState | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let hookOffset = 0;
  let hookRemainder = "";
  let polling = false;
  const agents = new Map<string, AgentStatus>();

  const status: RunStatus = {
    schemaVersion: 1,
    runId,
    projectRoot,
    runDirectory,
    state: "queued",
    phase: "queued",
    phaseLabel: phaseLabel("queued"),
    startedAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date(startedAtMs).toISOString(),
    lastEventAt: new Date(startedAtMs).toISOString(),
    elapsedSeconds: 0,
    agents: [],
    counters: { streamEvents: 0, hookEvents: 0, toolCalls: 0, subagentsStarted: 0 },
    limits: {
      maxRuntimeSeconds: options.maxRuntimeSeconds,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      maxSubagents: options.maxSubagents,
      maxRepairRounds: options.maxRepairRounds,
    },
    files: { events: eventsPath, stderr: stderrPath, finalReport: finalReportPath, status: runStatusPath },
  };

  const persistStatus = (): void => {
    const now = Date.now();
    status.updatedAt = new Date(now).toISOString();
    status.phaseLabel = phaseLabel(status.phase);
    status.lastEventAt = new Date(lastEventAtMs).toISOString();
    status.elapsedSeconds = Math.max(0, Math.round((now - startedAtMs) / 1000));
    status.agents = [...agents.values()];
    atomicWriteJson(runStatusPath, status);
    atomicWriteJson(currentStatusPath, status);
  };

  const noteEvent = (event: NormalizedEvent): void => {
    lastEventAtMs = Date.now();
    appendJsonLine(eventsPath, { ...event, phaseLabel: event.phase ? phaseLabel(event.phase) : undefined });
    if (event.sessionId) status.sessionId = event.sessionId;
    if (event.phase) status.phase = event.phase;

    if (event.source === "claude-hook") {
      status.counters.hookEvents += 1;
      if (event.kind === "SubagentStart") {
        status.counters.subagentsStarted += 1;
        const agentId = event.agentId ?? `unknown-${status.counters.subagentsStarted}`;
        agents.set(agentId, { id: agentId, type: event.agentType, state: "running", startedAt: event.timestamp });
        status.currentActivity = { kind: "subagent", label: event.agentType ?? agentId, agentId, startedAt: event.timestamp };
        if (status.counters.subagentsStarted > options.maxSubagents) {
          forcedState = "failed";
          status.failureReason = `子代理数量超过限制 ${options.maxSubagents}`;
          child?.kill("SIGTERM");
        }
      } else if (event.kind === "SubagentStop" && event.agentId) {
        const agent = agents.get(event.agentId);
        if (agent) agents.set(event.agentId, { ...agent, state: "completed", endedAt: event.timestamp, currentTool: undefined });
        if (status.currentActivity?.agentId === event.agentId) status.currentActivity = undefined;
      } else if (event.kind === "PreToolUse") {
        status.counters.toolCalls += 1;
        status.currentActivity = {
          kind: "tool",
          label: event.summary ? `${event.toolName ?? "tool"}: ${event.summary}` : event.toolName ?? "tool",
          agentId: event.agentId,
          toolName: event.toolName,
          startedAt: event.timestamp,
        };
        if (event.agentId) {
          const agent = agents.get(event.agentId);
          if (agent) agents.set(event.agentId, { ...agent, currentTool: event.toolName });
        }
      } else if ((event.kind === "PostToolUse" || event.kind === "PostToolUseFailure") && status.currentActivity?.kind === "tool") {
        status.currentActivity = undefined;
      }
    } else if (event.source === "claude-stream") {
      status.counters.streamEvents += 1;
    }

    persistStatus();
    if (["PreToolUse", "SubagentStart", "SubagentStop", "PostToolUseFailure"].includes(event.kind)) {
      process.stderr.write(`[claude-coordinator] ${status.phaseLabel} · ${event.kind}${event.toolName ? ` ${event.toolName}` : ""}${event.summary ? ` · ${event.summary}` : ""}\n`);
    }
  };

  const terminate = (state: "timed_out" | "failed", reason: string): void => {
    if (forcedState) return;
    forcedState = state;
    status.state = state;
    status.failureReason = reason;
    noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: state, summary: reason });
    child?.kill("SIGTERM");
    setTimeout(() => {
      if (child && child.exitCode === null) child.kill("SIGKILL");
    }, 5000).unref();
  };

  const pollHookEvents = (): void => {
    if (polling || !existsSync(hookEventsPath)) return;
    polling = true;
    try {
      const size = statSync(hookEventsPath).size;
      if (size < hookOffset) {
        hookOffset = 0;
        hookRemainder = "";
      }
      if (size === hookOffset) return;
      const descriptor = openSync(hookEventsPath, "r");
      try {
        const buffer = Buffer.alloc(size - hookOffset);
        const bytesRead = readSync(descriptor, buffer, 0, buffer.length, hookOffset);
        hookOffset += bytesRead;
        const pieces = `${hookRemainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
        hookRemainder = pieces.pop() ?? "";
        for (const line of pieces) {
          if (!line.trim()) continue;
          try {
            const event = normalizeHookEvent(JSON.parse(line));
            if (event) noteEvent(event);
          } catch {
            noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "invalid-hook-json", summary: "忽略无法解析的 hook 事件" });
          }
        }
      } finally {
        closeSync(descriptor);
      }
    } finally {
      polling = false;
    }
  };

  const pollTimer = setInterval(pollHookEvents, 500);
  const heartbeatTimer = setInterval(() => {
    persistStatus();
    const activity = status.currentActivity?.label ?? "等待 Claude 事件";
    process.stderr.write(`[claude-coordinator] 心跳 · ${status.elapsedSeconds}s · ${status.phaseLabel} · ${activity} · ${runDirectory}\n`);
  }, options.heartbeatSeconds * 1000);
  const watchdogTimer = setInterval(() => {
    const now = Date.now();
    if (now - startedAtMs >= options.maxRuntimeSeconds * 1000) {
      terminate("timed_out", `超过总运行时限 ${options.maxRuntimeSeconds} 秒`);
    } else if (now - lastEventAtMs >= options.idleTimeoutSeconds * 1000) {
      terminate("timed_out", `连续 ${options.idleTimeoutSeconds} 秒没有 Claude 或 hook 事件`);
    }
  }, 1000);

  try {
    status.state = "running";
    status.phase = "preflight";
    status.currentActivity = { kind: "runner", label: "启动 Claude Code", startedAt: new Date().toISOString() };
    noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "started", phase: "preflight", summary: runId });

    const runnerDirectory = dirname(fileURLToPath(import.meta.url));
    const pluginDirectory = resolve(runnerDirectory, "..", "..", "claude-observer");
    const claudeCommand = process.env.CLAUDE_COORDINATOR_CLAUDE_COMMAND ?? "claude";
    const task = readFileSync(options.taskFile, "utf8");
    const executableDirectory = dirname(process.execPath);
    child = spawn(claudeCommand, [...extraClaudeArguments(), ...claudeArgs(options, pluginDirectory)], {
      cwd: options.workdir,
      env: {
        ...process.env,
        PATH: `${executableDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        CODEX_CLAUDE_RUN_ID: runId,
        CODEX_CLAUDE_RUN_DIR: runDirectory,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    status.claudePid = child.pid;
    status.currentActivity = undefined;
    persistStatus();
    child.stdin.end(buildPrompt(task, options));

    let stdoutRemainder = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastEventAtMs = Date.now();
      const lines = `${stdoutRemainder}${chunk}`.split("\n");
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const raw: unknown = JSON.parse(line);
          const event = normalizeStreamEvent(raw);
          if (event) noteEvent(event);
          const report = extractFinalReport(raw);
          if (report !== undefined) finalReport = redactText(report, 200_000);
          if (isRecord(raw) && raw.type === "result") {
            status.result = {
              subtype: stringField(raw, "subtype"),
              turns: numberField(raw, "num_turns"),
              costUsd: numberField(raw, "total_cost_usd"),
            };
          }
        } catch {
          noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "invalid-stream-json", summary: "忽略无法解析的 stream-json 行" });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      lastEventAtMs = Date.now();
      const sanitizedChunk = redactText(chunk, 20_000);
      writeFileSync(stderrPath, sanitizedChunk, { encoding: "utf8", flag: "a", mode: 0o600 });
      process.stderr.write(sanitizedChunk);
    });

    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child?.once("error", reject);
      child?.once("close", resolveExit);
    });
    if (stdoutRemainder.trim()) {
      try {
        const raw: unknown = JSON.parse(stdoutRemainder);
        const event = normalizeStreamEvent(raw);
        if (event) noteEvent(event);
        const report = extractFinalReport(raw);
        if (report !== undefined) finalReport = redactText(report, 200_000);
      } catch {
        noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "invalid-stream-json", summary: "忽略结尾处无法解析的 stream-json" });
      }
    }
    pollHookEvents();

    writeFileSync(finalReportPath, finalReport, { encoding: "utf8", mode: 0o600 });
    if (options.reportFile) {
      mkdirSync(dirname(options.reportFile), { recursive: true });
      writeFileSync(options.reportFile, finalReport, "utf8");
    }
    if (finalReport) process.stdout.write(finalReport.endsWith("\n") ? finalReport : `${finalReport}\n`);

    status.currentActivity = undefined;
    status.phase = "deliver";
    if (forcedState) status.state = forcedState;
    else if (exitCode !== 0) {
      status.state = "failed";
      status.failureReason = `Claude Code 退出码：${exitCode ?? "signal"}`;
    } else if (reportIndicatesBlocker(finalReport)) status.state = "blocked";
    else status.state = "completed";
    noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: status.state, phase: "deliver", summary: status.failureReason });
    return status.state === "completed" ? 0 : status.state === "blocked" ? 3 : status.state === "timed_out" ? 124 : 1;
  } catch (error) {
    status.currentActivity = undefined;
    status.state = forcedState ?? "failed";
    status.failureReason = error instanceof Error ? error.message : String(error);
    noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: status.state, phase: status.phase, summary: status.failureReason });
    throw error;
  } finally {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    clearInterval(watchdogTimer);
    persistStatus();
    closeSync(lockDescriptor);
    rmSync(lockPath, { force: true });
  }
}

run().then(
  (exitCode) => { process.exitCode = exitCode; },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[claude-coordinator] ${message}\n`);
    process.exitCode = 1;
  },
);
