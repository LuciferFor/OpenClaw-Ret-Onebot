# OpenClaw OneBot Hook 部署记录

本文件记录当前两台已部署主机的真实拓扑、systemd service、关键路径和排障命令。所有文件使用 UTF-8。不要把 SSH 密码、OneBot access token、OpenClaw gateway token 写进仓库。

## 通用原则

- 插件目录固定为 `~/.openclaw/plugins/openclaw-onebot-hook`。
- sidecar 固定为 `~/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs`。
- sidecar 负责可靠链路：OneBot 入站 -> OpenClaw `sessions.send` -> 读取 session assistant 消息 -> OneBot HTTP/WS 发回原目标。
- 不依赖 agent、skills、tool 自己调用 OneBot 发消息接口。
- OpenClaw gateway token 优先从 `OPENCLAW_GATEWAY_TOKEN` 读取；没有则从 `OPENCLAW_CONFIG_PATH` 指向的 `openclaw.json` 读取 `gateway.auth.token`。
- sidecar 已兼容 OpenClaw `connect.challenge` 握手。
- 出站等待默认 `ONEBOT_ASSISTANT_TIMEOUT_MS=60000`，超时且没有 assistant 回复时会 `sessions.abort` 释放卡住的 run。
- 插件进程内 service 默认不连接 OneBot，避免和 sidecar 双路回复；只有显式设置 `ONEBOT_HOOK_INPROCESS_SERVICE=1` 才启用。

## 部署脚本

从本地 Windows/PowerShell 工作区运行：

```powershell
npm run build
npm test
powershell -ExecutionPolicy Bypass -File ./scripts/deploy-sidecar.ps1 -Profile ./deploy/hosts/31.11.env.example
powershell -ExecutionPolicy Bypass -File ./scripts/deploy-sidecar.ps1 -Profile ./deploy/hosts/31.9.env.example
```

脚本使用 `ssh`、`scp`、`tar` 和远端 `sudo systemctl`。SSH 密码和 sudo 密码由终端交互输入，不保存在 profile 里。

## 192.168.31.11

用途：Docker 方式运行 OpenClaw gateway。

关键事实：

- SSH 用户：`lucifer`
- OpenClaw 容器：`openclaw-openclaw-gateway-1`
- 容器内 OpenClaw HOME：`/home/node/.openclaw`
- 宿主机插件目录：`/home/lucifer/.openclaw/plugins/openclaw-onebot-hook`
- 容器内插件目录：`/home/node/.openclaw/plugins/openclaw-onebot-hook`
- 宿主机 sidecar：`/home/lucifer/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs`
- 容器内 sidecar：`/home/node/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs`
- OneBot HTTP/WS 在容器视角下可用，已验证 `get_status` 和 `send_private_msg`。
- 当前 systemd 服务在宿主机用 `docker exec` 启动容器内 sidecar。

推荐 service：

```ini
[Unit]
Description=OpenClaw OneBot reliable sidecar hook
After=network-online.target docker.service

[Service]
Type=simple
ExecStart=/usr/bin/docker exec openclaw-openclaw-gateway-1 node /home/node/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

检查命令：

```bash
systemctl is-active openclaw-onebot-sidecar.service
journalctl -u openclaw-onebot-sidecar.service --since '10 minutes ago' --no-pager -o short-iso
docker exec openclaw-openclaw-gateway-1 node --check /home/node/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs
docker exec openclaw-openclaw-gateway-1 sh -lc 'node -v && ls -la /home/node/.openclaw/plugins/openclaw-onebot-hook/dist'
```

期望日志：

```text
[onebot-sidecar] [onebot-hook] forward WebSocket connected: ws://127.0.0.1:3000
[onebot-sidecar] sidecar connected account=default
```

31.11 曾出现的问题：

- OpenClaw session `embedded_run` 长时间 stalled，旧 sidecar 会等 4 分钟。
- 已修为 60 秒超时并主动 `sessions.abort`。
- sidecar 与 in-process 插件 service 同时运行时会重复回复。当前版本默认关闭 in-process service，只保留 sidecar。
- 如果 QQ 收不到但 OpenClaw 有回复，优先查 sidecar journal 的 `forwarded assistant message`、`sent private/group`、`assistant timeout`。

## 192.168.31.9

用途：本机进程方式运行 OpenClaw gateway，不是 Docker。

关键事实：

- SSH 用户：`lucifer`
- OpenClaw gateway 进程：`/home/lucifer/.openclaw/tools/node-v22.22.0/bin/node ... openclaw/dist/index.js gateway --port 18789`
- OpenClaw gateway WS：`ws://127.0.0.1:18789/`
- OpenClaw HOME：`/home/lucifer/.openclaw`
- 插件目录：`/home/lucifer/.openclaw/plugins/openclaw-onebot-hook`
- sidecar：`/home/lucifer/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs`
- OneBot HTTP：`http://127.0.0.1:3000`
- NapCat/QQ WS：`ws://127.0.0.1:3001`
- 历史 group filter 代理：`/home/lucifer/.openclaw/workspace/scripts/onebot_group_filter.js`，监听 `ws://127.0.0.1:3002`
- 31.9 上旧 `openclaw-onebot` channel 仍可能连接 `3002`；sidecar 必须直连 `3001`，避免和旧 channel 抢 `3002` 的单连接。

