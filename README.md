# openclaw-onebot-hook

Reliable OpenClaw <-> OneBot v11 channel plugin.

This plugin intentionally does not register agent tools or skills. It forwards OneBot inbound messages into OpenClaw from a background service, then sends OpenClaw reply chunks directly through OneBot `send_private_msg` or `send_group_msg` using the target captured from the inbound event.

## Install

```bash
npm install
npm run build
openclaw plugins install .
```

If another OneBot plugin such as `openclaw-onebot` is enabled, disable it first. Running both at once can produce duplicate replies.

## Config

```json
{
  "plugins": {
    "allow": ["openclaw-onebot-hook"],
    "entries": {
      "openclaw-onebot-hook": {
        "enabled": true
      }
    }
  },
  "channels": {
    "onebot": {
      "enabled": true,
      "ws": {
        "mode": "forward",
        "url": "ws://127.0.0.1:3001/onebot/v11/ws"
      },
      "httpUrl": "http://127.0.0.1:3001",
      "accessToken": "replace-with-token",
      "trigger": {
        "private": "all",
        "group": "mention_or_keyword",
        "keywords": ["openclaw"],
        "stripMention": true
      },
      "allowFrom": [],
      "denyFrom": [],
      "reply": {
        "mode": "chunked",
        "flushIntervalMs": 1200,
        "flushChars": 160,
        "markdownToPlain": true,
        "maxRetries": 3
      },
      "media": {
        "enabled": true,
        "downloadInboundImages": true,
        "cacheDir": "~/.openclaw/media/onebot",
        "maxImageBytes": 15000000,
        "downloadTimeoutMs": 10000,
        "retainHours": 24,
        "outboundMode": "segments",
        "markdownImages": true,
        "maxImagesPerReply": 6
      },
      "files": {
        "enabled": true,
        "maxFileBytes": 4294967296,
        "detectTextPaths": true,
        "downloadInboundFiles": true,
        "incomingDir": "~/.openclaw/workspace/incoming/onebot-files",
        "downloadTimeoutMs": 30000,
        "allowedRoots": [
          "~/.openclaw/workspace",
          "/home/lucifer/.openclaw/workspace",
          "/home/node/.openclaw/workspace"
        ],
        "pathMappings": [
          {
            "from": "/home/lucifer/.openclaw/workspace",
            "to": "/home/node/.openclaw/workspace"
          }
        ],
        "fallbackOnFailure": "text"
      }
    }
  }
}
```

Private messages are forwarded by default. Group messages are forwarded only when the bot is mentioned or a configured keyword is present. Image + text messages preserve their OneBot segment order; inbound images are cached locally when possible and outbound images are sent as OneBot `image` segments. File attachments are uploaded with OneBot/NapCat `upload_private_file` or `upload_group_file`; assistant text paths are only auto-uploaded when they point at a real file under `channels.onebot.files.allowedRoots`.
Inbound OneBot `file` segments are downloaded into `channels.onebot.files.incomingDir` when OneBot exposes a URL, local path, base64 source, or a resolvable `get_file` result. The saved path is added to OpenClaw as `FilePath` / `FilePaths` and as a readable `[path: ...]` line in the prompt.

## Verify

```bash
npm run build
npm test
```

## Deployment Notes

See [docs/deployment.md](docs/deployment.md) for the recorded `192.168.31.11` and `192.168.31.9` deployments, host profiles, service files, and troubleshooting commands.
