# Claude 运行监控

## 作用

协调器借鉴 OMC 的可观察任务管理方式，但不复制或推断其内部工作流。它同时消费 Claude `stream-json` 输出和一个会话级临时观察插件产生的 hooks，从而显示运行状态、当前工具、子代理、耗时、空闲时间及最终结果。Codex 仍负责审查和验收。

观察插件通过 `--plugin-dir` 加载，和用户/OMC 已有 hooks 并存；不会写入或替换 `~/.claude/settings.json`。

## 状态保存位置

所有运行文件都在目标项目中，并由脚本把目录加入项目 `.gitignore`：

```text
<project>/.codex/claude-coordinator/
├── status.json                     # 最新一次运行的实时状态
└── runs/<run-id>/
    ├── status.json                 # 本次运行状态快照
    ├── events.jsonl                # 归一化、脱敏后的事件
    ├── hook-events.jsonl           # runner 聚合后的脱敏 Hook 事件
    ├── hooks-inbox/                # Hook 原子发布的待消费事件
    ├── hooks-rejected/             # 无法解析的隔离事件（按需创建）
    ├── stderr.log                  # Claude 标准错误（常见密钥脱敏）
    └── final-report.txt            # Claude 最终报告
```

`status.json` 的 `runDirectory` 和 `files` 字段给出本次文件的绝对路径。终端标准错误显示心跳和关键事件；标准输出只显示最终报告，因此可安全地将标准输出重定向到报告文件。

## 监听与汇报

Claude 进程使用：

```text
--print --verbose --output-format stream-json
--include-partial-messages --include-hook-events
```

观察插件监听 `SessionStart`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`SubagentStart`、`SubagentStop`、`Notification` 和 `Stop`。Claude/OMC 启动子代理时，Claude Code 自己触发 `SubagentStart`；子代理中的工具调用带 `agent_id` 和 `tool_use_id`，因此协调器可以把工具活动归属到对应子代理和工具调用。子代理结束时触发 `SubagentStop`。

## Hook 并发安全

每个 Hook 进程只写自己的临时文件，关闭后在同一目录原子重命名为 `<timestamp>-<pid>-<uuid>.ready.json`。runner 只读取 `.ready.json`，按文件名稳定排序，认领为 `.processing.json` 后再解析；未完成的 `.tmp` 永远不会被消费。

runner 是 `hook-events.jsonl`、`events.jsonl` 和 `status.json` 的唯一聚合写入者。有效事件经 `eventId`、`toolUseId`、`agentId` 和事件类型去重后写入公共日志；无效文件移动到 `hooks-rejected/`。Claude 退出后 runner 还会短暂排空 inbox，避免遗漏已经发布但尚未消费的结尾事件。

排序只提供确定性的消费顺序，不被当作严格因果证据。工具活动使用 `toolUseId` 配对：一个 `PostToolUse` 只结束对应的 `PreToolUse`，多个子代理的工具不会互相清除；结束事件先到达时会留下完成标记，防止迟到的开始事件形成陈旧活动。

监听器只保留可观察元数据和有限摘要，不保存 prompt、thinking、transcript 路径或完整工具响应。常见 token、API key、密码模式会被替换；最终报告仍应遵守任务契约中的密钥禁令。

## 观测边界

协调器只记录 Claude 与外部工具之间可观察的事实，例如 `state`、`currentActivity`、`agents`、`lastEventAt`、计数器和最终结果。它不把 Read、Edit、Bash 或子代理类型映射为内部阶段，也不要求 Claude 暴露 OMC 的工作流状态。

从 `schemaVersion: 2` 起，`status.json` 和 `events.jsonl` 不再包含 `phase` 或 `phaseLabel`。从 `schemaVersion: 3` 起，生效的超时配置位于 `timeouts`，具体超时原因位于终态的 `timeout`。状态消费者应根据 `state` 判断运行结果，根据 `currentActivity`、`agents`、时间戳和事件记录展示客观活动；不得从工具名称反推出 Claude 的计划或内部阶段。

Codex 根据任务契约、工作树差异和独立验证决定是否验收或续跑；Claude/OMC 自行管理其内部计划、循环和角色分工。

## 限制与退出码

- 超时配置档如下；未指定时使用 `general`：

| 配置档 | 总时限 | 空闲时限 | 选择规则 |
| --- | ---: | ---: | --- |
| `small` | 1200 秒 | 300 秒 | 范围明确、文件少、验证快速 |
| `general` | 3600 秒 | 900 秒 | 普通多文件功能或无法明确判断 |
| `heavy` | 14400 秒 | 1800 秒 | 跨模块重构、打包、E2E、慢速依赖 |
| `unlimited` | 关闭 | 关闭 | 仅限用户明确要求 |

- `--max-runtime-seconds N|off` 和 `--idle-timeout-seconds N|off` 分别覆盖配置档中的数值。`off` 只关闭对应一种超时。
- `unlimited` 只表示协调器不主动按时间终止；外部 API、网络、操作系统或调用环境仍可能超时。心跳、运行锁、子代理数和修复轮数限制继续生效。
- `state` 继续使用 `timed_out`，退出码继续使用 `124`。`timeout.kind` 为 `runtime` 或 `idle`，并同时记录 `limitSeconds` 和 `triggeredAt`；事件类型分别为 `runtime_timeout` 和 `idle_timeout`。
- 心跳默认 30 秒。
- 默认最多 10 个子代理、3 轮修复；任务契约和外部监控共同约束。
- 同一项目只允许一个活动写入委派；`active.lock` 防止误并发，异常退出后的失效锁会自动清理。
- 退出码 `0` 表示 Claude 正常完成，`3` 表示 Claude 报告阻塞，`124` 表示超时，其他非零值表示失败。正常完成仍不等于 Codex 验收通过。

## 依赖

运行时依赖：

- Claude Code CLI，且版本支持 `stream-json`、`--include-hook-events` 和 `--plugin-dir`；
- Git；目标工作目录必须位于 Git 仓库；
- Bash；
- Node.js。PATH 中没有 `node` 时，包装脚本会尝试使用 `claude` 同目录的 Node；也可设置 `CLAUDE_COORDINATOR_NODE` 为绝对路径。
- OMC 仅在任务契约指定 OMC 工作流时需要；监控本身不依赖 OMC。

目标项目不需要安装 npm 包。Skill 随附 TypeScript 源码和编译后的 JavaScript。只有开发本 Skill 时才需要运行 `npm install`、`npm run typecheck`、`npm test`。

## 快速排障

1. 读取 `<project>/.codex/claude-coordinator/status.json`，确认 `state`、`lastEventAt` 和 `currentActivity`。
2. 读取 `files.events` 查看最后一个 hook 或 stream 事件。
3. 若 `counters.hookRejected` 非零，读取 `files.hookRejected` 中的隔离文件；若 `files.hookInbox` 长时间存在 `.ready.json`，说明 runner 没有正常消费。
4. 读取 `files.stderr` 判断 CLI、网络、认证或 hook 错误。
5. 若 `lastEventAt` 持续不变，等待空闲时限自动终止，或手动终止外层脚本；不要启动第二个写入任务绕过锁。
6. 若观察插件不可用，运行 `claude plugin validate <skill>/claude-observer` 检查结构。
