import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { consumeHookInbox } from "../hook-inbox.js";

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
    const inboxDirectory = join(runDirectory, "hooks-inbox");
    const readyFiles = readdirSync(inboxDirectory).filter((fileName) => fileName.endsWith(".ready.json"));
    assert.equal(readyFiles.length, 1);
    assert.equal(existsSync(join(runDirectory, "hook-events.jsonl")), false);
    const hookEventsPath = join(runDirectory, "hook-events.jsonl");
    const observed: string[] = [];
    const consumed = consumeHookInbox({
      inboxDirectory,
      rejectedDirectory: join(runDirectory, "hooks-rejected"),
      hookEventsPath,
      seenKeys: new Set(),
      onEvent: (event) => observed.push(event.kind),
    });
    assert.deepEqual(consumed, { handled: 1, consumed: 1, duplicates: 0, rejected: 0 });
    assert.deepEqual(observed, ["PreToolUse"]);
    const recorded = readFileSync(hookEventsPath, "utf8");
    assert.match(recorded, /"hookEventName":"PreToolUse"/);
    assert.match(recorded, /"eventId":"[0-9a-f-]+"/);
    assert.match(recorded, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(recorded, new RegExp(secret));
    assert.doesNotMatch(recorded, /tool_response/);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("observer processes write independent ready files concurrently", async () => {
  const runDirectory = mkdtempSync(join(tmpdir(), "coordinator-observer-concurrent-"));
  try {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const recorder = resolve(testDirectory, "..", "..", "..", "claude-observer", "scripts", "event-recorder.mjs");
    const count = 24;
    await Promise.all(Array.from({ length: count }, (_, index) => new Promise<void>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, [recorder], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_CLAUDE_RUN_DIR: runDirectory },
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", rejectChild);
      child.once("close", (code) => code === 0 ? resolveChild() : rejectChild(new Error(stderr || `exit ${code}`)));
      child.stdin.end(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "session-concurrent",
        agent_id: `agent-${index}`,
        tool_name: "Read",
        tool_use_id: `tool-${index}`,
        tool_input: { file_path: `src/file-${index}.ts` },
      }));
    })));

    const inboxDirectory = join(runDirectory, "hooks-inbox");
    const names = readdirSync(inboxDirectory);
    assert.equal(names.filter((fileName) => fileName.endsWith(".ready.json")).length, count);
    assert.equal(names.some((fileName) => fileName.endsWith(".tmp")), false);
    const hookEventsPath = join(runDirectory, "hook-events.jsonl");
    const consumed = consumeHookInbox({
      inboxDirectory,
      rejectedDirectory: join(runDirectory, "hooks-rejected"),
      hookEventsPath,
      seenKeys: new Set(),
      onEvent: () => undefined,
    });
    assert.equal(consumed.consumed, count);
    const lines = readFileSync(hookEventsPath, "utf8").trim().split("\n");
    assert.equal(lines.length, count);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});
