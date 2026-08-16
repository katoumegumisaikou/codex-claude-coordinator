import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("observer records a bounded, redacted hook event", () => {
  const runDirectory = mkdtempSync(join(tmpdir(), "coordinator-observer-"));
  try {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const recorder = resolve(testDirectory, "..", "..", "..", "claude-observer", "scripts", "event-recorder.mjs");
    const secret = `ghp_${"a".repeat(30)}`;
    const result = spawnSync(process.execPath, [recorder], {
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        agent_id: "agent-1",
        tool_name: "Bash",
        tool_input: { command: `curl -H "Authorization: Bearer abc" https://example.test token=${secret}` },
        tool_response: { forbidden: secret },
      }),
      env: { ...process.env, CODEX_CLAUDE_RUN_DIR: runDirectory },
    });
    assert.equal(result.status, 0, result.stderr);
    const recorded = readFileSync(join(runDirectory, "hook-events.jsonl"), "utf8");
    assert.match(recorded, /"hookEventName":"PreToolUse"/);
    assert.match(recorded, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(recorded, new RegExp(secret));
    assert.doesNotMatch(recorded, /tool_response/);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});
