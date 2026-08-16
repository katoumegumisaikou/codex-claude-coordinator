#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
runner="$script_dir/dist/claude-runner.js"

if [[ ! -f "$runner" ]]; then
  printf '找不到已编译的协调器：%s\n请在 skill 目录运行 npm run build。\n' "$runner" >&2
  exit 1
fi

node_bin="${CLAUDE_COORDINATOR_NODE:-}"
if [[ -z "$node_bin" ]] && command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
fi
if [[ -z "$node_bin" ]] && command -v claude >/dev/null 2>&1; then
  claude_bin="$(command -v claude)"
  adjacent_node="$(dirname -- "$claude_bin")/node"
  if [[ -x "$adjacent_node" ]]; then
    node_bin="$adjacent_node"
  fi
fi
if [[ -z "$node_bin" ]]; then
  printf '找不到 Node.js。请安装 Node.js，或设置 CLAUDE_COORDINATOR_NODE。\n' >&2
  exit 127
fi

exec "$node_bin" "$runner" "$@"
