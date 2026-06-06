#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WebSocket = require(process.env.ONEBOT_WS_PACKAGE || "/home/node/.openclaw/plugins/openclaw-onebot-hook/node_modules/ws");

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/home/node/.openclaw/openclaw.json";
const PLUGIN_ROOT = process.env.ONEBOT_PLUGIN_ROOT || "/home/node/.openclaw/plugins/openclaw-onebot-hook";
const SESSIONS_PATH = process.env.OPENCLAW_MAIN_SESSIONS_PATH || "/home/node/.openclaw/agents/main/sessions/sessions.json";
const GATEWAY_WS = process.env.OPENCLAW_GATEWAY_WS || "ws://127.0.0.1:18789/";
const TRUSTED_USER = process.env.OPENCLAW_TRUSTED_USER || "lan@openclaw.local";
const AGENT_ID = process.env.ONEBOT_AGENT_ID || "main";
const ASSISTANT_TIMEOUT_MS = Number.parseInt(process.env.ONEBOT_ASSISTANT_TIMEOUT_MS || "60000", 10);
const ASSISTANT_SETTLE_MS = Number.parseInt(process.env.ONEBOT_ASSISTANT_SETTLE_MS || "2000", 10);

const logger = {
  debug: (message) => console.log(`[onebot-sidecar] ${message}`),
  info: (message) => console.log(`[onebot-sidecar] ${message}`),
  warn: (message) => console.warn(`[onebot-sidecar] ${message}`),
  error: (message) => console.error(`[onebot-sidecar] ${message}`),
};

const importFromPlugin = async (relativePath) => import(pathToFileURL(path.join(PLUGIN_ROOT, relativePath)).href);
const { getOneBotHookConfig } = await importFromPlugin("dist/config.js");
const { MessageDeduper, OneBotClient } = await importFromPlugin("dist/onebot-client.js");
const { decideInbound, buildSessionKey } = await importFromPlugin("dist/inbound.js");
const { ReplyChunkSender, sendOneBotMessageToCapturedTarget } = await importFromPlugin("dist/outbound.js");

let stopping = false;
let currentClient = null;
let reconnectTimer = null;
const deduper = new MessageDeduper();
const sessionQueues = new Map();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadHookConfig() {
  const root = readJson(CONFIG_PATH, {});
  const config = getOneBotHookConfig({ config: root });
  if (!config) throw new Error(`channels.onebot missing in ${CONFIG_PATH}`);
  return applySidecarConfigOverrides(config);
}

function applySidecarConfigOverrides(config) {
  const wsUrl = process.env.ONEBOT_SIDECAR_WS_URL?.trim();
  const httpUrl = process.env.ONEBOT_SIDECAR_HTTP_URL?.trim();
  const accessToken = process.env.ONEBOT_SIDECAR_ACCESS_TOKEN?.trim();
  return {
    ...config,
    ws: wsUrl ? { ...config.ws, mode: "forward", url: wsUrl } : config.ws,
    httpUrl: httpUrl || config.httpUrl,
    accessToken: accessToken || config.accessToken,
  };
}

function readGatewayToken() {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;
  const root = readJson(CONFIG_PATH, {});
  const token = root?.gateway?.auth?.token;
  return typeof token === "string" ? token.trim() : "";
}

