import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureRuntimeIgnored,
  extractFinalReport,
  normalizeHookEvent,
  normalizeStreamEvent,
  redactText,
  reportIndicatesBlocker,
  sanitizeValue,
} from "../monitor.js";

test("redacts common credentials and sensitive keys", () => {
  const token = `ghp_${"a".repeat(30)}`;
  assert.equal(redactText(`Authorization: Bearer abc.def ${token}`).includes(token), false);
  assert.deepEqual(sanitizeValue({ apiKey: "secret", nested: { password: "p" }, safe: "ok" }), {
    apiKey: "[REDACTED]",
    nested: { password: "[REDACTED]" },
    safe: "ok",
  });
});

test("adds the project-local runtime ignore exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "coordinator-ignore-"));
  try {
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n", "utf8");
    assert.equal(ensureRuntimeIgnored(directory), true);
    assert.equal(ensureRuntimeIgnored(directory), false);
    const content = readFileSync(join(directory, ".gitignore"), "utf8");
    assert.equal(content.match(/\/\.codex\/claude-coordinator\//g)?.length, 1);
    assert.match(content, /node_modules\/\n\n# Codex \+ Claude coordinator runtime state/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes hook events without preserving full tool input", () => {
  const event = normalizeHookEvent({
    timestamp: "2026-01-01T00:00:00.000Z",
    hookEventName: "PreToolUse",
    sessionId: "session-1",
    agentId: "agent-1",
    agentType: "Explore",
    toolName: "Bash",
    toolInputSummary: "npm test token=abc123",
  });
  assert.equal(event?.toolName, "Bash");
  assert.equal(event?.summary, "npm test token=[REDACTED]");
});

test("normalizes tool-use stream events and extracts only the final result", () => {
  const event = normalizeStreamEvent({
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "Edit", input: { file_path: "src/App.tsx" } } },
  });
  assert.equal(event?.toolName, "Edit");
  assert.equal(normalizeStreamEvent({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hidden" } } }), undefined);
  assert.equal(extractFinalReport({ type: "assistant", result: "wrong" }), undefined);
  assert.equal(extractFinalReport({ type: "result", result: "done" }), "done");
});

test("detects substantive blocker reports", () => {
  assert.equal(reportIndicatesBlocker("阻塞问题\n无"), false);
  assert.equal(reportIndicatesBlocker("阻塞问题\n缺少签名证书"), true);
  assert.equal(reportIndicatesBlocker("## 阻塞问题：\n缺少签名证书"), true);
  assert.equal(reportIndicatesBlocker("任务摘要\n完成"), false);
});
