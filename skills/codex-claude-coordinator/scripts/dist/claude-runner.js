import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolActivityTracker } from "./activity-tracker.js";
import { consumeHookInbox } from "./hook-inbox.js";
import { appendJsonLine, atomicWriteJson, createRunId, ensureRuntimeIgnored, extractFinalReport, isRecord, normalizeStreamEvent, numberField, redactText, reportIndicatesBlocker, stringField, timeoutKindAt, timeoutLimitsForProfile, } from "./monitor.js";
const usage = `用法：delegate-to-claude.sh --workdir DIR --task-file FILE [选项]

选项：
  --report-file FILE             额外复制最终 Claude 报告。
  --permission-mode MODE         Claude 权限模式（默认：auto）。
  --model MODEL                  可选 Claude 模型或别名。
  --max-budget-usd AMOUNT        可选最高 API 花费。
  --timeout-profile PROFILE      small、general、heavy 或 unlimited（默认：general）。
  --max-runtime-seconds N|off    覆盖配置档的总运行时限。
  --idle-timeout-seconds N|off   覆盖配置档的无事件时限。
  --heartbeat-seconds N          状态心跳间隔（默认：30）。
  --max-subagents N              单次委派最多子代理数（默认：10）。
  --max-repair-rounds N          契约允许的最多修复轮数（默认：3）。
  -h, --help                     显示帮助。`;
