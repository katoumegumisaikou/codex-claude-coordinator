import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("runner persists project-local status, events, hooks, logs, and report", () => {
  const project = mkdtempSync(join(tmpdir(), "coordinator-runner-"));
  try {
    execFileSync("git", ["init", "--quiet", project]);
    const taskFile = join(project, "task.md");
    writeFileSync(taskFile, "# 任务\n只执行模拟任务。\n", "utf8");
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const runner = resolve(testDirectory, "..", "claude-runner.js");
    const fakeClaude = resolve(testDirectory, "fake-claude.mjs");
    const result = spawnSync(process.execPath, [runner,
      "--workdir", project,
      "--task-file", taskFile,
      "--heartbeat-seconds", "1",
      "--idle-timeout-seconds", "5",
      "--max-runtime-seconds", "10",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_COORDINATOR_CLAUDE_COMMAND: process.execPath,
        CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON: JSON.stringify([fakeClaude]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /完成模拟任务/);
    assert.match(readFileSync(join(project, ".gitignore"), "utf8"), /\/\.codex\/claude-coordinator\//);
    const coordinatorRoot = join(project, ".codex", "claude-coordinator");
    const status = JSON.parse(readFileSync(join(coordinatorRoot, "status.json"), "utf8")) as {
      state: string;
      phaseLabel: string;
      runDirectory: string;
      counters: { hookEvents: number; subagentsStarted: number };
      limits: { maxSubagents: number };
      files: { events: string; finalReport: string; status: string };
    };
    assert.equal(status.state, "completed");
    assert.equal(status.phaseLabel, "交付");
    assert.equal(status.counters.subagentsStarted, 1);
    assert.equal(status.counters.hookEvents, 5);
    assert.equal(status.limits.maxSubagents, 10);
    assert.equal(existsSync(status.files.events), true);
    assert.equal(existsSync(status.files.finalReport), true);
    assert.equal(existsSync(status.files.status), true);
    assert.match(readFileSync(status.files.events, "utf8"), /"kind":"SubagentStart"/);
    assert.match(readFileSync(status.files.finalReport, "utf8"), /阻塞问题\n无/);
    assert.equal(existsSync(join(coordinatorRoot, "active.lock")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("runner records spawn failures and releases the project lock", () => {
  const project = mkdtempSync(join(tmpdir(), "coordinator-failure-"));
  try {
    execFileSync("git", ["init", "--quiet", project]);
    const taskFile = join(project, "task.md");
    writeFileSync(taskFile, "# 任务\n不会执行。\n", "utf8");
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const runner = resolve(testDirectory, "..", "claude-runner.js");
    const missingCommand = join(project, "definitely-missing-claude-command");
    const result = spawnSync(process.execPath, [runner, "--workdir", project, "--task-file", taskFile], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_COORDINATOR_CLAUDE_COMMAND: missingCommand },
    });
    assert.equal(result.status, 1);
    const coordinatorRoot = join(project, ".codex", "claude-coordinator");
    const status = JSON.parse(readFileSync(join(coordinatorRoot, "status.json"), "utf8")) as { state: string; failureReason?: string };
    assert.equal(status.state, "failed");
    assert.match(status.failureReason ?? "", /ENOENT|not found/i);
    assert.equal(existsSync(join(coordinatorRoot, "active.lock")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
