# Codex + Claude Coordinator

一个以 Codex 为主代理、Claude Code 为受约束实现代理的软件交付 Skill。Codex 负责需求拆解、边界控制、代码审查和最终验收；Claude Code 负责按任务契约实现代码、补充测试并报告结果。

## 作用

- 把软件需求转换为目标、范围、非目标、验收标准和验证命令明确的任务契约。
- 将实现工作委派给 Claude Code，同时禁止其提交、推送、重置、变基、切换分支或修改密钥。
- 在 Claude Code 已安装 oh-my-claudecode（OMC）时，为任务选择并约束 `autopilot`、`ralph`、`team`、`ultrawork` 或 `ultraqa` 工作流。
- 保持单写入者原则；只有只读任务或独立 worktree 中的任务才允许并行。
- 通过 Claude `stream-json` 与原子 Hook inbox 实时跟踪工具调用、OMC 子代理、耗时和最终状态。
- 使用四档超时配置、心跳、最大子代理数和最大修复轮数约束长时间任务，包括 `ralph`。
- 将 Claude 的报告视为待验证声明，由 Codex 独立检查 diff、重跑测试并决定是否验收。
- 验收失败时生成包含失败证据的修复契约，并进行有上限的修复循环。

```text
用户需求
   ↓
Codex：分析、建立基线、编写任务契约
   ↓
Claude Code / OMC：实现和自测
   ↕ stream-json + hooks
项目内状态：运行状态、当前活动、子代理、心跳、事件与日志
   ↓
Codex：审查差异、独立验证
   ├─ 通过 → 交付
   └─ 失败 → 带证据退回修复
```

## 仓库结构

```text
skills/codex-claude-coordinator/
├─ SKILL.md
├─ agents/openai.yaml
├─ claude-observer/                 # 会话级临时 Claude 插件
├─ references/
│  ├─ task-contract.md
│  └─ runtime-monitoring.md
├─ scripts/
│  ├─ delegate-to-claude.sh         # Bash 包装入口
│  ├─ src/                          # TypeScript 源码与测试
│  └─ dist/                         # 无需安装依赖即可运行的 JavaScript
├─ package.json
└─ tsconfig.json
```

## 依赖

### 必需依赖

| 依赖 | 用途 |
| --- | --- |
| 支持 Skills 的 Codex 环境 | 加载并执行协调工作流 |
| Claude Code CLI | 作为实现代理；`claude` 已认证且支持流输出、hook events 和临时插件 |
| Git | 解析项目根目录、检查工作树和验证范围；工作目录必须位于 Git 仓库 |
| Bash | 运行 `delegate-to-claude.sh`；Windows 可使用 WSL 或 Git Bash |
| Node.js 18+ | 运行监听器和观察 hook；PATH 中没有时会尝试使用 `claude` 同目录的 Node |

Claude Code 版本需要支持 `--print`、`--verbose`、`--output-format stream-json`、`--include-partial-messages`、`--include-hook-events`、`--plugin-dir`、`--permission-mode`、`--no-session-persistence` 和 `--name`。

### 条件依赖

- 任务指定 OMC 工作流时，同一个 Claude Code 环境必须已安装并配置 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)。
- React、Next.js、TypeScript、Go、Playwright 等领域 Codex Skills 仅在对应项目中按需使用，不属于基础运行依赖。
- `--model` 和 `--max-budget-usd` 是可选参数，只有用户明确要求或批准限制时才应使用。

### 开发依赖与非依赖

- 目标项目不需要安装 npm 包。仓库已包含 TypeScript 编译产物，运行时不需要执行 `npm install`。
- 仅开发本 Skill 时需要 TypeScript 和 `@types/node`；版本记录在 `package.json` 和锁文件中。
- 不绑定 React、Electron、Go 或其他具体项目技术栈。
- 仓库不包含 Claude、Anthropic 或 GitHub 凭据。

## 安装

克隆仓库后，将 Skill 目录复制到 Codex 的 Skills 目录：

```bash
git clone https://github.com/katoumegumisaikou/codex-claude-coordinator.git
cp -R codex-claude-coordinator/skills/codex-claude-coordinator \
  "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Windows PowerShell：

```powershell
git clone https://github.com/katoumegumisaikou/codex-claude-coordinator.git
Copy-Item -Recurse \
  .\codex-claude-coordinator\skills\codex-claude-coordinator \
  "$env:USERPROFILE\.codex\skills\"
```

确认运行依赖：

```bash
claude --version
git --version
bash --version
node --version
```

## 使用

在 Codex 中明确调用：

```text
使用 $codex-claude-coordinator 拆解这个任务，委派 Claude Code 实现和测试，并由 Codex 独立验收。
```

Skill 会根据任务生成契约。其委派脚本也可以直接运行：

```bash
SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/codex-claude-coordinator"
bash "$SKILL_DIR/scripts/delegate-to-claude.sh" \
  --workdir "$PWD" \
  --task-file "/absolute/path/to/task.md" \
  --timeout-profile general \
  --heartbeat-seconds 30 \
  --max-subagents 10 \
  --max-repair-rounds 3
