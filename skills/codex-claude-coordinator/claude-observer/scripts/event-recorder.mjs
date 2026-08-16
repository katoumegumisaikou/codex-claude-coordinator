import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const runDirectory = process.env.CODEX_CLAUDE_RUN_DIR;
if (!runDirectory) process.exit(0);

let input = "";
for await (const chunk of process.stdin) input += chunk;

const redact = (value, limit = 300) => {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, Math.max(0, limit - 15))}…[truncated]`;
};

const toolSummary = (toolInput) => {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return undefined;
  for (const key of ["command", "description", "query", "pattern", "file_path", "path"]) {
    if (typeof toolInput[key] === "string") return redact(toolInput[key], 240);
  }
  return undefined;
};

try {
  const raw = JSON.parse(input);
  const event = {
    timestamp: new Date().toISOString(),
    hookEventName: raw.hook_event_name,
    sessionId: raw.session_id,
    agentId: raw.agent_id,
    agentType: raw.agent_type,
    toolName: raw.tool_name,
    toolUseId: raw.tool_use_id,
    toolInputSummary: toolSummary(raw.tool_input),
    notificationType: raw.notification_type,
    message: redact(raw.message, 240),
    lastAssistantMessage: redact(raw.last_assistant_message, 300),
    error: redact(raw.error, 240),
    source: raw.source,
  };
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  appendFileSync(join(runDirectory, "hook-events.jsonl"), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
} catch {
  // Observation must never block Claude Code.
}
