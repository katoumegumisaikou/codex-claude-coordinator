import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      "--timeout-profile", "heavy",
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
      schemaVersion: number;
      state: string;
      runDirectory: string;
      counters: { hookEvents: number; subagentsStarted: number; hookDuplicates: number; hookRejected: number };
      timeouts: { profile: string; maxRuntimeSeconds: number | null; idleTimeoutSeconds: number | null };
      limits: { maxSubagents: number };
      files: { events: string; hookEvents: string; hookInbox: string; finalReport: string; status: string };
    };
    assert.equal(status.schemaVersion, 3);
    assert.equal(status.state, "completed");
    assert.deepEqual(status.timeouts, { profile: "heavy", maxRuntimeSeconds: 10, idleTimeoutSeconds: 5 });
    assert.equal("phase" in status, false);
    assert.equal("phaseLabel" in status, false);
    assert.equal(status.counters.subagentsStarted, 1);
    assert.equal(status.counters.hookEvents, 5);
    assert.equal(status.counters.hookDuplicates, 0);
    assert.equal(status.counters.hookRejected, 0);
    assert.equal(status.limits.maxSubagents, 10);
    assert.equal(existsSync(status.files.events), true);
    assert.equal(existsSync(status.files.hookEvents), true);
    assert.deepEqual(readdirSync(status.files.hookInbox).filter((fileName) => fileName.endsWith(".ready.json")), []);
    assert.equal(existsSync(status.files.finalReport), true);
    assert.equal(existsSync(status.files.status), true);
    const events = readFileSync(status.files.events, "utf8");
    assert.match(events, /"kind":"SubagentStart"/);
    assert.match(events, /"toolUseId":"tool-1"/);
    assert.doesNotMatch(events, /"phase(?:Label)?"/);
    assert.equal(readFileSync(status.files.hookEvents, "utf8").trim().split("\n").length, 5);
    assert.match(readFileSync(status.files.finalReport, "utf8"), /阻塞问题\n无/);
    assert.equal(existsSync(join(coordinatorRoot, "active.lock")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("runner supports the unlimited profile without disabling other limits", () => {
  const project = mkdtempSync(join(tmpdir(), "coordinator-unlimited-"));
  try {
    execFileSync("git", ["init", "--quiet", project]);
    const taskFile = join(project, "task.md");
    writeFileSync(taskFile, "# 任务\n执行无协调器超时的模拟任务。\n", "utf8");
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const runner = resolve(testDirectory, "..", "claude-runner.js");
    const fakeClaude = resolve(testDirectory, "fake-claude.mjs");
    const result = spawnSync(process.execPath, [runner,
      "--workdir", project,
      "--task-file", taskFile,
      "--timeout-profile", "unlimited",
      "--heartbeat-seconds", "1",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_COORDINATOR_CLAUDE_COMMAND: process.execPath,
        CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON: JSON.stringify([fakeClaude]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(join(project, ".codex", "claude-coordinator", "status.json"), "utf8")) as {
      schemaVersion: number;
      state: string;
      timeouts: { profile: string; maxRuntimeSeconds: number | null; idleTimeoutSeconds: number | null };
      limits: { maxSubagents: number; maxRepairRounds: number };
    };
    assert.equal(status.schemaVersion, 3);
    assert.equal(status.state, "completed");
    assert.deepEqual(status.timeouts, { profile: "unlimited", maxRuntimeSeconds: null, idleTimeoutSeconds: null });
    assert.deepEqual(status.limits, { maxSubagents: 10, maxRepairRounds: 3 });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("explicit off values override a finite timeout profile", () => {
  const project = mkdtempSync(join(tmpdir(), "coordinator-timeout-off-"));
  try {
    execFileSync("git", ["init", "--quiet", project]);
    const taskFile = join(project, "task.md");
    writeFileSync(taskFile, "# 任务\n验证关闭单项超时。\n", "utf8");
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const runner = resolve(testDirectory, "..", "claude-runner.js");
    const fakeClaude = resolve(testDirectory, "fake-claude.mjs");
    const result = spawnSync(process.execPath, [runner,
      "--workdir", project,
      "--task-file", taskFile,
      "--timeout-profile", "small",
      "--max-runtime-seconds", "off",
      "--idle-timeout-seconds", "off",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_COORDINATOR_CLAUDE_COMMAND: process.execPath,
        CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON: JSON.stringify([fakeClaude]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(join(project, ".codex", "claude-coordinator", "status.json"), "utf8")) as {
      timeouts: { profile: string; maxRuntimeSeconds: number | null; idleTimeoutSeconds: number | null };
    };
    assert.deepEqual(status.timeouts, { profile: "small", maxRuntimeSeconds: null, idleTimeoutSeconds: null });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("runner rejects unknown timeout profiles before starting Claude", () => {
  const project = mkdtempSync(join(tmpdir(), "coordinator-invalid-profile-"));
  try {
    execFileSync("git", ["init", "--quiet", project]);
    const taskFile = join(project, "task.md");
    writeFileSync(taskFile, "# 任务\n不应启动。\n", "utf8");
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const runner = resolve(testDirectory, "..", "claude-runner.js");
    const result = spawnSync(process.execPath, [runner,
      "--workdir", project,
      "--task-file", taskFile,
      "--timeout-profile", "enormous",
    ], { encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /不支持的超时配置档：enormous/);
    assert.equal(existsSync(join(project, ".codex", "claude-coordinator", "status.json")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

for (const scenario of [
  { kind: "runtime", maxRuntime: "1", idleTimeout: "10", reason: /超过总运行时限 1 秒/ },
  { kind: "idle", maxRuntime: "10", idleTimeout: "1", reason: /连续 1 秒没有 Claude 或 hook 事件/ },
] as const) {
  test(`runner records structured ${scenario.kind} timeout details`, () => {
    const project = mkdtempSync(join(tmpdir(), `coordinator-${scenario.kind}-timeout-`));
    try {
      execFileSync("git", ["init", "--quiet", project]);
      const taskFile = join(project, "task.md");
      writeFileSync(taskFile, "# 任务\n保持运行直到协调器终止。\n", "utf8");
      const testDirectory = dirname(fileURLToPath(import.meta.url));
      const runner = resolve(testDirectory, "..", "claude-runner.js");
      const fakeClaude = resolve(testDirectory, "fake-hanging.mjs");
      const result = spawnSync(process.execPath, [runner,
        "--workdir", project,
        "--task-file", taskFile,
        "--max-runtime-seconds", scenario.maxRuntime,
        "--idle-timeout-seconds", scenario.idleTimeout,
        "--heartbeat-seconds", "1",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_COORDINATOR_CLAUDE_COMMAND: process.execPath,
          CLAUDE_COORDINATOR_CLAUDE_ARGUMENTS_JSON: JSON.stringify([fakeClaude]),
        },
      });

      assert.equal(result.status, 124, result.stderr);
      const status = JSON.parse(readFileSync(join(project, ".codex", "claude-coordinator", "status.json"), "utf8")) as {
        state: string;
        failureReason?: string;
        timeout?: { kind: string; limitSeconds: number; triggeredAt: string };
        files: { events: string };
      };
      assert.equal(status.state, "timed_out");
      assert.equal(status.timeout?.kind, scenario.kind);
      assert.equal(status.timeout?.limitSeconds, 1);
      assert.match(status.timeout?.triggeredAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.match(status.failureReason ?? "", scenario.reason);
      assert.match(readFileSync(status.files.events, "utf8"), new RegExp(`"kind":"${scenario.kind}_timeout"`));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
}

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