推荐 service：

```ini
[Unit]
Description=OpenClaw OneBot reliable sidecar hook
After=network-online.target

[Service]
Type=simple
User=lucifer
WorkingDirectory=/home/lucifer/.openclaw
Environment=HOME=/home/lucifer
Environment=OPENCLAW_CONFIG_PATH=/home/lucifer/.openclaw/openclaw.json
Environment=ONEBOT_PLUGIN_ROOT=/home/lucifer/.openclaw/plugins/openclaw-onebot-hook
Environment=OPENCLAW_MAIN_SESSIONS_PATH=/home/lucifer/.openclaw/agents/main/sessions/sessions.json
Environment=OPENCLAW_GATEWAY_WS=ws://127.0.0.1:18789/
Environment=OPENCLAW_TRUSTED_USER=lan@openclaw.local
Environment=ONEBOT_AGENT_ID=main
Environment=ONEBOT_WS_PACKAGE=/home/lucifer/.openclaw/plugins/openclaw-onebot-hook/node_modules/ws
Environment=ONEBOT_SIDECAR_WS_URL=ws://127.0.0.1:3001
Environment=ONEBOT_ASSISTANT_TIMEOUT_MS=60000
Environment=ONEBOT_ASSISTANT_SETTLE_MS=2000
ExecStart=/home/lucifer/.openclaw/tools/node-v22.22.0/bin/node /home/lucifer/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

检查命令：

```bash
systemctl is-active openclaw-onebot-sidecar.service
journalctl -u openclaw-onebot-sidecar.service --since '10 minutes ago' --no-pager -o short-iso
ss -tnp 2>/dev/null | grep -E ':(3001|3002|18789)' || true
/home/lucifer/.openclaw/tools/node-v22.22.0/bin/node --check /home/lucifer/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs
```

期望日志：

```text
[onebot-sidecar] [onebot-hook] forward WebSocket connected: ws://127.0.0.1:3001
[onebot-sidecar] sidecar connected account=default
```

31.9 曾出现的问题：

- 只有旧 OpenClaw channel 连接 `3002`，没有 sidecar 常驻，导致 OpenClaw 有回复但 QQ 不转发。
- sidecar 初次部署时缺 OpenClaw gateway token，日志为 `unauthorized: gateway token missing`，导致 QQ 入站收到但没有进 OpenClaw。
- 31.9 gateway 会先发 `connect.challenge`，sidecar 必须等待 challenge 后带 `auth: { token }` 发 `connect`。
- `3002` 是旧 group filter 的单连接代理，旧 channel 和 sidecar 同时连接会互相顶；sidecar 已改为 `ONEBOT_SIDECAR_WS_URL=ws://127.0.0.1:3001` 直连 NapCat。

## 新机器迁移清单

1. 安装 Node 22.19+ 或使用 OpenClaw 自带 Node。
2. 确认 OneBot v11 HTTP 和 WS 地址，例如 `http://127.0.0.1:3000`、`ws://127.0.0.1:3001`。
3. 在 `openclaw.json` 配好 `channels.onebot`，保留 `accessToken` 在远端配置内，不写入仓库。
4. 复制一个 `deploy/hosts/*.env.example`，按新机器路径改 profile。
5. 运行 `powershell -ExecutionPolicy Bypass -File ./scripts/deploy-sidecar.ps1 -Profile <profile>`。
6. 检查 sidecar journal 是否 connected。
7. 私聊发一条，确认 OpenClaw session 出现用户消息并且 QQ 收到回复。
8. 群聊只在 @ 或关键词时触发；不 @ 不应进 OpenClaw。

## 快速判定故障位置

- QQ 消息没有出现在 sidecar journal：OneBot WS 没连上，查 `ONEBOT_SIDECAR_WS_URL`、access token、NapCat 在线状态。
- sidecar journal 有 `dispatch`，OpenClaw 里没有消息：查 gateway token、`connect.challenge`、`sessions.send` 错误。
- OpenClaw 有 assistant 回复，QQ 没收到：查 OneBot HTTP、`send_private_msg` / `send_group_msg` 错误和 sidecar `sent private/group` 日志。
- 只有等很久才回复：查 OpenClaw `stalled session`，sidecar 应在 60 秒超时后 abort。
