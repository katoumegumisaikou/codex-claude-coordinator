import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendJsonLine, normalizeHookEvent, sanitizeValue, type NormalizedEvent } from "./monitor.js";

export interface ConsumeHookInboxOptions {
  inboxDirectory: string;
  rejectedDirectory: string;
  hookEventsPath: string;
  seenKeys: Set<string>;
  onEvent: (event: NormalizedEvent) => void;
  onDuplicate?: (fileName: string) => void;
  onRejected?: (fileName: string) => void;
}

export interface ConsumeHookInboxResult {
  handled: number;
  consumed: number;
  duplicates: number;
  rejected: number;
}

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

export function hookEventDedupeKey(event: NormalizedEvent): string {
  if (event.toolUseId && TOOL_EVENTS.has(event.kind)) return `tool:${event.kind}:${event.toolUseId}`;
  if (event.agentId && (event.kind === "SubagentStart" || event.kind === "SubagentStop")) {
    return `agent:${event.kind}:${event.agentId}`;
  }
  if (event.sessionId && (event.kind === "SessionStart" || event.kind === "Stop")) {
    return `session:${event.kind}:${event.sessionId}`;
  }
  if (event.eventId) return `event:${event.eventId}`;
  return `${event.kind}:${event.timestamp}:${event.agentId ?? ""}:${event.toolName ?? ""}`;
}

function rejectedName(fileName: string): string {
  return fileName.replace(/\.ready\.json$/, ".rejected.json");
}

export function consumeHookInbox(options: ConsumeHookInboxOptions): ConsumeHookInboxResult {
  const result: ConsumeHookInboxResult = { handled: 0, consumed: 0, duplicates: 0, rejected: 0 };
  if (!existsSync(options.inboxDirectory)) return result;

  const readyFiles = readdirSync(options.inboxDirectory)
    .filter((fileName) => fileName.endsWith(".ready.json"))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of readyFiles) {
    const readyPath = join(options.inboxDirectory, fileName);
    const processingPath = join(options.inboxDirectory, fileName.replace(/\.ready\.json$/, ".processing.json"));
    try {
      renameSync(readyPath, processingPath);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code === "ENOENT") continue;
      throw error;
    }
    result.handled += 1;

    let raw: unknown;
    let event: NormalizedEvent | undefined;
    try {
      raw = JSON.parse(readFileSync(processingPath, "utf8"));
      event = normalizeHookEvent(raw);
      if (!event) throw new Error("missing hook event name");
    } catch {
      mkdirSync(options.rejectedDirectory, { recursive: true, mode: 0o700 });
      renameSync(processingPath, join(options.rejectedDirectory, rejectedName(fileName)));
      result.rejected += 1;
      options.onRejected?.(fileName);
      continue;
    }

    const dedupeKey = hookEventDedupeKey(event);
    if (options.seenKeys.has(dedupeKey)) {
      rmSync(processingPath, { force: true });
      result.duplicates += 1;
      options.onDuplicate?.(fileName);
      continue;
    }

    options.seenKeys.add(dedupeKey);
    appendJsonLine(options.hookEventsPath, sanitizeValue(raw));
    options.onEvent(event);
    rmSync(processingPath, { force: true });
    result.consumed += 1;
  }

  return result;
}
