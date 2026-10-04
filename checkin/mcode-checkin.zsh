#!/bin/zsh
# =============================================================================
# mcode-checkin.zsh — MiniMax Code 每日自动签到
#
# 原理：官方 CLI（@minimax-ai/code）的签到是 TUI 斜杠命令 /checkin（v0.6.2 实证），
# 无 exec 子命令、ACP 也不暴露。本脚本用 macOS 内置 script 命令分配 pty，
# 以「轮询日志」方式驱动 TUI：
#   启动 → 等界面就绪 → 输入 /checkin → 等命令菜单出现 → 回车确认
#   → 轮询签到结果（Checked in / Already checked in / unavailable / 报错）
#   → /quit 退出 → 提取结果写入日志
#
# 凭证全程由 mcode CLI 自行读取（~/.minimax/auth/...），本脚本不读取、
# 不落盘任何 token/cookie。
#
# 退出码：0=签到成功或今日已签到  1=失败  2=未登录  3=找不到 mcode  4=超时
# =============================================================================
set -u

# ---- 可调参数（环境变量覆盖）-------------------------------------------------
MCK_READY_TIMEOUT="${MCK_READY_TIMEOUT:-120}"    # 等 TUI 就绪（秒）
MCK_MENU_TIMEOUT="${MCK_MENU_TIMEOUT:-30}"       # 等 /checkin 菜单（秒）
MCK_RESULT_TIMEOUT="${MCK_RESULT_TIMEOUT:-120}"  # 等签到结果（秒）
MCK_EXIT_TIMEOUT="${MCK_EXIT_TIMEOUT:-30}"       # 等 TUI 退出（秒）
LOG_DIR="${MCODE_CHECKIN_LOG_DIR:-$HOME/.mcode-checkin}"

# ---- 定位 mcode --------------------------------------------------------------
if [[ -z "${MCODE_BIN:-}" ]]; then
  MCODE_BIN="$(command -v mcode 2>/dev/null || true)"
fi
if [[ -z "${MCODE_BIN:-}" || ! -x "$MCODE_BIN" ]]; then
  # 兜底：本机网关运行时内置的 mcode（与系统登录态 ~/.minimax 共用）
  MCODE_BIN="/Users/guozhuang/WorkBuddy/2026-10-04-07-44-35/minimax-code-openai-gateway/.runtime/minimax-code/bin/mcode"
fi
if [[ ! -x "$MCODE_BIN" ]]; then
  echo "[checkin] ERROR: 找不到可执行的 mcode，请设置 MCODE_BIN 环境变量" >&2
  exit 3
fi

mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW="$LOG_DIR/raw-$STAMP.log"
CLEAN="$LOG_DIR/clean-$STAMP.txt"
OUT="$LOG_DIR/result-$STAMP.txt"

RESULT_PAT="Checked in:|Already checked in today\.|Daily check-in is unavailable|Couldn't complete daily check-in|Couldn't verify MiniMax sign-in|Daily check-in request failed|sign-in is required|Sign in with /login"

