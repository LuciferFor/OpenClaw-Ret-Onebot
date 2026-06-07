# OpenClaw OneBot Hook 部署记录

本文件记录当前两台已部署主机的真实拓扑、systemd service、关键路径和排障命令。所有文件使用 UTF-8。不要把 SSH 密码、OneBot access token、OpenClaw gateway token 写进仓库。

## 通用原则

- 插件目录固定为 `~/.openclaw/plugins/openclaw-onebot-hook`。
- sidecar 固定为 `~/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs`。
- sidecar 负责可靠链路：OneBot 入站 -> OpenClaw `sessions.send` -> 读取 session assistant 消息 -> OneBot HTTP/WS 发回原目标。
- 不依赖 agent、skills、tool 自己调用 OneBot 发消息接口。
- OpenClaw gateway token 优先从 `OPENCLAW_GATEWAY_TOKEN` 读取；没有则从 `OPENCLAW_CONFIG_PATH` 指向的 `openclaw.json` 读取 `gateway.auth.token`。
- sidecar 已兼容 OpenClaw `connect.challenge` 握手。
- 出站等待默认 `ONEBOT_ASSISTANT_IDLE_TIMEOUT_MS=180000`、`ONEBOT_ASSISTANT_MAX_WAIT_MS=600000`、`ONEBOT_ASSISTANT_CATCHUP_SCAN_MS=3000`。有工具调用/工具结果等 session 进展时会继续等；每 3 秒会 catch-up 扫描当前 session 文件，防止增量 cursor 漏读；完全无进展超时且没有 assistant 回复时才 `sessions.abort` 释放卡住的 run。
- 出站文件默认开启：结构化 `file/path/fileUrl` 和 assistant 文本里的 allowlist 本地路径会走 OneBot `upload_private_file` / `upload_group_file`；默认上限 4GiB，失败时发路径、大小和原因文本。
- 入站文件默认开启：OneBot `file` segment 会优先使用事件 URL，其次尝试 `get_private_file_url` / `get_group_file_url` / `get_file`，保存到 `~/.openclaw/workspace/incoming/onebot-files`，并把真实路径写入 OpenClaw `FilePath`、`FilePaths` 和 prompt 的 `[path: ...]` 行。
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
ExecStartPre=-/usr/bin/docker exec openclaw-openclaw-gateway-1 sh -lc "/usr/bin/pkill -9 -f 'node .*openclaw-onebot-sidecar.mjs' || true"
ExecStart=/usr/bin/docker exec openclaw-openclaw-gateway-1 node /home/node/.openclaw/workspace/tools/onebot/openclaw-onebot-sidecar.mjs
ExecStopPost=-/usr/bin/docker exec openclaw-openclaw-gateway-1 sh -lc "/usr/bin/pkill -9 -f 'node .*openclaw-onebot-sidecar.mjs' || true"
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
- 已修为无进展超时并主动 `sessions.abort`，默认 180 秒无进展、最长 10 分钟。
- Docker `docker exec` 重启时容器内可能残留旧 sidecar node 进程；service 已加 `ExecStartPre` / `ExecStopPost` 清理 `openclaw-onebot-sidecar.mjs`。
- Docker 容器内上传宿主机工作区文件时，`channels.onebot.files.pathMappings` 默认把 `/home/lucifer/.openclaw/workspace` 映射到 `/home/node/.openclaw/workspace`。
- Docker 容器内接收 QQ 文件时，入站文件落在 `/home/node/.openclaw/workspace/incoming/onebot-files`。如果 NapCat 只返回宿主机本地路径且容器不可见，日志会记录 `inbound file download failed`，需要优先让 OneBot 返回 URL。
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
Environment=ONEBOT_ASSISTANT_IDLE_TIMEOUT_MS=180000
Environment=ONEBOT_ASSISTANT_MAX_WAIT_MS=600000
Environment=ONEBOT_ASSISTANT_TIMEOUT_MS=180000
Environment=ONEBOT_ASSISTANT_CATCHUP_SCAN_MS=3000
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
- 2026-06-06 18:01 与 21:00 的私聊触发了 Bash/Cron 工具，但工具结果刚写入时撞上 60 秒超时，run 被 sidecar abort，导致没有 final 回复。当前 sidecar 已改成“先读取 session 再判断超时”的无进展等待，默认 180 秒无进展、最长 10 分钟，工具仍在进展时不会立刻 abort。
- 2026-06-06 23:47 与 23:51 的群聊 OpenClaw 已经写出 assistant，但 sidecar 增量 cursor 没读到，最终误判超时。当前 sidecar 增加每 3 秒 catch-up 扫描当前 session 文件，发现 startedAt 之后的 assistant 会补发。
- 2026-06-07 14:00 的连续私聊里，OpenClaw reset/切换了 session 文件，sidecar 仍盯旧文件导致第一条有 OpenClaw 回复但 QQ 没收到；第二条被同会话队列压到第一条超时后才送入 OpenClaw。当前 sidecar 会动态刷新 session 文件路径，并且同会话只串行 `sessions.send`，不再把后续入站消息卡到上一轮回复等待结束之后。
- 2026-06-07 14:15 的 zip 附件只在 OpenClaw 文本里显示路径，没有发到 QQ。当前 hook 已支持文件上传，文本中 allowlist 路径如 `/home/lucifer/.openclaw/workspace/out/*.zip` 会被识别并上传；上传失败会发文本兜底。
- 2026-06-07 15:40 的 QQ zip 入站只变成 `[file: xxx.zip]` 占位，OpenClaw 拿不到内容。当前 hook 已支持入站文件下载落盘，成功后 OpenClaw 会看到 `/home/.../.openclaw/workspace/incoming/onebot-files/...zip`。
- 2026-06-07 17:34 的 B 站视频下载请求仍在持续写 `*.trajectory.jsonl` 工具进度，但旧 sidecar 只盯 session JSONL，180 秒未见 assistant 后误判 idle 并 abort run，最终 QQ 没收到回复。当前 sidecar 同时监听 session trajectory 的 `tool.*` / `model.*` / `session.*` 事件，并会补发 `pendingFinalDeliveryText`。

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
- OpenClaw 回复里有本地文件路径但 QQ 没附件：查 `channels.onebot.files.allowedRoots`、`pathMappings`、文件是否真实存在，以及 sidecar journal 的 `uploaded ... file=` 或 `文件上传失败`。
- QQ 发了文件但 OpenClaw 只看到文件名：查 sidecar journal 的 `inbound file download failed`，以及 `channels.onebot.files.downloadInboundFiles`、`incomingDir`、`maxFileBytes`、OneBot `get_file` / 文件 URL 是否可用。
- 只有等很久才回复：查 OpenClaw `stalled session`，sidecar 应在 180 秒无进展后 abort。
