# MiniMax Code 每日自动签到

## 一句话结论

**有官方每日签到**：MiniMax Code CLI（v0.6.2）的 TUI 斜杠命令 `/checkin`，
描述 "Claim the daily MiniMax account reward"，7 天为一个周期，每天可领积分
（9/28–10/7 活动期有双倍）。**只有 TUI 有**——`mcode exec` 不处理斜杠命令，
没有 `mcode checkin` 子命令，ACP（`mcode acp`）也不暴露签到方法。

本目录的三个文件把「打开 TUI → 输入 /checkin → 回车确认 → 读结果 → 退出」
固化成可定时运行的自动化：

| 文件 | 作用 |
|---|---|
| `mcode-checkin.zsh` | 签到脚本（macOS 内置 `script` 分配 pty，轮询式驱动，不瞎等） |
| `com.minimax.mcode-checkin.plist` | launchd 定时任务（每天 09:05，可改） |
| `README.md` | 本说明 |

## 快速开始

```bash
# 1. 装脚本
mkdir -p ~/bin
cp mcode-checkin.zsh ~/bin/
chmod +x ~/bin/mcode-checkin.zsh

# 2. 先手动跑一次，亲眼确认（约 1-2 分钟）
~/bin/mcode-checkin.zsh
```

判断成功的三种画面（任一都算成功，退出码 0）：

- `Checked in: Cycle day N, +X Credits` —— 今天首次签到成功
- `Already checked in today.` —— 今天已签过（幂等，重复跑无害）
- （失败）`Daily check-in is unavailable right now.` —— 当前周期不可领

日志在 `~/.mcode-checkin/`：`result-*.txt` 是结果，`raw-*.log` 是 TUI 原始
输出（排障用）。

## 定时（launchd）

```bash
cp com.minimax.mcode-checkin.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.minimax.mcode-checkin.plist

# 立刻试跑一次（不等早上9点）
launchctl start com.minimax.mcode-checkin

# 卸载
launchctl unload ~/Library/LaunchAgents/com.minimax.mcode-checkin.plist
```

改时间：编辑 plist 里 `StartCalendarInterval` 的 `Hour`/`Minute`。

## mcode 位置

脚本按以下顺序找 `mcode`：

1. 环境变量 `MCODE_BIN`
2. `command -v mcode`（你自己装在 PATH 里的）
3. 兜底：`~/WorkBuddy/2026-10-04-07-44-35/minimax-code-openai-gateway/.runtime/minimax-code/bin/mcode`

登录态是用户级的（`~/.minimax/auth/`），三个路径共用同一份登录，
脚本本身**不读取、不保存任何 token**。

## 未登录怎么办

脚本退出码 2 并提示时，在终端里跑一次：

```bash
mcode        # 进 TUI
/login       # 扫码/浏览器登录
/quit
```

然后重跑签到脚本。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 退出码 4「未捕获到签到结果」+ 画面卡 `Starting server` | **桌面 App「MiniMax Code.app」正在运行**，它的后台进程持有运行时租约，CLI TUI 起不来。处理：先退出桌面 App 再跑本脚本；或直接在桌面 App 里手动签到（App 内置同一个签到功能，走的同一套接口） |
| 退出码 4 + 画面卡 `Checking account` | 账户状态未解析。确认 CLI 已登录（终端 `mcode` → `/login`），并只开一个 MiniMax 运行时 |
| 退出码 2「未登录」 | 按上一节 `/login` |
| 想跑得更稳 | 调大环境变量再跑：`MCK_RESULT_TIMEOUT=180 ~/bin/mcode-checkin.zsh` |
| 想手动验证命令本身 | 终端直接 `mcode` → 输入 `/checkin` → 菜单出现后回车 |

## 已验证结论（来自官方开源 CLI 0.6.2 与桌面 App 3.1.0 代码级核查）

- 签到命令：CLI 的 TUI `/checkin`，`readiness:"controller"`，会先校验登录态
  （未登录弹登录流程），再调
  `GET /minimax-cloud/api/v1/signin/status` →
  `POST /minimax-cloud/api/v1/signin/claim`
- 结果三态：`claimed`（day_no/points/expire_at_ms）/ `already-claimed` / `unavailable`
- 桌面 App（MiniMax Code.app）内置**同一套**签到接口，GUI 里即可手动签；
  CLI 与桌面 App 共用 `~/.minimax` 登录态，但运行时所有权互斥
  （`~/.minimax/v2/runtime-owner-leases` 租约机制）
- 自动化窗口：CLI/桌面 App 均未提供非交互签到入口（无 `mcode checkin`
  子命令、ACP 不暴露、无本地触发协议），所以只能走「pty 驱动 TUI」路线


## 已知边界

- 依赖本机 `~/.minimax` 的登录态；sign out 后需重新 `/login`。
- 活动期（如 9/28–10/7 双倍积分）结束后命令仍在，周期规则以官方为准。
- 签名（代码级结论，来自官方开源 CLI 0.6.2 bundle）：
  - 命令：TUI `/checkin`，`readiness:"controller"`
  - 流程：先 `getAccountStatus`（未登录会先弹登录）→ 再跑签到
  - 接口：`GET /minimax-cloud/api/v1/signin/status` → `POST /minimax-cloud/api/v1/signin/claim`
  - 结果：`claimed`（返回 day_no/points/expire_at_ms）/ `already-claimed` / `unavailable`
