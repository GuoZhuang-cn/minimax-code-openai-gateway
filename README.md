# MiniMax Code OpenAI Gateway

本机回环地址的最小 OpenAI Chat Completions 兼容层：通过 **官方 MiniMax Code CLI** 的 `mcode exec` 获取回答。它不读取 MiniMax Code 桌面版、浏览器或系统钥匙串中的登录凭证，不调用私有桌面接口，不监听局域网。

## 当前支持范围

- `GET /healthz`（无需密钥）
- `GET /v1/models`
- `POST /v1/chat/completions`
- 单模型别名：`minimax-code`
- 仅纯文本 `system`、`developer`、`user`、`assistant` 消息；最后一条必须为 `user`
- `stream: false` 或 `stream: true`。流式模式是 **BUFFERED SSE**：先等完整 CLI 结果，再分块返回，并非逐 token 实时流。

明确拒绝 tools、图像/文件内容、JSON schema、采样参数、多候选输出及未支持字段，避免悄悄改变调用语义。

## 安全边界

- 仅绑定 `127.0.0.1`，并校验回环客户端、Host 和 Origin；禁止跨域访问。
- 除健康检查外全部要求长度至少 32 位的 Bearer API Key；密钥只保存在被 Git 忽略的 `.state/gateway.key`（仅当前用户可读）。
- 请求体上限 128 KiB、单请求并发、运行超时、无模型正文和密钥日志。
- CLI 以独立 HOME、数据目录和空工作区启动；不继承用户 HOME、代理变量、`NODE_OPTIONS` 或现有令牌。
- 在 macOS 上，启动前必须通过系统 `sandbox-exec` 检查：先确认系统能够施加限制性 Seatbelt profile，再运行 canary 验证 worker 无法读取/写入网关状态区外文件、只能写入其空工作区、不能执行 shell。任一环节不通过，网关保持不可用，绝不静默裸跑 CLI。

> macOS 系统级沙箱的实际行为会随版本和安全策略变化。`npm run setup` / `npm run doctor` 的预检是启用前提；未通过预检或未完成认证模型验证，`/healthz` 会显示不可用，聊天请求返回 503。

### 沙箱状态取值

`readiness.sandbox` 只会是以下之一，含义严格区分：

| 取值 | 含义 | 网关是否启用 |
| --- | --- | --- |
| `verified` | 系统成功施加限制性沙箱，且 canary 全部通过（读/写外部文件被拒、内部可读写、spawn shell 被拒） | 启用 |
| `verification_failed` | 沙箱施加成功但隔离检查失败，或 CLI 自校验失败 | 保持禁用 |
| `unavailable` | 系统拒绝施加任何限制性 profile（典型：网关进程本身运行在另一个沙箱内，macOS 不允许嵌套叠加，`sandbox_apply` 返回 `Operation not permitted`；也见于未来 OS 策略变更） | 保持禁用 |
| `unsandboxed_opt_in` | 同上，但用户显式设置了 `GATEWAY_ALLOW_UNSANDBOXED=1` 主动降级 | 启用（隔离仅剩独立 HOME/数据目录/空工作区） |
| `unsupported_platform` | 非 macOS | 保持禁用 |

在普通终端（不在其它沙箱内）运行本网关时，`sandbox-exec` 可正常施加限制性 profile，`verified` 是预期结果。若在已处于沙箱的环境中运行（例如某些自动化宿主），内核会拒绝嵌套施加，得到 `unavailable` 属预期；此时要么回到普通终端运行，要么显式降级：

```bash
GATEWAY_ALLOW_UNSANDBOXED=1 npm run start
```

降级意味着 CLI 保留其对本地文件系统的正常读写与工具能力（它自己的 `--permission` 策略不变），隔离仅剩独立 HOME、独立数据目录与空工作区这三层。该开关不是默认值，必须由使用者显式设置。

## 安装与启用

当前本机已将官方 MiniMax Code CLI 隔离安装在项目的 `.runtime/`，不会修改 MiniMax Code 桌面应用或 shell PATH。`.runtime/` 不会提交到 GitHub；在新的克隆目录中，先下载官方安装脚本、检查其内容后，再安装到相同隔离位置：

```bash
cd /path/to/minimax-code-openai-gateway
curl --fail --location --silent --show-error https://filecdn.minimax.chat/public/install.sh --output /tmp/minimax-code-install.sh
shasum -a 256 /tmp/minimax-code-install.sh
MCODE_INSTALL_DIR="$PWD/.runtime/minimax-code" MCODE_NO_MODIFY_PATH=1 bash /tmp/minimax-code-install.sh
npm run setup
npm run doctor
```

安装脚本只接受官方 npm registry，并会对其下载的依赖进行自身校验；安装完成后仍须以 `doctor` 的沙箱验证结果为准。

如果 `doctor` 中 sandbox 为 `verified` 或 `unsandboxed_opt_in`，执行下列命令获取一次性认证命令，再在**你自己的终端**完成官方浏览器登录：

```bash
npm run login
```

本项目不接收、不显示 MiniMax 账号密码或 token。登录完成后，真实模型验证只会请求“回复 OK”：

```bash
npm run verify
npm run start
```

网关启动后获取本机 API Key：

```bash
npm run key
```

示例调用（将 `YOUR_LOCAL_KEY` 替换为上一步输出，勿提交到任何仓库）：

```bash
curl http://127.0.0.1:18765/v1/chat/completions \
  -H "Authorization: Bearer YOUR_LOCAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"minimax-code","messages":[{"role":"user","content":"你好"}]}'
```

## 验证

```bash
npm test
```

测试全部 mock CLI，不会触发登录、模型请求、文件读写或网络调用。

## 运行限制

- 默认端口 `18765`，可通过 `GATEWAY_PORT` 调整到 1024–65535 的未占用端口；任何已有服务都不会被自动停止。
- 这不是官方 OpenAI API，也不是通用模型 API。MiniMax Code 是 Agent；网关把完整会话交给一次 `mcode exec`。工具调用在系统沙箱中被限制，但不能将它用于处理不应发送给 MiniMax 的敏感内容。
- 不公开到局域网或互联网；如需远程使用，应通过受控的本机隧道/认证层另行设计，而不是改监听地址。
