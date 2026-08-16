import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type RunState = "queued" | "running" | "completed" | "blocked" | "failed" | "timed_out";
export type TimeoutProfile = "small" | "general" | "heavy" | "unlimited";
export type TimeoutKind = "runtime" | "idle";

export interface TimeoutLimits {
  maxRuntimeSeconds: number | null;
  idleTimeoutSeconds: number | null;
}

const TIMEOUT_PROFILES: Record<TimeoutProfile, TimeoutLimits> = {
  small: { maxRuntimeSeconds: 1_200, idleTimeoutSeconds: 300 },
  general: { maxRuntimeSeconds: 3_600, idleTimeoutSeconds: 900 },
  heavy: { maxRuntimeSeconds: 14_400, idleTimeoutSeconds: 1_800 },
  unlimited: { maxRuntimeSeconds: null, idleTimeoutSeconds: null },
};

export function timeoutLimitsForProfile(profile: TimeoutProfile): TimeoutLimits {
  return { ...TIMEOUT_PROFILES[profile] };
}

export function timeoutKindAt(
  nowMs: number,
  startedAtMs: number,
  lastEventAtMs: number,
  limits: TimeoutLimits,
): TimeoutKind | undefined {
  if (limits.maxRuntimeSeconds !== null && nowMs - startedAtMs >= limits.maxRuntimeSeconds * 1_000) return "runtime";
  if (limits.idleTimeoutSeconds !== null && nowMs - lastEventAtMs >= limits.idleTimeoutSeconds * 1_000) return "idle";
  return undefined;
}

export interface NormalizedEvent {
  timestamp: string;
  source: "runner" | "claude-stream" | "claude-hook";
  kind: string;
  eventId?: string;
  observedAtUnixMs?: number;
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  toolUseId?: string;
  toolName?: string;
  summary?: string;
  data?: unknown;
}

const SECRET_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const OMITTED_KEY = /^(?:thinking|signature|prompt|transcript_path|tool_response|full_content)$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

export function numberField(value: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

export function redactText(value: string, limit = 500): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return redacted.length <= limit ? redacted : `${redacted.slice(0, Math.max(0, limit - 15))}…[truncated]`;
}

export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[depth-limited]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (!isRecord(value)) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value).slice(0, 40)) {
    if (OMITTED_KEY.test(key)) continue;
    sanitized[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(nestedValue, depth + 1);
  }
  return sanitized;
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(path, { force: true });
    try {
      renameSync(temporaryPath, path);
    } catch {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function ensureRuntimeIgnored(projectRoot: string): boolean {
  const ignorePath = join(projectRoot, ".gitignore");
  const pattern = "/.codex/claude-coordinator/";
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (existing.split(/\r?\n/).some((line) => line.trim() === pattern)) return false;

  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const addition = "# Codex + Claude coordinator runtime state\n/.codex/claude-coordinator/\n";
  writeFileSync(ignorePath, `${existing}${prefix}${addition}`, "utf8");
  return true;
}

function safeToolSummary(raw: Record<string, unknown>): string | undefined {
  const supplied = stringField(raw, "summary", "toolInputSummary", "tool_input_summary");
  if (supplied) return redactText(supplied, 240);
  const toolInput = raw.tool_input ?? raw.toolInput;
  if (!isRecord(toolInput)) return undefined;
  for (const key of ["command", "description", "query", "pattern", "file_path", "path"]) {
    const candidate = toolInput[key];
    if (typeof candidate === "string") return redactText(candidate.replace(/\s+/g, " "), 240);
  }
  return undefined;
}

export function normalizeHookEvent(raw: unknown, timestamp = new Date().toISOString()): NormalizedEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const hookName = stringField(raw, "hookEventName", "hook_event_name");
  if (!hookName) return undefined;
  const toolName = stringField(raw, "toolName", "tool_name");
  const summary = safeToolSummary(raw);

  return {
    timestamp: stringField(raw, "timestamp") ?? timestamp,
    source: "claude-hook",
    kind: hookName,
    eventId: stringField(raw, "eventId", "event_id"),
    observedAtUnixMs: numberField(raw, "observedAtUnixMs", "observed_at_unix_ms"),
    sessionId: stringField(raw, "sessionId", "session_id"),
    agentId: stringField(raw, "agentId", "agent_id"),
    agentType: stringField(raw, "agentType", "agent_type"),
    toolUseId: stringField(raw, "toolUseId", "tool_use_id"),
    toolName,
    summary,
    data: sanitizeValue(raw),
  };
}

function nestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

export function normalizeStreamEvent(raw: unknown, timestamp = new Date().toISOString()): NormalizedEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const type = stringField(raw, "type") ?? "unknown";
  let kind = type;
  let toolUseId: string | undefined;
  let toolName: string | undefined;
  let summary: string | undefined;

  if (type === "system") {
    kind = stringField(raw, "subtype") ? `system:${stringField(raw, "subtype")}` : type;
  } else if (type === "result") {
    kind = stringField(raw, "subtype") ? `result:${stringField(raw, "subtype")}` : type;
  } else if (type === "stream_event") {
    const event = nestedRecord(raw, "event");
    const eventType = stringField(event, "type");
    if (eventType === "content_block_delta" || eventType === "message_delta" || eventType === "ping") return undefined;
    kind = eventType ? `stream:${eventType}` : type;
    const contentBlock = nestedRecord(event, "content_block");
    if (stringField(contentBlock, "type") === "tool_use") {
      toolUseId = stringField(contentBlock, "id");
      toolName = stringField(contentBlock, "name");
      summary = safeToolSummary({ tool_input: contentBlock?.input });
    }
  } else if (/hook/i.test(type)) {
    kind = type;
  }

  const safeData: Record<string, unknown> = {};
  for (const key of ["type", "subtype", "session_id", "uuid", "is_error", "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd"]) {
    if (key in raw) safeData[key] = sanitizeValue(raw[key]);
  }

  return {
    timestamp,
    source: "claude-stream",
    kind,
    eventId: stringField(raw, "uuid"),
    sessionId: stringField(raw, "session_id"),
    toolUseId,
    toolName,
    summary,
    data: safeData,
  };
}

export function extractFinalReport(raw: unknown): string | undefined {
  if (!isRecord(raw) || raw.type !== "result") return undefined;
  const result = raw.result;
  return typeof result === "string" ? result : undefined;
}

export function reportIndicatesBlocker(report: string): boolean {
  const match = report.match(/(?:^|\n)(?:#{1,6}\s*)?阻塞问题[:：]?\s*\n([\s\S]*?)\s*$/);
  if (!match) return false;
  const detail = match[1]?.trim() ?? "";
  return detail.length > 0 && !/^(?:无|没有|none|n\/a|不适用)[。.!\s]*$/i.test(detail);
}

export function createRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}
