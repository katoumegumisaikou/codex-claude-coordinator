---
name: codex-claude-coordinator
description: 以 Codex 为主代理、Claude Code 为受约束的实现子代理来协调软件交付，并在 Claude 已安装 oh-my-claudecode 时为委派任务选择和约束 OMC 工作流。当用户要求 Codex 拆解编码任务、委派 Claude Code 编写代码和测试、审查 Claude 的改动、独立执行验收检查，并将未通过的工作退回修复时使用。提到 Codex 主导 Claude Code 协作、Codex 作为主代理、Claude 作为子代理、oh-my-claudecode 工作流，或跨代理实现与测试时触发。
---

# Codex + Claude 协调器

让 Codex 负责需求、任务边界、执行顺序、审查和最终验收。除非用户明确改变角色分工，否则仅让 Claude Code 编写实现代码。

## 前置条件

1. 确认同一执行环境中的 `claude --version`、`git --version`、`bash --version` 可以正常运行。运行时还需要 Node.js；脚本会优先使用 PATH 中的 `node`，否则尝试 Claude 可执行文件同目录的 `node`。
2. 仅在可信 Git 仓库中工作。委派前检查 `git status --short`，并保留用户已有的改动。
3. 不要在同一工作树中同时启动两个具有写入权限的 Claude 任务。运行锁会阻止重复委派；只读并行也应使用独立工作树以免混淆状态。
4. 绝不启用 `--dangerously-skip-permissions`。委派脚本默认使用 Claude 的 `auto` 权限模式。
5. 任务需要 OMC 时，确认同一 Claude Code 环境已安装并完成 `oh-my-claudecode` 设置。若指定的 OMC skill 不可用，停止并报告，不要静默模拟或改用其他工作流。

## Skill 路由原则

1. Codex 根据当前任务按需加载本机已安装的领域 skill，不要为了形式调用无关 skill。
2. Codex skill 只帮助主代理分析、制定契约和独立验收，不会自动传递给 Claude。需要 Claude 遵循的规则必须写入任务契约。
3. 每次委派都在任务契约中明确 OMC 主工作流、准确调用方式、选择原因和并发隔离方案。
4. 同一 Claude 会话只指定一个主循环控制者：`autopilot`、`team`、`ultrawork`、`ralph`、`ultraqa` 之间不得并行竞争。`tdd`、`code-review`、`security-review`、`visual-verdict` 只能作为辅助行为或证据生产者。
5. OMC 的计划、代理报告和验证结论都是待审查证据，不能替代 Codex 的最终决策和独立验收。

## 工作流程

### 1. 分析和拆解

检查仓库，将用户请求转换为边界明确的任务。为每项任务定义：

- 目标和非目标；
- 允许修改的文件或组件；
- 可观察的验收标准；
- 必须执行的测试和命令；
- 约束、兼容性要求和禁止操作。

每次优先委派一个完整且连贯的实现任务。架构决策和模糊需求的澄清由 Codex 负责。

按需使用以下 Codex skills：

- Go 架构与边界：`golang-project-layout`；并发、错误和安全风险分别使用 `golang-concurrency`、`golang-error-handling`、`golang-security`。
- React、Next.js 和 TypeScript：分别使用 `react-expert`、`nextjs-developer`、`typescript-pro`。
- 验收标准和测试策略：使用 `test-master`；Go 测试使用 `golang-testing`；浏览器验收使用 `playwright-expert`。

按需安排 OMC 规划工作流：需求含糊且用户可交互时使用 `/deep-interview`；复杂或高风险方案使用 `/oh-my-claudecode:ralplan`，高风险时加 `--deliberate`；疑难故障可先用 `/oh-my-claudecode:deep-dive`。这些模式只提供计划或调查证据，最终任务边界由 Codex 决定。需要交互问答的工作流不要通过无交互委派脚本启动。

### 2. 建立基线

记录当前 Git 状态，并在可行时执行最小范围的变更前检查。区分原有失败与本次回归。不要要求 Claude 清理无关改动。

根据项目选择 `golang-testing`、`test-master` 或 `playwright-expert` 制定并执行基线检查。安全相关任务同时使用 `golang-security`。本阶段默认不启动具有写入权限的 OMC 主工作流。

### 3. 编写任务契约

尽可能在仓库外创建临时任务文件。遵循 [references/task-contract.md](references/task-contract.md) 模板。提供足够的仓库背景，但要求 Claude 在编辑前自行检查实际文件。

在契约的“Claude Code 工作流”中填写准确的 OMC 调用。根据任务选择：

- 边界明确的端到端功能：`/oh-my-claudecode:autopilot <任务>`。
- 必须持续到验证通过的单一负责人任务：`/oh-my-claudecode:ralph <任务>`。
- 可安全并行且已确认隔离策略的独立子任务：`/oh-my-claudecode:team <N>:<agent> <任务>`；仅在不需要 Team 的突发并行修复中选择 `/oh-my-claudecode:ultrawork <任务>`。
- 实现目标已知但测试、构建、检查或类型检查仍失败：`/oh-my-claudecode:ultraqa <质量目标>`。
- 测试先行：在所选主工作流的任务文本中明确加入 `tdd` 或 `test first`，不要再启动第二个主循环。

