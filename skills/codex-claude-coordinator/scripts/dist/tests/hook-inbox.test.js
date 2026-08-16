import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeHookInbox } from "../hook-inbox.js";
test("inbox consumption is sorted, deduplicated, and isolates invalid files", () => {
    const runDirectory = mkdtempSync(join(tmpdir(), "coordinator-hook-inbox-"));
    try {
        const inboxDirectory = join(runDirectory, "hooks-inbox");
        const rejectedDirectory = join(runDirectory, "hooks-rejected");
        const hookEventsPath = join(runDirectory, "hook-events.jsonl");
        mkdirSync(inboxDirectory, { recursive: true });
        const event = (overrides) => `${JSON.stringify({
            eventId: "event-default",
            timestamp: "2026-01-01T00:00:00.000Z",
            hookEventName: "SessionStart",
            sessionId: "session-1",
            ...overrides,
        })}\n`;
        writeFileSync(join(inboxDirectory, "0000000000200-2-b.ready.json"), event({
            eventId: "event-tool",
            hookEventName: "PreToolUse",
            toolUseId: "tool-1",
            toolName: "Bash",
            toolInputSummary: "npm test token=secret",
        }), { encoding: "utf8", flag: "wx" });
        writeFileSync(join(inboxDirectory, "0000000000100-1-a.ready.json"), event({ eventId: "event-session" }), { encoding: "utf8", flag: "wx" });
        writeFileSync(join(inboxDirectory, "0000000000300-3-c.ready.json"), event({
            eventId: "event-tool-duplicate",
            hookEventName: "PreToolUse",
            toolUseId: "tool-1",
            toolName: "Bash",
        }), { encoding: "utf8", flag: "wx" });
        writeFileSync(join(inboxDirectory, "0000000000400-4-d.ready.json"), "{not-json", { encoding: "utf8", flag: "wx" });
        writeFileSync(join(inboxDirectory, ".unfinished.tmp"), "{partial", { encoding: "utf8", flag: "wx" });
        const kinds = [];
        const result = consumeHookInbox({
            inboxDirectory,
            rejectedDirectory,
            hookEventsPath,
            seenKeys: new Set(),
            onEvent: (normalized) => kinds.push(normalized.kind),
        });
        assert.deepEqual(result, { handled: 4, consumed: 2, duplicates: 1, rejected: 1 });
        assert.deepEqual(kinds, ["SessionStart", "PreToolUse"]);
        assert.equal(readdirSync(inboxDirectory).filter((fileName) => fileName.endsWith(".ready.json")).length, 0);
        assert.equal(existsSync(join(inboxDirectory, ".unfinished.tmp")), true);
        assert.equal(readdirSync(rejectedDirectory).filter((fileName) => fileName.endsWith(".rejected.json")).length, 1);
        const canonical = readFileSync(hookEventsPath, "utf8");
        assert.equal(canonical.trim().split("\n").length, 2);
        assert.doesNotMatch(canonical, /token=secret/);
    }
    finally {
        rmSync(runDirectory, { recursive: true, force: true });
    }
});
//# sourceMappingURL=hook-inbox.test.js.map