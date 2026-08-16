import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const runDirectory = process.env.CODEX_CLAUDE_RUN_DIR;
if (!runDirectory) throw new Error("missing CODEX_CLAUDE_RUN_DIR");
const pluginIndex = process.argv.indexOf("--plugin-dir");
const pluginDirectory = pluginIndex >= 0 ? process.argv[pluginIndex + 1] : undefined;
if (!pluginDirectory || !existsSync(pluginDirectory)) throw new Error("missing valid --plugin-dir");
mkdirSync(runDirectory, { recursive: true });

const hook = (event: Record<string, unknown>): void => {
  appendFileSync(join(runDirectory, "hook-events.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
};
const stream = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

hook({ hookEventName: "SessionStart", sessionId: "fake-session" });
stream({ type: "system", subtype: "init", session_id: "fake-session" });
hook({ hookEventName: "SubagentStart", sessionId: "fake-session", agentId: "agent-1", agentType: "Explore" });
hook({ hookEventName: "PreToolUse", sessionId: "fake-session", agentId: "agent-1", toolName: "Read", toolInputSummary: "src/App.tsx" });
hook({ hookEventName: "PostToolUse", sessionId: "fake-session", agentId: "agent-1", toolName: "Read" });
hook({ hookEventName: "SubagentStop", sessionId: "fake-session", agentId: "agent-1", agentType: "Explore" });

setTimeout(() => {
  const report = "任务摘要\n完成模拟任务\n修改文件\n无\n执行测试\n模拟通过\n验证结果\n通过\n风险\n无\n阻塞问题\n无";
  stream({ type: "result", subtype: "success", session_id: "fake-session", result: report, num_turns: 2, total_cost_usd: 0 });
}, 700);
