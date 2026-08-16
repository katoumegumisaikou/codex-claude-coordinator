# Codex + Claude Coordinator

一个以 Codex 为主代理、Claude Code 为受约束实现代理的软件交付 Skill。Codex 负责需求拆解、边界控制、代码审查和最终验收；Claude Code 负责按任务契约实现代码、补充测试并报告结果。

## 作用

- 把软件需求转换为目标、范围、非目标、验收标准和验证命令明确的任务契约。
- 将实现工作委派给 Claude Code，同时禁止其提交、推送、重置、变基、切换分支或修改密钥。
- 在 Claude Code 已安装 oh-my-claudecode（OMC）时，为任务选择并约束 `autopilot`、`ralph`、`team`、`ultrawork` 或 `ultraqa` 工作流。
- 保持单写入者原则；只有只读任务或独立 worktree 中的任务才允许并行。
- 通过 Claude `stream-json` 与临时观察插件实时跟踪工具调用、OMC 子代理、阶段、耗时和阻塞状态。
- 使用心跳、总运行时限、空闲时限、最大子代理数和最大修复轮数约束长时间任务，包括 `ralph`。
- 将 Claude 的报告视为待验证声明，由 Codex 独立检查 diff、重跑测试并决定是否验收。
- 验收失败时生成包含失败证据的修复契约，并进行有上限的修复循环。

```text
用户需求
   ↓
Codex：分析、建立基线、编写任务契约
   ↓
Claude Code / OMC：实现和自测
   ↕ stream-json + hooks
项目内状态：阶段、工具、子代理、心跳、事件与日志
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
  --max-runtime-seconds 3600 \
  --idle-timeout-seconds 900 \
  --heartbeat-seconds 30 \
  --max-subagents 10 \
  --max-repair-rounds 3
```

如需额外复制最终报告，增加 `--report-file /absolute/path/to/report.txt`。
`--max-subagents` 的默认值现在是 `10`；可针对资源受限或高风险任务显式调低。

任务契约模板位于 [`references/task-contract.md`](skills/codex-claude-coordinator/references/task-contract.md)，完整工作流参见 [`SKILL.md`](skills/codex-claude-coordinator/SKILL.md)，状态字段与排障参见 [`references/runtime-monitoring.md`](skills/codex-claude-coordinator/references/runtime-monitoring.md)。

## 运行状态在哪里

脚本自动把 `/.codex/claude-coordinator/` 加入目标项目的 `.gitignore`，并在项目内保存：

```text
<project>/.codex/claude-coordinator/
├─ status.json                    # 最新运行的实时状态
└─ runs/<run-id>/
   ├─ status.json
   ├─ events.jsonl
   ├─ hook-events.jsonl
   ├─ stderr.log
   └─ final-report.txt
```

调用终端的标准错误会持续显示关键工具事件与心跳，标准输出只打印最终报告。查看实时状态：

```bash
cat .codex/claude-coordinator/status.json
```

`status.json` 的 `currentActivity`、`agents`、`lastEventAt` 和 `files.events` 可用于判断 Claude 正在调查、实现、验证、等待 API，还是运行 OMC 子代理。`phaseLabel` 使用“预检 → 调研 → 规划 → 实现 → 验证 → 交付”的中文描述；阶段由可观察事件推断，不读取或展示模型隐藏思维链。

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
- 状态事件不保存 prompt、thinking、完整工具响应或 transcript 路径；常见密钥与过长摘要会被脱敏。
- 不让 Claude 提交或推送代码。
- 不因 OMC 不可用而静默模拟或更换工作流。
- 不仅凭 Claude 的测试报告验收；Codex 必须独立复核。