# ---- 清理：退出时确保杀掉 script/mcode 进程 -----------------------------------
cleanup() {
  [[ -n "${DRIVER_PID:-}" ]] && kill "$DRIVER_PID" 2>/dev/null
  [[ -n "${SCRIPT_PID:-}" ]] && kill "$SCRIPT_PID" 2>/dev/null
  pkill -f "$MCODE_BIN" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

strip_ansi() {
  sed -e 's/\x1b\[[0-9;?]*[a-zA-Z]//g' -e 's/\x1b[()#][A-B0]//g' -e 's/\x1b[>=]//g' "$RAW" | tr '\r' '\n'
}

# ---- 驱动子协程：轮询日志 + 按节奏发送按键 ------------------------------------
# 注意：回车必须是 \r（TUI 原始模式），不能用 \n
(
  # 等 TUI 就绪（底部状态栏出现）
  i=0
  while (( i < MCK_READY_TIMEOUT * 10 )); do
    strip_ansi | grep -qa "Permissions" && break
    sleep 0.1; (( i++ ))
  done
  if (( i >= MCK_READY_TIMEOUT * 10 )); then
    echo "[checkin] TUI 就绪超时（${MCK_READY_TIMEOUT}s）" >>"$LOG_DIR/driver-$STAMP.log"
    exit 1
  fi
  sleep 2  # 多等一会儿让账户检查先跑

  printf '/checkin'
  # 等命令菜单出现；若结果已直接出现（某些版本回车直达）则跳过等待
  i=0
  while (( i < MCK_MENU_TIMEOUT * 10 )); do
    strip_ansi | grep -qa "Claim the daily MiniMax account reward" && break
    strip_ansi | grep -qaE "$RESULT_PAT" && break
    sleep 0.1; (( i++ ))
  done
  sleep 1
  printf '\r'   # 确认菜单项 → 执行 checkin（结果已出现时此回车落在输入框，无害）

  # 等签到结果
  i=0
  while (( i < MCK_RESULT_TIMEOUT * 10 )); do
    strip_ansi | grep -qaE "$RESULT_PAT" && break
    sleep 0.1; (( i++ ))
  done

  # 退出 TUI：/quit 立即生效，输入后回车确认
  printf '/quit'
  sleep 2
  printf '\r'
  sleep 2
) | TERM=xterm-256color script -q "$RAW" "$MCODE_BIN" >/dev/null 2>&1 &
DRIVER_PID=$!

# 找到 script 子进程 pid（驱动管道的另一端）
SCRIPT_PID="$(pgrep -f "script -q $RAW" | head -1)"

# ---- 等待脚本结束 -------------------------------------------------------------
echo "[checkin] $(date '+%F %T') 启动：$MCODE_BIN"
i=0
TOTAL=$(( MCK_READY_TIMEOUT + MCK_MENU_TIMEOUT + MCK_RESULT_TIMEOUT + MCK_EXIT_TIMEOUT + 30 ))
while kill -0 "$SCRIPT_PID" 2>/dev/null && (( i < TOTAL * 2 )); do
  sleep 0.5; (( i++ ))
done
kill "$SCRIPT_PID" 2>/dev/null
kill "$DRIVER_PID" 2>/dev/null
pkill -f "$MCODE_BIN" 2>/dev/null
sleep 1

# ---- 提取结果 ----------------------------------------------------------------
strip_ansi > "$CLEAN" 2>/dev/null
MATCH="$(grep -aE "$RESULT_PAT" "$CLEAN" | tail -3)"

if [[ -z "$MATCH" ]]; then
  HINT=""
  if grep -qa "Starting server" "$CLEAN" 2>/dev/null; then
    HINT="TUI 卡在 Starting server（运行时所有权/daemon 冲突）。
排查：① 同一时刻只保留一个 MiniMax 运行时——桌面 App「MiniMax Code.app」
     正在运行时会持有运行时租约，可先退出桌面 App 再跑本脚本；
     ② 或直接在桌面 App / 终端 mcode 里手动 /checkin。"
  elif grep -qa "Checking account" "$CLEAN" 2>/dev/null; then
    HINT="TUI 卡在 Checking account（账户状态未解析）。排查：确认 CLI 已登录
（终端跑 mcode → /login），并只开一个 MiniMax 运行时。"
  fi
  {
    echo "=== 未捕获到签到结果（$(date '+%F %T'))==="
    echo "$HINT"
    echo "原始日志：$RAW"
    echo "清洗日志：$CLEAN"
    echo "--- 最后 15 行画面 ---"
    tail -15 "$CLEAN"
  } > "$OUT"
  echo "[checkin] 失败：未捕获到签到结果，详见 $OUT"
  [[ -n "$HINT" ]] && echo "[checkin] $HINT"
  exit 4
fi

echo "$MATCH" > "$OUT"
echo "[checkin] ---- 结果 ----"
cat "$OUT"
echo "[checkin] --------------"

case "$MATCH" in
  *"Checked in:"*)
    echo "[checkin] 签到成功 ✔"; exit 0 ;;
  *"Already checked in today."*)
    echo "[checkin] 今日已签到（无需重复）✔"; exit 0 ;;
  *"Sign in with /login"*|*"sign-in is required"*|*"Couldn't verify MiniMax sign-in"*)
    echo "[checkin] CLI 未登录：请先在终端运行 mcode 并执行 /login"; exit 2 ;;
  *)
    echo "[checkin] 签到未完成（不可用或出错），详见 $OUT"; exit 1 ;;
esac