```

如需额外复制最终报告，增加 `--report-file /absolute/path/to/report.txt`。
`--max-subagents` 的默认值现在是 `10`；可针对资源受限或高风险任务显式调低。

超时配置档由 Codex 在启动 Claude 前根据任务契约选择：

| 任务类型 | 参数 | 总时限 | 空闲时限 | 适用范围 |
| --- | --- | ---: | ---: | --- |
| 小任务 | `small` | 20 分钟 | 5 分钟 | 单点修复、少量文件、快速测试 |
| 通用任务 | `general` | 60 分钟 | 15 分钟 | 普通功能、多文件修改、完整测试 |
| 重型任务 | `heavy` | 4 小时 | 30 分钟 | 跨模块重构、打包、E2E、依赖下载 |
| 不超时任务 | `unlimited` | 关闭 | 关闭 | 只能由用户明确选择 |

未指定时使用 `general`。`--max-runtime-seconds N|off` 和 `--idle-timeout-seconds N|off` 可以分别覆盖配置档。`unlimited` 只关闭协调器自身的时间限制；Claude API、网络、操作系统或调用环境仍可能超时，心跳、运行锁、子代理数和修复轮数限制继续生效。

任务契约模板位于 [`references/task-contract.md`](skills/codex-claude-coordinator/references/task-contract.md)，完整工作流参见 [`SKILL.md`](skills/codex-claude-coordinator/SKILL.md)，状态字段与排障参见 [`references/runtime-monitoring.md`](skills/codex-claude-coordinator/references/runtime-monitoring.md)。

## 完整工作流如何推进

整个工作流由三层协作：

```text
用户
  ↓
Codex 主代理：分析、拆解、制定契约、最终验收
  ↓
TypeScript 协调器：启动 Claude、监听事件、维护状态、执行限制
  ↓
Claude Code 实现代理
  ↓
OMC 主工作流及其子代理
```

### 1. Codex 分析任务

Codex 检查仓库和现有 Git 状态，明确目标、非目标、允许修改范围、验收标准、验证命令及安全约束。架构决策和模糊需求的澄清仍由 Codex 负责。

### 2. Codex 建立基线

Codex 在委派前运行适合当前项目的最小检查，记录已有失败，避免把原有问题误判为 Claude 引入的回归。

### 3. Codex 编写任务契约

Codex 根据 `references/task-contract.md` 生成任务文件，并在其中写明：

- Claude 可以修改的范围；
- 一个准确的 OMC 主工作流调用；
- 测试和验收标准；
- 一个与任务规模匹配的超时配置档；
- 默认最多 10 个子代理和 3 轮修复；
- 单写入者或独立 worktree 隔离方式；
- 禁止提交、推送、重置、变基、切换分支和修改密钥。

Claude 不会自动继承 Codex 当前加载的 Skills，因此所有需要 Claude 遵守的关键规则都必须写入契约。

### 4. Codex 启动委派脚本

Codex 运行 `delegate-to-claude.sh`。Bash 包装脚本定位 Node.js 和已编译的运行器，然后通过 `exec` 启动 `scripts/dist/claude-runner.js`，不截断其标准输出或标准错误。

### 5. 协调器初始化运行环境

TypeScript 协调器解析 Git 项目根目录，创建唯一 `run-id`、运行文件和 `active.lock`。锁用于阻止同一项目同时运行两个写入型 Claude 任务。协调器还会自动把 `/.codex/claude-coordinator/` 加入项目 `.gitignore`。

### 6. 协调器启动 Claude 和 OMC

协调器通过标准输入把任务契约发送给 Claude，并以 `stream-json`、hook events、临时观察插件、`auto` 权限模式和无会话持久化方式启动 Claude。Claude 必须实际调用契约指定的 OMC 工作流，不得只模拟其行为；OMC 不可用时应报告阻塞。

同一 Claude 会话只能有一个 OMC 主循环控制者。OMC 可以继续启动子代理，但超过 10 个时协调器会终止本次任务。

### 7. 协调器监听 Claude 和子代理

协调器同时消费两条事件通道：

```text
Claude stdout ── stream-json ────────────┐
                                         ├─→ 归一化事件 → status.json
