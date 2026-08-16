import assert from "node:assert/strict";
import test from "node:test";
import { ToolActivityTracker } from "../activity-tracker.js";
const hookEvent = (kind, toolUseId, agentId) => ({
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "claude-hook",
    kind,
    eventId: `${kind}-${toolUseId}`,
    toolUseId,
    agentId,
    toolName: "Read",
});
const activity = (toolUseId, agentId) => ({
    kind: "tool",
    label: toolUseId,
    startedAt: "2026-01-01T00:00:00.000Z",
    toolUseId,
    agentId,
    toolName: "Read",
});
test("tool activity completion only removes the matching concurrent call", () => {
    const tracker = new ToolActivityTracker();
    tracker.start(hookEvent("PreToolUse", "tool-a", "agent-a"), activity("tool-a", "agent-a"));
    tracker.start(hookEvent("PreToolUse", "tool-b", "agent-b"), activity("tool-b", "agent-b"));
    tracker.finish(hookEvent("PostToolUse", "tool-a", "agent-a"));
    assert.equal(tracker.size, 1);
    assert.equal(tracker.latest()?.toolUseId, "tool-b");
    assert.equal(tracker.latestForAgent("agent-a"), undefined);
});
test("out-of-order completion prevents a late start from becoming stale activity", () => {
    const tracker = new ToolActivityTracker();
    tracker.finish(hookEvent("PostToolUse", "tool-late", "agent-a"));
    assert.equal(tracker.start(hookEvent("PreToolUse", "tool-late", "agent-a"), activity("tool-late", "agent-a")), false);
    assert.equal(tracker.size, 0);
});
test("removing an agent clears only that agent's activities", () => {
    const tracker = new ToolActivityTracker();
    tracker.start(hookEvent("PreToolUse", "tool-a", "agent-a"), activity("tool-a", "agent-a"));
    tracker.start(hookEvent("PreToolUse", "tool-b", "agent-b"), activity("tool-b", "agent-b"));
    tracker.removeAgent("agent-b");
    assert.equal(tracker.size, 1);
    assert.equal(tracker.latest()?.agentId, "agent-a");
});
//# sourceMappingURL=activity-tracker.test.js.map