function createGatewayClient() {
  const gatewayToken = readGatewayToken();
  const headers = {
    Origin: "http://127.0.0.1:18789",
    "X-Forwarded-Proto": "http",
    "X-Forwarded-Host": "127.0.0.1:18789",
    "X-Forwarded-User": TRUSTED_USER,
  };
  if (gatewayToken) headers.Authorization = `Bearer ${gatewayToken}`;
  const ws = new WebSocket(GATEWAY_WS, {
    headers,
  });
  const pending = new Map();
  const challengeWaiters = new Set();
  let challengeNonce = null;
  let challengeResolved = false;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway open timeout")), 10000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const request = (method, params) => {
    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ type: "req", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`gateway timeout: ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
    });
  };
  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "event" && message.event === "connect.challenge") {
      const nonce = message.payload && typeof message.payload.nonce === "string" ? message.payload.nonce.trim() : "";
      challengeNonce = nonce || null;
      challengeResolved = true;
      for (const resolve of challengeWaiters) resolve(challengeNonce);
      challengeWaiters.clear();
      return;
    }
    if (message.type !== "res") return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.ok) item.resolve(message.payload);
    else item.reject(new Error(message.error?.message || JSON.stringify(message.error)));
  });
  ws.on("close", () => {
    for (const [id, item] of pending) {
      pending.delete(id);
      clearTimeout(item.timer);
      item.reject(new Error("gateway closed"));
    }
    for (const resolve of challengeWaiters) resolve(null);
    challengeWaiters.clear();
  });
  const waitForChallenge = (timeoutMs) => {
    if (challengeResolved) return Promise.resolve(challengeNonce);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        challengeWaiters.delete(done);
        resolve(null);
      }, timeoutMs);
      const done = (nonce) => {
        clearTimeout(timer);
        resolve(nonce);
      };
      challengeWaiters.add(done);
    });
  };
  return { ws, opened, request, waitForChallenge };
}

async function withGateway(fn) {
  const client = createGatewayClient();
  await client.opened;
  await client.waitForChallenge(1200);
  const gatewayToken = readGatewayToken();
  await client.request("connect", {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: "openclaw-control-ui",
      version: "0.0.0",
      platform: "linux",
      mode: "webchat",
      instanceId: "openclaw-onebot-sidecar",
    },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
    auth: gatewayToken ? { token: gatewayToken } : undefined,
    caps: ["tool-events"],
    userAgent: "Mozilla/5.0 openclaw-onebot-sidecar",
    locale: "zh-CN",
  });
  try {
    return await fn(client.request);
  } finally {
    client.ws.close();
  }
}

function getSessionFile(sessionKey) {
  const sessions = readJson(SESSIONS_PATH, {});
  const file = sessions?.[sessionKey]?.sessionFile;
  return typeof file === "string" && file ? file : null;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function parseJsonLines(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      logger.warn(`ignored malformed session jsonl line (${trimmed.length} chars)`);
    }
  }
  return entries;
}

function readNewEntries(file, cursor) {
  if (!file || !fs.existsSync(file)) return { cursor, entries: [] };
  const size = fileSize(file);
  if (size <= cursor) return { cursor: size, entries: [] };
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - cursor);
    fs.readSync(fd, buffer, 0, buffer.length, cursor);
    return { cursor: size, entries: parseJsonLines(buffer.toString("utf8")) };
  } finally {
    fs.closeSync(fd);
  }
}

function enqueueSession(sessionKey, task) {
  const previous = sessionQueues.get(sessionKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task).finally(() => {
    if (sessionQueues.get(sessionKey) === next) sessionQueues.delete(sessionKey);
  });
  sessionQueues.set(sessionKey, next);
  return next;
}

function messageText(decision, message) {
  const text = decision.promptText || decision.text;
  if (decision.target?.kind === "group") {
    const name = message.sender?.card || message.sender?.nickname || message.user_id || "unknown";
    return `${name}: ${text}`;
  }
  return text;
}

async function dispatchToOpenClaw(sessionKey, text) {
  return withGateway(async (request) => {
    try {
      return await request("sessions.send", { key: sessionKey, message: text });
    } catch (error) {
      if (!String(error?.message || error).includes("not found")) throw error;
      await request("sessions.create", { agentId: AGENT_ID, key: sessionKey });
      return request("sessions.send", { key: sessionKey, message: text });
    }
  });
}

async function abortOpenClawRun(sessionKey, runId) {
  return withGateway((request) => request("sessions.abort", { key: sessionKey, runId }));
}

async function sendAssistantEntry(config, target, entry) {
  const sender = new ReplyChunkSender(
    config,
    target,
    (captured, outgoing) => sendOneBotMessageToCapturedTarget(currentClient ?? new OneBotClient(config, logger), config, captured, outgoing, logger),
    logger,
  );
  await sender.deliver(entry.message, { kind: "final" });
  await sender.finish();
}

async function waitAndForwardAssistant(config, target, sessionKey, sessionFile, initialCursor, startedAt, runId) {
  let cursor = initialCursor;
  let file = sessionFile;
  const sentIds = new Set();
  let sentAny = false;
  let lastSentAt = 0;
  const deadline = Date.now() + ASSISTANT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!file) file = getSessionFile(sessionKey);
    const result = readNewEntries(file, cursor);
    cursor = result.cursor;
    for (const entry of result.entries) {
      if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
      if (sentIds.has(entry.id)) continue;
      const ts = Date.parse(entry.timestamp || "");
      if (Number.isFinite(ts) && ts + 1000 < startedAt) continue;
      sentIds.add(entry.id);
      await sendAssistantEntry(config, target, entry);
      sentAny = true;
      lastSentAt = Date.now();
      logger.info(`forwarded assistant message ${entry.id} to ${target.kind}:${target.id}`);
    }
    if (sentAny && Date.now() - lastSentAt >= ASSISTANT_SETTLE_MS) return true;
    await sleep(750);
  }
  if (!sentAny && runId) {
    logger.warn(`assistant timeout for ${sessionKey}; aborting run=${runId}`);
    try {
      await abortOpenClawRun(sessionKey, runId);
      logger.warn(`aborted timed out run=${runId} for ${sessionKey}`);
    } catch (error) {
      logger.warn(`abort timed out run failed for ${sessionKey}: ${error.message || String(error)}`);
    }
  } else {
    logger.warn(`assistant timeout for ${sessionKey}`);
  }
  return sentAny;
}

async function handleOneBotMessage(message) {
  if (deduper.isDuplicate(message)) return;
  const config = loadHookConfig();
  const decision = decideInbound(config, message);
  if (!decision.forward || !decision.target) {
    logger.debug(`inbound ignored: ${decision.reason}`);
    return;
  }

  const target = decision.target;
  const sessionKey = buildSessionKey(AGENT_ID, target);
  await enqueueSession(sessionKey, async () => {
    const beforeFile = getSessionFile(sessionKey);
    const beforeCursor = beforeFile ? fileSize(beforeFile) : 0;
    const startedAt = Date.now();
    logger.info(`dispatch ${sessionKey} target=${target.kind}:${target.id}`);
    const result = await dispatchToOpenClaw(sessionKey, messageText(decision, message));
    logger.info(`sessions.send ${sessionKey} run=${result?.runId ?? "unknown"}`);
    await waitAndForwardAssistant(config, target, sessionKey, beforeFile, beforeCursor, startedAt, result?.runId);
  });
}

async function connectOneBot() {
  if (stopping) return;
  const config = loadHookConfig();
  const client = new OneBotClient(config, logger);
  currentClient = client;
  client.on("message", (message) => {
    void handleOneBotMessage(message).catch((error) => {
      logger.error(`handle message failed: ${error.stack || error.message || String(error)}`);
    });
  });
  client.on("close", () => {
    if (currentClient === client) currentClient = null;
    scheduleReconnect("OneBot websocket close");
  });
  try {
    await client.start();
    logger.info(`sidecar connected account=${config.accountId}`);
  } catch (error) {
    logger.warn(`connect failed: ${error.message || String(error)}`);
    await client.stop().catch(() => undefined);
    if (currentClient === client) currentClient = null;
    scheduleReconnect("connect failure");
  }
}

function scheduleReconnect(reason) {
  if (stopping || reconnectTimer) return;
  logger.warn(`reconnect after ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectOneBot();
  }, 3000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGTERM", () => {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  void currentClient?.stop?.().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  void currentClient?.stop?.().finally(() => process.exit(0));
});

await connectOneBot();
setInterval(() => undefined, 1 << 30);