写入工作流前检查并行写入安全性。`team` 或 `ultrawork` 涉及多个写入代理时，必须确认 OMC 的独立 worktree 模式已经启用并可用；否则改用单写入者工作流。

### 4. 委派实现

运行：

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/codex-claude-coordinator"
bash "$SKILL_DIR/scripts/delegate-to-claude.sh" \
  --workdir "$PWD" \
  --task-file "/absolute/path/to/task.md" \
  --max-runtime-seconds 3600 \
  --idle-timeout-seconds 900 \
  --heartbeat-seconds 30 \
  --max-subagents 4 \
  --max-repair-rounds 3
```

如果还需要把最终报告复制到指定位置，增加 `--report-file /absolute/path/to/report.txt`。仅当用户要求或批准相关限制时，才使用 `--model` 或 `--max-budget-usd`。

脚本使用 `stream-json` 和临时 Claude 观察插件监听会话、工具与子代理事件；该插件通过 `--plugin-dir` 加载，不改写 `~/.claude/settings.json`，也不替换 OMC 的现有 hooks。运行时：

- 自动在项目 `.gitignore` 中加入 `/.codex/claude-coordinator/`；
- 将最新状态写入项目内 `.codex/claude-coordinator/status.json`；
- 将本次 `events.jsonl`、`hook-events.jsonl`、`stderr.log`、`final-report.txt` 和快照 `status.json` 写入 `status.json` 的 `runDirectory`；
- 在调用终端的标准错误持续打印重要工具事件与心跳，在标准输出仅打印最终报告；
- 使用通用阶段“预检 → 调研 → 规划 → 实现 → 验证 → 交付”，不依赖 npm、Electron 或任何特定项目命令；
- 超过总时限、空闲时限或子代理数量限制时终止 Claude，并保留失败状态与事件证据。

等待期间直接读取 `.codex/claude-coordinator/status.json`，再按其中的 `files.events` 路径查看事件。不要通过 Claude 的文本输出推断隐藏思维过程；监听器不保存 prompt、thinking、工具完整响应，并对常见密钥和过长摘要做脱敏。字段、排障和依赖详见 [references/runtime-monitoring.md](references/runtime-monitoring.md)。

要求 Claude 通过 Skill 工具或已安装的斜杠入口实际调用任务契约指定的 OMC skill，不得只模仿其流程。OMC 交互式模式需要可见会话；无交互的 `claude --print` 环境不支持所选模式时，Claude 必须报告阻塞，不得擅自降级。

等待 Claude 完成后再开始审查，但等待不是静默的：定期读取状态和心跳；若状态长时间无变化，依据 `lastEventAt`、`currentActivity` 和 `stderr.log` 判断是网络/API 等待、工具阻塞还是子代理仍在运行。将 Claude 的报告视为待验证的声明，而不是正确性的证据。

### 5. 审查和验收

Codex 必须独立完成：

1. 检查 `git status`、完整差异和所有新文件。
2. 确认改动符合任务契约范围，并保留了无关工作。
3. 审查正确性、安全性、错误路径、API 兼容性和测试质量。
4. 独立运行指定测试，并补充验证高风险行为所需的针对性检查。
5. 为每一项验收标准提供对应证据。

只有所有标准都有证据支持时才验收。不能仅凭 Claude 报告测试通过就接受结果。

按技术栈重新调用阶段 1 中对应的 Codex skills 做独立审查。UI 任务可要求 Claude 使用 `/oh-my-claudecode:visual-verdict <任务>` 生成视觉证据；代码和安全审查可使用 OMC 的 `code review`、`security review` 辅助行为。Codex 必须自行检查差异并重跑关键命令。

### 6. 修复循环

如果验证失败，创建新的修复任务契约，其中包含：

- 未通过的具体标准；
- 失败命令及简明输出证据；
- 审查发现涉及的文件；
- 保留已通过行为并避免无关改动的要求。

将修复任务委派给 Claude，然后重复独立验证。默认最多三轮，并同时用 `--max-repair-rounds` 把限制写入 Claude 契约；外部总时限仍是最终边界。除非用户明确要求继续，否则达到限制后停止，提供证据并报告尚未解决的阻塞问题。

失败集中在质量门禁时选择 `ultraqa`；需要单一负责人持续修复时才选择 `ralph`。`ralph` 也必须受总时限、空闲时限和修复轮数约束，不得无限延长。不得在已有 OMC 主循环仍活动时再启动另一个主循环。每轮修复继续使用对应测试或安全 Codex skill 独立复验。

### 7. 最终交付

总结：

- 委派给 Claude 的任务；
- 修改的文件；
- Codex 独立执行的检查及结果；
- 已满足或尚未满足的验收标准；
- 剩余风险以及需要用户执行的操作。

明确区分 Claude 报告的结果与 Codex 独立验证的结果。
