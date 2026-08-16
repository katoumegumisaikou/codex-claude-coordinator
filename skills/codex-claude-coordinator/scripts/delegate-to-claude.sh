#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    '用法：delegate-to-claude.sh --workdir DIR --task-file FILE [选项]' \
    '' \
    '选项：' \
    '  --report-file FILE       保存并同时打印 Claude 输出。' \
    '  --permission-mode MODE   Claude 权限模式（默认：auto）。' \
    '  --model MODEL            可选的 Claude 模型或别名。' \
    '  --max-budget-usd AMOUNT  可选的最高 API 花费。' \
    '  -h, --help               显示此帮助。'
}

workdir=''
task_file=''
report_file=''
permission_mode="${CLAUDE_COORDINATOR_PERMISSION_MODE:-auto}"
model=''
max_budget_usd=''

while (($#)); do
  case "$1" in
    --workdir)
      workdir="${2:?--workdir 需要一个值}"
      shift 2
      ;;
    --task-file)
      task_file="${2:?--task-file 需要一个值}"
      shift 2
      ;;
    --report-file)
      report_file="${2:?--report-file 需要一个值}"
      shift 2
      ;;
    --permission-mode)
      permission_mode="${2:?--permission-mode 需要一个值}"
      shift 2
      ;;
    --model)
      model="${2:?--model 需要一个值}"
      shift 2
      ;;
    --max-budget-usd)
      max_budget_usd="${2:?--max-budget-usd 需要一个值}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '未知参数：%s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$workdir" || -z "$task_file" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -d "$workdir" ]]; then
  printf '工作目录不存在：%s\n' "$workdir" >&2
  exit 2
fi
if [[ ! -f "$task_file" ]]; then
  printf '任务文件不存在：%s\n' "$task_file" >&2
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  printf 'PATH 中找不到 Claude Code。\n' >&2
  exit 127
fi

case "$permission_mode" in
  acceptEdits|auto|manual|dontAsk|plan) ;;
  *)
    printf '不支持的权限模式：%s\n' "$permission_mode" >&2
    exit 2
    ;;
esac

task_content="$(<"$task_file")"
prompt="$(cat <<EOF
你是为 Codex 主代理工作的、边界受限的实现子代理。

严格遵循下方任务契约。编辑前先检查仓库。实现要求的代码和测试，然后执行指定验证。不要在契约范围外做产品或架构决策。不要提交、推送、重置、变基、切换分支、编辑密钥或删除无关工作。如果遇到阻塞或需求冲突，停止工作并报告阻塞原因。

如果任务契约指定了 oh-my-claudecode 工作流，必须通过 Claude Code 的 Skill 工具或已安装的斜杠入口实际调用准确的 OMC skill，不要只在文字上模拟其行为。一个会话只允许一个 OMC 主循环控制者。如果 skill 未安装、调用方式不受当前无交互环境支持，或者并发隔离条件不成立，停止并在“阻塞问题”中报告；不要静默降级到普通实现。

最终报告必须使用以下标题：
任务摘要
修改文件
执行测试
验证结果
风险
阻塞问题

--- 任务契约 ---
$task_content
--- 任务契约结束 ---
EOF
)"

claude_args=(
  --print
  --output-format text
  --permission-mode "$permission_mode"
  --no-session-persistence
  --name codex-implementation-subagent
)

if [[ -n "$model" ]]; then
  claude_args+=(--model "$model")
fi
if [[ -n "$max_budget_usd" ]]; then
  claude_args+=(--max-budget-usd "$max_budget_usd")
fi

run_claude() {
  cd "$workdir"
  claude "${claude_args[@]}" "$prompt"
}

if [[ -n "$report_file" ]]; then
  mkdir -p "$(dirname "$report_file")"
  run_claude | tee "$report_file"
else
  run_claude
fi
