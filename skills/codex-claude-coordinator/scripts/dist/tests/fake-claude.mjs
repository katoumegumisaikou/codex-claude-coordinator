import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const runDirectory = process.env.CODEX_CLAUDE_RUN_DIR;
if (!runDirectory)
    throw new Error("missing CODEX_CLAUDE_RUN_DIR");
const pluginIndex = process.argv.indexOf("--plugin-dir");
const pluginDirectory = pluginIndex >= 0 ? process.argv[pluginIndex + 1] : undefined;
if (!pluginDirectory || !existsSync(pluginDirectory))
    throw new Error("missing valid --plugin-dir");
mkdirSync(runDirectory, { recursive: true });
const recorder = join(pluginDirectory, "scripts", "event-recorder.mjs");
const hook = (event) => {
    const result = spawnSync(process.execPath, [recorder], {
        encoding: "utf8",
        input: JSON.stringify(event),
        env: process.env,
    });
    if (result.status !== 0)
        throw new Error(result.stderr);
};
const stream = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
};
hook({ hook_event_name: "SessionStart", session_id: "fake-session" });
stream({ type: "system", subtype: "init", session_id: "fake-session" });
hook({ hook_event_name: "SubagentStart", session_id: "fake-session", agent_id: "agent-1", agent_type: "Explore" });
hook({ hook_event_name: "PreToolUse", session_id: "fake-session", agent_id: "agent-1", tool_name: "Read", tool_use_id: "tool-1", tool_input: { file_path: "src/App.tsx" } });
hook({ hook_event_name: "PostToolUse", session_id: "fake-session", agent_id: "agent-1", tool_name: "Read", tool_use_id: "tool-1" });
hook({ hook_event_name: "SubagentStop", session_id: "fake-session", agent_id: "agent-1", agent_type: "Explore" });
setTimeout(() => {
    const report = "任务摘要\n完成模拟任务\n修改文件\n无\n执行测试\n模拟通过\n验证结果\n通过\n风险\n无\n阻塞问题\n无";
    stream({ type: "result", subtype: "success", session_id: "fake-session", result: report, num_turns: 2, total_cost_usd: 0 });
}, 10);
//# sourceMappingURL=fake-claude.mjs.map