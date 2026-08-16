# Codex + Claude Coordinator

一个以 Codex 为主代理、Claude Code 为受约束实现代理的软件交付 Skill。Codex 负责需求拆解、边界控制、代码审查和最终验收；Claude Code 负责按任务契约实现代码、补充测试并报告结果。

## 作用

- 把软件需求转换为目标、范围、非目标、验收标准和验证命令明确的任务契约。
- 将实现工作委派给 Claude Code，同时禁止其提交、推送、重置、变基、切换分支或修改密钥。
- 在 Claude Code 已安装 oh-my-claudecode（OMC）时，为任务选择并约束 `autopilot`、`ralph`、`team`、`ultrawork` 或 `ultraqa` 工作流。
- 保持单写入者原则；只有只读任务或独立 worktree 中的任务才允许并行。
- 将 Claude 的报告视为待验证声明，由 Codex 独立检查 diff、重跑测试并决定是否验收。
- 验收失败时生成包含失败证据的修复契约，并进行有上限的修复循环。

```text
用户需求
   ↓
Codex：分析、建立基线、编写任务契约
   ↓
Claude Code / OMC：实现和自测
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
├─ references/task-contract.md
└─ scripts/delegate-to-claude.sh
```

## 依赖

### 必需依赖

| 依赖 | 用途 |
| --- | --- |
| 支持 Skills 的 Codex 环境 | 加载并执行协调工作流 |
| Claude Code CLI | 作为实现代理；`claude` 必须位于 `PATH` 且已完成认证 |
| Git | 检查工作树、差异和验证范围 |
| Bash | 运行 `delegate-to-claude.sh`；Windows 可使用 WSL 或 Git Bash |
| 常用 Unix 工具 | 脚本使用 `tee`、`mkdir`、`dirname` 和 `cat` |

Claude Code 版本需要支持脚本使用的 `--print`、`--output-format`、`--permission-mode`、`--no-session-persistence` 和 `--name` 参数。

### 条件依赖

- 任务指定 OMC 工作流时，同一个 Claude Code 环境必须已安装并配置 [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)。
- React、Next.js、TypeScript、Go、Playwright 等领域 Codex Skills 仅在对应项目中按需使用，不属于基础运行依赖。
- `--model` 和 `--max-budget-usd` 是可选参数，只有用户明确要求或批准限制时才应使用。

### 不依赖

- Skill 本身没有 npm 包依赖。
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
  --report-file "/absolute/path/to/claude-report.txt"
```

任务契约模板位于 [`references/task-contract.md`](skills/codex-claude-coordinator/references/task-contract.md)，完整工作流参见 [`SKILL.md`](skills/codex-claude-coordinator/SKILL.md)。

## 安全边界

- 不使用 `--dangerously-skip-permissions`。
- 不在同一工作树中并行运行多个写入代理。
- 不让 Claude 提交或推送代码。
- 不因 OMC 不可用而静默模拟或更换工作流。
- 不仅凭 Claude 的测试报告验收；Codex 必须独立复核。
