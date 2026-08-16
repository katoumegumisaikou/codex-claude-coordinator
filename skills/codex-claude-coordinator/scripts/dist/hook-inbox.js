import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendJsonLine, normalizeHookEvent, sanitizeValue } from "./monitor.js";
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
export function hookEventDedupeKey(event) {
    if (event.toolUseId && TOOL_EVENTS.has(event.kind))
        return `tool:${event.kind}:${event.toolUseId}`;
    if (event.agentId && (event.kind === "SubagentStart" || event.kind === "SubagentStop")) {
        return `agent:${event.kind}:${event.agentId}`;
    }
    if (event.sessionId && (event.kind === "SessionStart" || event.kind === "Stop")) {
        return `session:${event.kind}:${event.sessionId}`;
    }
    if (event.eventId)
        return `event:${event.eventId}`;
    return `${event.kind}:${event.timestamp}:${event.agentId ?? ""}:${event.toolName ?? ""}`;
}
function rejectedName(fileName) {
    return fileName.replace(/\.ready\.json$/, ".rejected.json");
}
export function consumeHookInbox(options) {
    const result = { handled: 0, consumed: 0, duplicates: 0, rejected: 0 };
    if (!existsSync(options.inboxDirectory))
        return result;
    const readyFiles = readdirSync(options.inboxDirectory)
        .filter((fileName) => fileName.endsWith(".ready.json"))
        .sort((left, right) => left.localeCompare(right));
    for (const fileName of readyFiles) {
        const readyPath = join(options.inboxDirectory, fileName);
        const processingPath = join(options.inboxDirectory, fileName.replace(/\.ready\.json$/, ".processing.json"));
        try {
            renameSync(readyPath, processingPath);
        }
        catch (error) {
            const code = error instanceof Error && "code" in error ? String(error.code) : "";
            if (code === "ENOENT")
                continue;
            throw error;
        }
        result.handled += 1;
        let raw;
        let event;
        try {
            raw = JSON.parse(readFileSync(processingPath, "utf8"));
            event = normalizeHookEvent(raw);
            if (!event)
                throw new Error("missing hook event name");
        }
        catch {
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
//# sourceMappingURL=hook-inbox.js.map