#!/bin/bash
# ============================================================
# XT-Bot 本地运行脚本
# 用法:
#   ./run.sh init      # 初始化流程: 抓取指定用户全量推文并推送
#   ./run.sh sync      # 定时流水线: 更新关注列表 + 抓首页时间线并推送
#   ./run.sh follow    # 仅更新关注列表 (fetch-following)
#   ./run.sh timeline  # 仅抓首页时间线 (fetch-home-latest-timeline)
#   ./run.sh xbot      # 仅运行 X-Bot 数据处理 (提取媒体条目)
#   ./run.sh tbot      # 仅运行 T-Bot 下载+推送 (处理最近 7 天)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_BIN="$SCRIPT_DIR/Python/.venv/bin/python"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"
export PATH="$HOME/.bun/bin:$PATH"

# ---------- 加载 .env（不覆盖已存在的环境变量） ----------
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

PYTHON_SRC="$SCRIPT_DIR/Python/src"
TSSRC="$SCRIPT_DIR/TypeScript/scripts"

require_env() {
  local name="$1"
  local val
  val=$(printenv "$name" || true)
  if [[ -z "$val" || "$val" == your_*_here ]]; then
    echo "❌ 缺少环境变量: $name  (请在 .env 中配置)" >&2
    return 1
  fi
}

preflight() {
  [[ -x "$PYTHON_BIN" ]] || { echo "❌ 未找到 Python venv: $PYTHON_BIN，请先运行 Python/.venv 安装" >&2; exit 1; }
  [[ -x "$BUN_BIN" ]] || { echo "❌ 未找到 bun: $BUN_BIN" >&2; exit 1; }
  # 可选: 从 Redis 覆盖本地配置
  if [[ -n "$(printenv REDIS_CONFIG || true)" ]]; then
    echo "📡 检测到 REDIS_CONFIG，同步远程配置到本地文件..."
    (cd "$PYTHON_SRC" && "$PYTHON_BIN" ../utils/get_redis_config.py) || echo "⚠️  Redis 配置同步失败，继续使用本地配置"
  fi
}

cmd_init() {
  require_env AUTH_TOKEN || return 1
  require_env SCREEN_NAME || return 1
  require_env BOT_TOKEN || return 1
  require_env CHAT_ID || return 1
  preflight

  echo "========== [init] 初始化流程 =========="
  echo ">> 1/2 抓取指定用户全量推文 (fetch-tweets-media)"
  (cd "$TSSRC" && "$BUN_BIN" fetch-tweets-media.ts)
  echo ">> 2/2 处理并推送 (INI-XT-Bot.py)"
  (cd "$PYTHON_SRC" && "$PYTHON_BIN" INI-XT-Bot.py)
  echo "✅ 初始化流程完成"
}

cmd_sync() {
  require_env AUTH_TOKEN || return 1
  require_env SCREEN_NAME || return 1
  require_env BOT_TOKEN || return 1
  require_env CHAT_ID || return 1
  preflight

  echo "========== [sync] 定时流水线 =========="
  echo ">> 1/4 更新关注列表 (fetch-following)"
  (cd "$TSSRC" && "$BUN_BIN" fetch-following.ts)
  echo ">> 2/4 抓取首页时间线 (fetch-home-latest-timeline)"
  (cd "$TSSRC" && "$BUN_BIN" fetch-home-latest-timeline.ts)
  echo ">> 3/4 提取媒体条目 (X-Bot.py)"
  (cd "$PYTHON_SRC" && "$PYTHON_BIN" X-Bot.py)
  echo ">> 4/4 下载并推送 (T-Bot.py)"
  (cd "$PYTHON_SRC" && "$PYTHON_BIN" T-Bot.py)
  echo "✅ 定时流水线完成"
}

cmd_follow() {
  require_env AUTH_TOKEN || return 1
  require_env SCREEN_NAME || return 1
  preflight
  echo ">> 更新关注列表 (fetch-following)"
  (cd "$TSSRC" && "$BUN_BIN" fetch-following.ts)
}

cmd_timeline() {
  require_env AUTH_TOKEN || return 1
  preflight
  echo ">> 抓取首页时间线 (fetch-home-latest-timeline)"
  (cd "$TSSRC" && "$BUN_BIN" fetch-home-latest-timeline.ts)
}

cmd_xbot() {
  preflight
  echo ">> 运行 X-Bot 数据处理"
  (cd "$PYTHON_SRC" && "$PYTHON_BIN" X-Bot.py)
}

cmd_tbot() {
  preflight
  echo ">> 运行 T-Bot 下载+推送 (最近 7 天)"
  (cd "$PYTHON_SRC" && "$PYTHON_BIN" T-Bot.py)
}

case "${1:-}" in
  init)     cmd_init ;;
  sync)     cmd_sync ;;
  follow)   cmd_follow ;;
  timeline) cmd_timeline ;;
  xbot)     cmd_xbot ;;
  tbot)     cmd_tbot ;;
  *)
    echo "用法: $0 {init|sync|follow|timeline|xbot|tbot}"
    echo "  init      初始化流程: 抓取指定用户全量推文并推送"
    echo "  sync      定时流水线: 更新关注列表 + 抓首页时间线并推送"
    echo "  follow    仅更新关注列表"
    echo "  timeline  仅抓首页时间线"
    echo "  xbot      仅运行 X-Bot 数据处理"
    echo "  tbot      仅运行 T-Bot 下载+推送"
    exit 1
    ;;
esac