Claude hooks ─→ hooks-inbox/*.ready ─────┘
                         ↓ runner 单一聚合写入
                   hook-events.jsonl + events.jsonl
```

观察插件记录会话、工具调用、工具失败、子代理启动/停止、通知和结束事件。每个 Hook 先写入独立临时文件，再原子重命名为 `.ready.json`；它们不再并发追加公共 JSONL。runner 按文件名稳定排序、去重并聚合写入 `hook-events.jsonl`、`events.jsonl` 和 `status.json`，无法解析的文件会隔离到 `hooks-rejected/`。

`PreToolUse` 按 `toolUseId` 登记活动，`PostToolUse` 或 `PostToolUseFailure` 只清除对应调用，`SubagentStart` 和 `SubagentStop` 更新 `agents`。因此并发子代理的工具活动不会互相覆盖。inbox 每 500 毫秒检查一次，Claude 退出后还会短暂排空；超时条件每秒检查一次，心跳默认每 30 秒输出一次。逐 token 文本和思考增量不会持久化。

### 8. 协调器保存项目内状态

最新状态统一保存到通用项目路径：

```text
<project>/.codex/claude-coordinator/status.json
```

本次运行的事件、日志、最终报告和状态快照保存在：

```text
<project>/.codex/claude-coordinator/runs/<run-id>/
```

这些文件记录 Claude、OMC 和 OMC 子代理的状态，不记录 Codex 主代理自身状态。

### 9. 心跳返回 Codex

协调器每 30 秒更新一次状态文件，并把心跳写入 stderr。心跳不会主动唤醒 Codex；只有 Codex 启动了该终端任务，并再次等待或读取运行中任务的新增输出时，心跳才会进入 Codex 上下文。

本地更新状态、轮询 Hook 和生成心跳不调用 Codex 模型。Codex 读取并分析终端输出时才会产生相应模型用量。

### 10. 协调器结束运行

正常情况下，Claude 子进程触发 `close` 后，协调器处理最后事件、写入 `final-report.txt`、设置最终状态、清除定时器并删除 `active.lock`。

达到当前配置档已启用的总时限或空闲时限时，协调器先向 Claude 发送 `SIGTERM`，5 秒后仍未退出则发送 `SIGKILL`。`status.json` 保持 `state: "timed_out"`，并使用 `timeout.kind` 区分 `runtime` 和 `idle`。最终退出码含义如下：

- `0`：Claude 正常完成；
- `3`：Claude 报告阻塞；
- `124`：任务超时；
- 其他非零值：执行失败。

Claude 状态为 `completed` 只表示委派结束，不代表 Codex 已验收通过。

### 11. Codex 独立审查

Claude 结束后，Codex 检查完整 diff、所有新增文件、范围合规性、安全性、错误处理和测试质量，并独立重跑关键验证命令。Claude 报告只作为待核验证据。

### 12. Codex 发起修复循环

若验收失败，Codex 使用具体失败命令、简明输出和涉及文件创建新的修复契约，再次委派 Claude 并重新验收。默认最多三轮；当前轮数主要由 Skill 和契约约束，协调器尚未跨多次运行维护硬性计数器。

### 13. Codex 最终交付

全部验收标准都有独立证据后，Codex 才向用户交付结果，并区分 Claude 的报告、Codex 的复验结果、剩余风险和需要用户执行的操作。

当前有意保留以下职责边界：Codex 自身状态不写入 `status.json`，心跳不主动唤醒 Codex，不强制规定 Codex 的等待间隔，不跨运行强制计算修复轮数，最终审查继续由 Skill 指令驱动而不是 TypeScript 状态机自动执行。

## 运行状态在哪里

脚本自动把 `/.codex/claude-coordinator/` 加入目标项目的 `.gitignore`，并在项目内保存：

```text
<project>/.codex/claude-coordinator/
├─ status.json                    # 最新运行的实时状态
└─ runs/<run-id>/
   ├─ status.json
   ├─ events.jsonl
   ├─ hook-events.jsonl
   ├─ hooks-inbox/
   ├─ hooks-rejected/             # 仅出现无效事件时创建
   ├─ stderr.log
   └─ final-report.txt
```

调用终端的标准错误会持续显示关键工具事件与心跳，标准输出只打印最终报告。查看实时状态：

```bash
cat .codex/claude-coordinator/status.json
```

`status.json` 的 `state`、`currentActivity`、`agents`、`lastEventAt` 和 `files.events` 用于展示 Claude 的运行结果、当前工具、子代理和最近事件。`files.hookInbox`、`files.hookRejected`、`counters.hookDuplicates` 和 `counters.hookRejected` 用于排查 Hook 队列。结合 `stderr.log` 可以排查 API 等待或工具阻塞，但协调器不会据此推断 Claude/OMC 的计划或内部阶段。

从 `schemaVersion: 2` 起，`status.json` 和 `events.jsonl` 不再包含 `phase` 或 `phaseLabel`。从 `schemaVersion: 3` 起，生效配置记录在 `timeouts` 中；超时时还会写入 `timeout.kind`、`limitSeconds` 和 `triggeredAt`。读取状态的工具应使用 `state` 判断结果，并使用 `currentActivity`、`agents`、时间戳和事件记录展示客观活动。旧运行目录中的 schema v1/v2 文件是历史快照，不会被自动改写。

## 开发与验证

```bash
cd skills/codex-claude-coordinator
npm install
npm run typecheck
npm test
claude plugin validate ./claude-observer
```

## 安全边界

- 不使用 `--dangerously-skip-permissions`。
- 不在同一工作树中并行运行多个写入代理。
- 观察插件通过 `--plugin-dir` 临时加载，不覆盖用户或 OMC 的现有 hooks 和 settings。
- Hook 进程只原子发布独立事件文件，公共 JSONL 和状态文件只由 runner 写入。
- 状态事件不保存 prompt、thinking、完整工具响应或 transcript 路径；常见密钥与过长摘要会被脱敏。
- 不让 Claude 提交或推送代码。
- 不因 OMC 不可用而静默模拟或更换工作流。
- 不仅凭 Claude 的测试报告验收；Codex 必须独立复核。