function positiveInteger(value, option) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
        throw new Error(`${option} 必须是正整数。`);
    return parsed;
}
function timeoutValue(value, option, fallback) {
    if (value === undefined)
        return fallback;
    if (value.toLowerCase() === "off")
        return null;
    return positiveInteger(value, option);
}
function parseArgs(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "-h" || argument === "--help") {
            process.stdout.write(`${usage}\n`);
            process.exit(0);
        }
        if (!argument?.startsWith("--"))
            throw new Error(`未知参数：${argument ?? ""}`);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--"))
            throw new Error(`${argument} 需要一个值。`);
        values.set(argument, value);
        index += 1;
    }
    const workdir = values.get("--workdir");
    const taskFile = values.get("--task-file");
    if (!workdir || !taskFile)
        throw new Error("--workdir 和 --task-file 为必填项。\n\n" + usage);
    const permissionMode = values.get("--permission-mode") ?? "auto";
    if (!["acceptEdits", "auto", "manual", "dontAsk", "plan"].includes(permissionMode)) {
        throw new Error(`不支持的权限模式：${permissionMode}`);
    }
    const timeoutProfile = values.get("--timeout-profile") ?? "general";
    if (!["small", "general", "heavy", "unlimited"].includes(timeoutProfile)) {
        throw new Error(`不支持的超时配置档：${timeoutProfile}`);
    }
    const profileTimeouts = timeoutLimitsForProfile(timeoutProfile);
    const known = new Set([
        "--workdir", "--task-file", "--report-file", "--permission-mode", "--model", "--max-budget-usd",
        "--timeout-profile", "--max-runtime-seconds", "--idle-timeout-seconds", "--heartbeat-seconds", "--max-subagents", "--max-repair-rounds",
    ]);
    for (const option of values.keys())
        if (!known.has(option))
            throw new Error(`未知参数：${option}`);
    return {
        workdir: resolve(workdir),
        taskFile: resolve(taskFile),
        reportFile: values.get("--report-file") ? resolve(values.get("--report-file")) : undefined,
        permissionMode: permissionMode,
        model: values.get("--model"),
        maxBudgetUsd: values.get("--max-budget-usd"),
        timeoutProfile: timeoutProfile,
        maxRuntimeSeconds: timeoutValue(values.get("--max-runtime-seconds"), "--max-runtime-seconds", profileTimeouts.maxRuntimeSeconds),
        idleTimeoutSeconds: timeoutValue(values.get("--idle-timeout-seconds"), "--idle-timeout-seconds", profileTimeouts.idleTimeoutSeconds),
        heartbeatSeconds: positiveInteger(values.get("--heartbeat-seconds") ?? "30", "--heartbeat-seconds"),
        maxSubagents: positiveInteger(values.get("--max-subagents") ?? "10", "--max-subagents"),
        maxRepairRounds: positiveInteger(values.get("--max-repair-rounds") ?? "3", "--max-repair-rounds"),
    };
}
function projectRootFor(workdir) {
    const result = spawnSync("git", ["-C", workdir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (result.status !== 0)
        throw new Error(`工作目录不在 Git 仓库中：${workdir}`);
    const root = result.stdout.trim();
    if (!root)
        throw new Error(`无法解析项目根目录：${workdir}`);
    return resolve(root);
}
function acquireLock(lockPath, runId) {
    mkdirSync(dirname(lockPath), { recursive: true });
    try {
        const descriptor = openSync(lockPath, "wx", 0o600);
        writeSync(descriptor, `${JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() })}\n`);
        return descriptor;
    }
    catch (error) {
        let stale = false;
        try {
            const previous = JSON.parse(readFileSync(lockPath, "utf8"));
            const previousPid = isRecord(previous) ? previous.pid : undefined;
            if (typeof previousPid === "number") {
                try {
                    process.kill(previousPid, 0);
                }
                catch {
                    stale = true;
                }
            }
            else
                stale = true;
        }
        catch {
            stale = true;
        }
        if (stale) {
            rmSync(lockPath, { force: true });
            return acquireLock(lockPath, runId);
        }
        throw new Error(`已有 Claude 写入任务占用当前项目：${lockPath}`, { cause: error });
    }
}
function buildPrompt(task, options) {
    const timeoutDescription = options.maxRuntimeSeconds === null && options.idleTimeoutSeconds === null
        ? "外部协调器不设置总运行或空闲超时，但子代理数和修复轮数限制仍然有效。"
        : `外部监控${options.maxRuntimeSeconds === null ? "不设置总运行时限" : `会在 ${options.maxRuntimeSeconds} 秒总时限后终止任务`}，${options.idleTimeoutSeconds === null ? "不设置空闲时限" : `并在连续 ${options.idleTimeoutSeconds} 秒无事件后终止任务`}。`;
    return `你是为 Codex 主代理工作的、边界受限的实现子代理。

严格遵守下方任务契约。编辑前先检查仓库；实现要求的代码和测试，然后执行指定验证。不要提交、推送、重置、变基、切换分支、编辑密钥或删除无关工作。遇到阻塞或需求冲突时停止并报告。

如果契约指定 oh-my-claudecode 工作流，必须实际调用准确的 OMC skill；一个会话只允许一个主循环控制者。不可用时报告阻塞，不要静默降级。最多启动 ${options.maxSubagents} 个子代理，最多进行 ${options.maxRepairRounds} 轮修复；达到边界时停止并报告。${timeoutDescription}

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
function claudeArgs(options, pluginDirectory) {
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
    if (options.model)
        args.push("--model", options.model);
    if (options.maxBudgetUsd)
        args.push("--max-budget-usd", options.maxBudgetUsd);
    return args;
}
function extraClaudeArguments() {
    const serialized = process.env.CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON;
    if (!serialized)
        return [];
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error("CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON 必须是字符串数组 JSON。");
    }
    return parsed;
}
async function run() {
    const options = parseArgs(process.argv.slice(2));
    if (!existsSync(options.workdir))
        throw new Error(`工作目录不存在：${options.workdir}`);
    if (!existsSync(options.taskFile))
        throw new Error(`任务文件不存在：${options.taskFile}`);
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
    const hookInboxPath = join(runDirectory, "hooks-inbox");
    const hookRejectedPath = join(runDirectory, "hooks-rejected");
    const stderrPath = join(runDirectory, "stderr.log");
    const finalReportPath = join(runDirectory, "final-report.txt");
    const runStatusPath = join(runDirectory, "status.json");
    const currentStatusPath = join(coordinatorRoot, "status.json");
    for (const path of [eventsPath, hookEventsPath, stderrPath, finalReportPath]) {
        writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
    }
    mkdirSync(hookInboxPath, { recursive: true, mode: 0o700 });
    const startedAtMs = Date.now();
    let lastEventAtMs = startedAtMs;
    let finalReport = "";
    let forcedState;
    let child;
    let polling = false;
    const agents = new Map();
    const stoppedAgents = new Map();
    const toolActivities = new ToolActivityTracker();
    const seenHookKeys = new Set();
    const status = {
        schemaVersion: 3,
        runId,
        projectRoot,
        runDirectory,
        state: "queued",
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: new Date(startedAtMs).toISOString(),
        lastEventAt: new Date(startedAtMs).toISOString(),
        elapsedSeconds: 0,
        agents: [],
        counters: {
            streamEvents: 0,
            hookEvents: 0,
            toolCalls: 0,
            subagentsStarted: 0,
            hookDuplicates: 0,
            hookRejected: 0,
        },
        timeouts: {
            profile: options.timeoutProfile,
            maxRuntimeSeconds: options.maxRuntimeSeconds,
            idleTimeoutSeconds: options.idleTimeoutSeconds,
        },
        limits: {
            maxSubagents: options.maxSubagents,
            maxRepairRounds: options.maxRepairRounds,
        },
        files: {
            events: eventsPath,
            hookEvents: hookEventsPath,
            hookInbox: hookInboxPath,
            hookRejected: hookRejectedPath,
            stderr: stderrPath,
            finalReport: finalReportPath,
            status: runStatusPath,
        },
    };
    const persistStatus = () => {
        const now = Date.now();
        status.updatedAt = new Date(now).toISOString();
        status.lastEventAt = new Date(lastEventAtMs).toISOString();
        status.elapsedSeconds = Math.max(0, Math.round((now - startedAtMs) / 1000));
        status.agents = [...agents.values()];
        atomicWriteJson(runStatusPath, status);
        atomicWriteJson(currentStatusPath, status);
    };
    const refreshCurrentActivity = () => {
        const toolActivity = toolActivities.latest();
        if (toolActivity) {
            status.currentActivity = toolActivity;
            return;
        }
        const runningAgent = [...agents.values()].reverse().find((agent) => agent.state === "running");
        status.currentActivity = runningAgent
            ? { kind: "subagent", label: runningAgent.type ?? runningAgent.id, agentId: runningAgent.id, startedAt: runningAgent.startedAt }
            : undefined;
    };
    const noteEvent = (event) => {
        lastEventAtMs = Date.now();
        appendJsonLine(eventsPath, event);
        if (event.sessionId)
            status.sessionId = event.sessionId;
        if (event.source === "claude-hook") {
            status.counters.hookEvents += 1;
            if (event.kind === "SubagentStart") {
                status.counters.subagentsStarted += 1;
                const agentId = event.agentId ?? `unknown-${status.counters.subagentsStarted}`;
                const stoppedAt = stoppedAgents.get(agentId);
                agents.set(agentId, {
                    id: agentId,
                    type: event.agentType,
                    state: stoppedAt ? "completed" : "running",
                    startedAt: event.timestamp,
                    endedAt: stoppedAt,
                });
                if (status.counters.subagentsStarted > options.maxSubagents) {
                    forcedState = "failed";
                    status.failureReason = `子代理数量超过限制 ${options.maxSubagents}`;
                    child?.kill("SIGTERM");
                }
            }
            else if (event.kind === "SubagentStop" && event.agentId) {
                stoppedAgents.set(event.agentId, event.timestamp);
                const agent = agents.get(event.agentId);
                if (agent)
                    agents.set(event.agentId, { ...agent, state: "completed", endedAt: event.timestamp, currentTool: undefined });
                toolActivities.removeAgent(event.agentId);
            }
            else if (event.kind === "PreToolUse") {
                status.counters.toolCalls += 1;
                toolActivities.start(event, {
                    kind: "tool",
                    label: event.summary ? `${event.toolName ?? "tool"}: ${event.summary}` : event.toolName ?? "tool",
                    eventId: event.eventId,
                    toolUseId: event.toolUseId,
                    agentId: event.agentId,
                    toolName: event.toolName,
                    startedAt: event.timestamp,
                });
                if (event.agentId) {
                    const agent = agents.get(event.agentId);
                    const currentTool = toolActivities.latestForAgent(event.agentId)?.toolName;
                    if (agent)
                        agents.set(event.agentId, { ...agent, currentTool });
                }
            }
            else if (event.kind === "PostToolUse" || event.kind === "PostToolUseFailure") {
                const finishedActivity = toolActivities.finish(event);
                const activityAgentId = event.agentId ?? finishedActivity?.agentId;
                if (activityAgentId) {
                    const agent = agents.get(activityAgentId);
                    const currentTool = toolActivities.latestForAgent(activityAgentId)?.toolName;
                    if (agent)
                        agents.set(activityAgentId, { ...agent, currentTool });
                }
            }
            refreshCurrentActivity();
        }
        else if (event.source === "claude-stream") {
            status.counters.streamEvents += 1;
        }
        persistStatus();
        if (["PreToolUse", "SubagentStart", "SubagentStop", "PostToolUseFailure"].includes(event.kind)) {
            process.stderr.write(`[claude-coordinator] ${event.kind}${event.toolName ? ` ${event.toolName}` : ""}${event.summary ? ` · ${event.summary}` : ""}\n`);
        }
    };
    const terminate = (state, reason, timeoutKind) => {
        if (forcedState)
            return;
        forcedState = state;
        status.state = state;
        status.failureReason = reason;
        const triggeredAt = new Date().toISOString();
        if (timeoutKind) {
            const limitSeconds = timeoutKind === "runtime" ? options.maxRuntimeSeconds : options.idleTimeoutSeconds;
            if (limitSeconds !== null)
                status.timeout = { kind: timeoutKind, limitSeconds, triggeredAt };
        }
        noteEvent({ timestamp: triggeredAt, source: "runner", kind: timeoutKind ? `${timeoutKind}_timeout` : state, summary: reason });
        child?.kill("SIGTERM");
        setTimeout(() => {
            if (child && child.exitCode === null)
                child.kill("SIGKILL");
        }, 5000).unref();
    };
    const pollHookEvents = () => {
        if (polling)
            return 0;
        polling = true;
        try {
            const result = consumeHookInbox({
                inboxDirectory: hookInboxPath,
                rejectedDirectory: hookRejectedPath,
                hookEventsPath,
                seenKeys: seenHookKeys,
                onEvent: noteEvent,
                onDuplicate: () => {
                    status.counters.hookDuplicates += 1;
                    persistStatus();
                },
                onRejected: (fileName) => {
                    status.counters.hookRejected += 1;
                    noteEvent({
                        timestamp: new Date().toISOString(),
                        source: "runner",
                        kind: "invalid-hook-json",
                        summary: `隔离无法解析的 Hook 事件文件：${fileName}`,
                    });
                },
            });
            return result.handled;
        }
        finally {
            polling = false;
        }
    };
    const drainHookEvents = async () => {
        const deadline = Date.now() + 1_000;
        let quietSince = Date.now();
        while (Date.now() < deadline) {
            const handled = pollHookEvents();
            if (handled > 0)
                quietSince = Date.now();
            if (Date.now() - quietSince >= 250)
                return;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
    };
    const pollTimer = setInterval(pollHookEvents, 500);
    const heartbeatTimer = setInterval(() => {
        persistStatus();
        const activity = status.currentActivity?.label ?? "等待 Claude 事件";
        process.stderr.write(`[claude-coordinator] 心跳 · ${status.elapsedSeconds}s · ${status.state} · ${activity} · ${runDirectory}\n`);
    }, options.heartbeatSeconds * 1000);
    const watchdogTimer = options.maxRuntimeSeconds === null && options.idleTimeoutSeconds === null ? undefined : setInterval(() => {
        const now = Date.now();
        const timeoutKind = timeoutKindAt(now, startedAtMs, lastEventAtMs, options);
        if (timeoutKind === "runtime" && options.maxRuntimeSeconds !== null) {
            terminate("timed_out", `超过总运行时限 ${options.maxRuntimeSeconds} 秒`, timeoutKind);
        }
        else if (timeoutKind === "idle" && options.idleTimeoutSeconds !== null) {
            terminate("timed_out", `连续 ${options.idleTimeoutSeconds} 秒没有 Claude 或 hook 事件`, timeoutKind);
        }
    }, 1000);
    try {
        status.state = "running";
        status.currentActivity = { kind: "runner", label: "启动 Claude Code", startedAt: new Date().toISOString() };
        noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "started", summary: runId });
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
        child.stdout.on("data", (chunk) => {
            lastEventAtMs = Date.now();
            const lines = `${stdoutRemainder}${chunk}`.split("\n");
            stdoutRemainder = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    const raw = JSON.parse(line);
                    const event = normalizeStreamEvent(raw);
                    if (event)
                        noteEvent(event);
                    const report = extractFinalReport(raw);
                    if (report !== undefined)
                        finalReport = redactText(report, 200_000);
                    if (isRecord(raw) && raw.type === "result") {
                        status.result = {
                            subtype: stringField(raw, "subtype"),
                            turns: numberField(raw, "num_turns"),
                            costUsd: numberField(raw, "total_cost_usd"),
                        };
                    }
                }
                catch {
                    noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "invalid-stream-json", summary: "忽略无法解析的 stream-json 行" });
                }
            }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            lastEventAtMs = Date.now();
            const sanitizedChunk = redactText(chunk, 20_000);
            writeFileSync(stderrPath, sanitizedChunk, { encoding: "utf8", flag: "a", mode: 0o600 });
            process.stderr.write(sanitizedChunk);
        });
        const exitCode = await new Promise((resolveExit, reject) => {
            child?.once("error", reject);
            child?.once("close", resolveExit);
        });
        if (stdoutRemainder.trim()) {
            try {
                const raw = JSON.parse(stdoutRemainder);
                const event = normalizeStreamEvent(raw);
                if (event)
                    noteEvent(event);
                const report = extractFinalReport(raw);
                if (report !== undefined)
                    finalReport = redactText(report, 200_000);
            }
            catch {
                noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: "invalid-stream-json", summary: "忽略结尾处无法解析的 stream-json" });
            }
        }
        clearInterval(pollTimer);
        await drainHookEvents();
        writeFileSync(finalReportPath, finalReport, { encoding: "utf8", mode: 0o600 });
        if (options.reportFile) {
            mkdirSync(dirname(options.reportFile), { recursive: true });
            writeFileSync(options.reportFile, finalReport, "utf8");
        }
        if (finalReport)
            process.stdout.write(finalReport.endsWith("\n") ? finalReport : `${finalReport}\n`);
        status.currentActivity = undefined;
        if (forcedState)
            status.state = forcedState;
        else if (exitCode !== 0) {
            status.state = "failed";
            status.failureReason = `Claude Code 退出码：${exitCode ?? "signal"}`;
        }
        else if (reportIndicatesBlocker(finalReport))
            status.state = "blocked";
        else
            status.state = "completed";
        noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: status.state, summary: status.failureReason });
        return status.state === "completed" ? 0 : status.state === "blocked" ? 3 : status.state === "timed_out" ? 124 : 1;
    }
    catch (error) {
        status.currentActivity = undefined;
        status.state = forcedState ?? "failed";
        status.failureReason = error instanceof Error ? error.message : String(error);
        noteEvent({ timestamp: new Date().toISOString(), source: "runner", kind: status.state, summary: status.failureReason });
        throw error;
    }
    finally {
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        if (watchdogTimer)
            clearInterval(watchdogTimer);
        persistStatus();
        closeSync(lockDescriptor);
        rmSync(lockPath, { force: true });
    }
}
run().then((exitCode) => { process.exitCode = exitCode; }, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[claude-coordinator] ${message}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=claude-runner.js.map