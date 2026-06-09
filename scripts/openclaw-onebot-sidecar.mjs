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
const ASSISTANT_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.ONEBOT_ASSISTANT_IDLE_TIMEOUT_MS || process.env.ONEBOT_ASSISTANT_TIMEOUT_MS || "180000",
  10,
);
const ASSISTANT_MAX_WAIT_MS = Number.parseInt(process.env.ONEBOT_ASSISTANT_MAX_WAIT_MS || "600000", 10);
const ASSISTANT_SETTLE_MS = Number.parseInt(process.env.ONEBOT_ASSISTANT_SETTLE_MS || "2000", 10);
const ASSISTANT_CATCHUP_SCAN_MS = Number.parseInt(process.env.ONEBOT_ASSISTANT_CATCHUP_SCAN_MS || "3000", 10);
const PENDING_FINAL_WAIT_MS = Number.parseInt(process.env.ONEBOT_PENDING_FINAL_WAIT_MS || "8000", 10);
const INBOUND_TEXT_DEBOUNCE_MS = Number.parseInt(process.env.ONEBOT_INBOUND_TEXT_DEBOUNCE_MS || "400", 10);
const INBOUND_MEDIA_GRACE_MS = Number.parseInt(process.env.ONEBOT_INBOUND_MEDIA_GRACE_MS || "8000", 10);
const INBOUND_MAX_BATCH_MS = Number.parseInt(process.env.ONEBOT_INBOUND_MAX_BATCH_MS || "12000", 10);
const ORPHAN_CATCHUP_SCAN_MS = Number.parseInt(process.env.ONEBOT_ORPHAN_CATCHUP_SCAN_MS || "5000", 10);
const ORPHAN_CATCHUP_WINDOW_MS = Number.parseInt(process.env.ONEBOT_ORPHAN_CATCHUP_WINDOW_MS || "120000", 10);
const PROCESS_STARTED_AT = Date.now();

const logger = {
  debug: (message) => console.log(`[onebot-sidecar] ${message}`),
  info: (message) => console.log(`[onebot-sidecar] ${message}`),
  warn: (message) => console.warn(`[onebot-sidecar] ${message}`),
  error: (message) => console.error(`[onebot-sidecar] ${message}`),
};

const importFromPlugin = async (relativePath) => import(pathToFileURL(path.join(PLUGIN_ROOT, relativePath)).href);
const { getOneBotHookConfig } = await importFromPlugin("dist/config.js");
const { MessageDeduper, OneBotClient, isOkResponse } = await importFromPlugin("dist/onebot-client.js");
const { decideInbound, buildSessionKey } = await importFromPlugin("dist/inbound.js");
const { prepareInboundMediaParts, partsToText } = await importFromPlugin("dist/media.js");
const { ReplyChunkSender, sendOneBotFileToCapturedTarget, sendOneBotMessageToCapturedTarget } = await importFromPlugin("dist/outbound.js");

let stopping = false;
let currentClient = null;
let reconnectTimer = null;
const deduper = new MessageDeduper();
const sessionQueues = new Map();
const inboundBuffers = new Map();
const deliveredAssistantIdsBySession = new Map();
let orphanCatchupTimer = null;

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

function getSessionMeta(sessionKey) {
  const sessions = readJson(SESSIONS_PATH, {});
  const meta = sessions?.[sessionKey];
  return meta && typeof meta === "object" ? meta : null;
}

function getPendingFinalDelivery(sessionKey, startedAt) {
  const meta = getSessionMeta(sessionKey);
  const text = meta?.pendingFinalDeliveryText;
  if (typeof text !== "string" || !text.trim()) return null;
  const createdAt = Number(meta?.pendingFinalDeliveryCreatedAt ?? meta?.updatedAt ?? 0);
  if (Number.isFinite(createdAt) && createdAt && createdAt + 1000 < startedAt) return null;
  return {
    text: text.trim(),
    id: `pending-final:${createdAt || "unknown"}:${crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)}`,
  };
}

function trajectoryFileForSessionFile(file) {
  if (!file || typeof file !== "string" || !file.endsWith(".jsonl")) return null;
  return file.slice(0, -".jsonl".length) + ".trajectory.jsonl";
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

function readAllEntries(file) {
  if (!file || !fs.existsSync(file)) return [];
  try {
    return parseJsonLines(fs.readFileSync(file, "utf8"));
  } catch (error) {
    logger.warn(`failed to catch up session file ${file}: ${error.message || String(error)}`);
    return [];
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

function deliveredAssistantIds(sessionKey) {
  let ids = deliveredAssistantIdsBySession.get(sessionKey);
  if (!ids) {
    ids = new Set();
    deliveredAssistantIdsBySession.set(sessionKey, ids);
  }
  if (ids.size > 1000) ids.clear();
  return ids;
}

function targetFromSessionKey(sessionKey) {
  const match = /^agent:[^:]+:onebot:(direct|group):(.+)$/.exec(sessionKey);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isFinite(id)) return null;
  return { kind: match[1] === "group" ? "group" : "private", id };
}

function messageText(decision, message, preparedText) {
  const text = preparedText || decision.promptText || decision.text;
  if (decision.target?.kind === "group") {
    const name = message.sender?.card || message.sender?.nickname || message.user_id || "unknown";
    return `${name}: ${text}`;
  }
  return text;
}

async function prepareInboundPromptText(config, decision, message, target) {
  const client = currentClient ?? new OneBotClient(config, logger);
  const preparedParts = await prepareInboundMediaParts(
    decision.parts,
    config,
    logger,
    async (file, part) => {
      if (typeof client.getImage !== "function") return undefined;
      const response = await client.getImage(file);
      if (!response || !isOkResponse(response)) {
        throw new Error(response?.message ?? response?.wording ?? `retcode ${response?.retcode ?? "unknown"}`);
      }
      return response?.data ?? { file: part.file };
    },
    async (part) => resolveOneBotInboundFile(client, target, part),
  );
  logPreparedInboundMedia(preparedParts, target);
  return partsToText(preparedParts, { includeMedia: true }) || decision.promptText || decision.text;
}

async function resolveOneBotInboundFile(client, target, part) {
  const fileId = part.fileId ?? part.file;
  if (!fileId) return undefined;

  if (part.fileId) {
    const urlResponse =
      target.kind === "group" && typeof client.getGroupFileUrl === "function"
        ? await client.getGroupFileUrl(target.id, part.fileId)
        : target.kind === "private" && typeof client.getPrivateFileUrl === "function"
          ? await client.getPrivateFileUrl(part.fileId)
          : undefined;
    if (urlResponse && isOkResponse(urlResponse) && urlResponse.data) return urlResponse.data;
  }

  if (typeof client.getFile !== "function") return undefined;
  const response = await client.getFile(fileId, target.kind);
  if (!response || !isOkResponse(response)) {
    throw new Error(response?.message ?? response?.wording ?? `retcode ${response?.retcode ?? "unknown"}`);
  }
  return response?.data ?? { file: part.file, file_id: part.fileId };
}

function logPreparedInboundMedia(parts, target) {
  for (const part of parts) {
    if (part?.kind !== "image" && part?.kind !== "file") continue;
    const name = part.filename || part.file || part.fileId || "file";
    if (part.downloadStatus === "saved") {
      logger.info(`inbound ${part.kind} saved ${target.kind}:${target.id} file=${name} path=${part.localPath} size=${part.size ?? "unknown"}`);
    } else if (part.downloadStatus === "failed") {
      logger.warn(`inbound ${part.kind} failed ${target.kind}:${target.id} file=${name} reason=${part.downloadError || "unknown"}`);
    } else {
      logger.debug(`inbound ${part.kind} skipped ${target.kind}:${target.id} file=${name} reason=${part.downloadError || part.downloadStatus || "unknown"}`);
    }
  }
}

function hasMediaWithoutText(item) {
  return Boolean(item.decision?.hasMedia && !String(item.decision?.text || "").trim());
}

function hasVisibleText(item) {
  return Boolean(String(item.decision?.text || "").trim());
}

function inboundBatchDelay(buffer) {
  const age = Date.now() - buffer.firstAt;
  if (age >= INBOUND_MAX_BATCH_MS) return 0;
  const hasBareMedia = buffer.items.some(hasMediaWithoutText);
  const hasText = buffer.items.some(hasVisibleText);
  if (hasBareMedia && !hasText) return Math.max(0, Math.min(INBOUND_MEDIA_GRACE_MS, INBOUND_MAX_BATCH_MS - age));
  return Math.max(0, Math.min(INBOUND_TEXT_DEBOUNCE_MS, INBOUND_MAX_BATCH_MS - age));
}

function queueInboundForDispatch(config, sessionKey, target, item) {
  let buffer = inboundBuffers.get(sessionKey);
  if (!buffer) {
    buffer = { config, sessionKey, target, firstAt: Date.now(), items: [], timer: null };
    inboundBuffers.set(sessionKey, buffer);
  }
  buffer.config = config;
  buffer.target = target;
  buffer.items.push(item);
  if (buffer.timer) clearTimeout(buffer.timer);
  const delay = inboundBatchDelay(buffer);
  logger.debug(`queued inbound ${sessionKey} items=${buffer.items.length} delay_ms=${delay}`);
  buffer.timer = setTimeout(() => {
    void flushInboundBuffer(sessionKey).catch((error) => {
      logger.error(`flush inbound failed for ${sessionKey}: ${error.stack || error.message || String(error)}`);
    });
  }, delay);
}

async function flushInboundBuffer(sessionKey) {
  const buffer = inboundBuffers.get(sessionKey);
  if (!buffer) return;
  inboundBuffers.delete(sessionKey);
  if (buffer.timer) clearTimeout(buffer.timer);
  const text = buffer.items
    .map((item) => messageText(item.decision, item.message, item.preparedText))
    .filter((item) => item && item.trim())
    .join("\n")
    .trim();
  if (!text) return;
  await enqueueSession(sessionKey, async () => {
    const beforeFile = getSessionFile(sessionKey);
    const beforeCursor = beforeFile ? fileSize(beforeFile) : 0;
    const startedAt = Date.now();
    logger.info(`dispatch ${sessionKey} target=${buffer.target.kind}:${buffer.target.id} messages=${buffer.items.length}`);
    const result = await dispatchToOpenClaw(sessionKey, text);
    logger.info(`sessions.send ${sessionKey} run=${result?.runId ?? "unknown"}`);
    await waitAndForwardAssistant(buffer.config, buffer.target, sessionKey, beforeFile, beforeCursor, startedAt, result?.runId);
  });
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
    {
      sendFile: (captured, file) => sendOneBotFileToCapturedTarget(currentClient ?? new OneBotClient(config, logger), config, captured, file, logger),
    },
  );
  await sender.deliver(entry.message, { kind: "final" });
  await sender.finish();
}

async function sendAssistantText(config, target, text) {
  const sender = new ReplyChunkSender(
    config,
    target,
    (captured, outgoing) => sendOneBotMessageToCapturedTarget(currentClient ?? new OneBotClient(config, logger), config, captured, outgoing, logger),
    logger,
    {
      sendFile: (captured, file) => sendOneBotFileToCapturedTarget(currentClient ?? new OneBotClient(config, logger), config, captured, file, logger),
    },
  );
  await sender.deliver(text, { kind: "final" });
  await sender.finish();
}

async function forwardPendingFinalDelivery(config, target, sessionKey, startedAt, label) {
  const pendingFinal = getPendingFinalDelivery(sessionKey, startedAt);
  if (!pendingFinal) return false;
  const deliveredIds = deliveredAssistantIds(sessionKey);
  if (deliveredIds.has(pendingFinal.id)) return true;
  deliveredIds.add(pendingFinal.id);
  try {
    await sendAssistantText(config, target, pendingFinal.text);
  } catch (error) {
    deliveredIds.delete(pendingFinal.id);
    throw error;
  }
  logger.info(`forwarded pending final delivery to ${target.kind}:${target.id}${label ? ` ${label}` : ""}`);
  return true;
}

async function waitAndForwardPendingFinalDelivery(config, target, sessionKey, startedAt, label) {
  const deadline = Date.now() + PENDING_FINAL_WAIT_MS;
  do {
    if (await forwardPendingFinalDelivery(config, target, sessionKey, startedAt, label)) return true;
    await sleep(250);
  } while (Date.now() < deadline);
  return false;
}

function hasVisibleAssistantPayload(message) {
  if (!message || typeof message !== "object") return false;
  if (typeof message.text === "string" && message.text.trim()) return true;
  if (typeof message.content === "string" && message.content.trim()) return true;
  if (message.mediaUrl || message.mediaUrls || message.imageUrl || message.image_url || message.file || message.path || message.filePath || message.fileUrl || message.url) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    if (!item || typeof item !== "object") return false;
    if (item.type === "text") return typeof item.text === "string" && item.text.trim().length > 0;
    return ["image", "image_url", "inputImage", "input_image", "output_image", "file", "attachment", "output_file"].includes(item.type);
  });
}

function entryShowsRunProgress(entry, startedAt) {
  if (!entry || typeof entry !== "object") return false;
  const ts = Date.parse(entry.timestamp || "");
  if (Number.isFinite(ts) && ts + 1000 < startedAt) return false;
  if (entry.type !== "message") return false;
  const role = entry.message?.role;
  return role === "assistant" || role === "toolResult" || role === "toolresult" || role === "tool";
}

function trajectoryEntryShowsRunProgress(entry, runId, startedAt) {
  if (!entry || typeof entry !== "object") return false;
  if (runId && entry.runId && entry.runId !== runId) return false;
  const ts = Date.parse(entry.ts || entry.timestamp || "");
  if (Number.isFinite(ts) && ts + 1000 < startedAt) return false;
  const type = typeof entry.type === "string" ? entry.type : "";
  return type.startsWith("tool.") || type.startsWith("model.") || type === "session.ended" || type === "session.error";
}

function trajectoryEntryDetectedYield(entry, startedAt) {
  if (!entry || typeof entry !== "object") return false;
  const ts = Date.parse(entry.ts || entry.timestamp || "");
  if (Number.isFinite(ts) && ts + 1000 < startedAt) return false;
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type !== "model.completed" && type !== "session.ended") return false;
  return Boolean(entry.data?.yieldDetected);
}

function entryStableId(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.id === "string" && entry.id) return entry.id;
  const role = entry.message?.role || "";
  const content = typeof entry.message?.content === "string" ? entry.message.content : JSON.stringify(entry.message?.content ?? "");
  return entry.seq != null
    ? `${entry.ts || entry.timestamp || ""}:${entry.type || role}:${entry.seq}`
    : `${entry.timestamp || ""}:${role}:${content.slice(0, 160)}`;
}

async function waitAndForwardAssistant(config, target, sessionKey, sessionFile, initialCursor, startedAt, runId) {
  let cursor = initialCursor;
  let file = sessionFile;
  let trajectoryFile = trajectoryFileForSessionFile(file);
  let trajectoryCursor = 0;
  const deliveredIds = deliveredAssistantIds(sessionKey);
  const progressIds = new Set();
  let sentAny = false;
  let lastSentAt = 0;
  let lastProgressAt = startedAt;
  let lastCatchupScanAt = 0;
  let yieldDetected = false;
  const maxDeadline = startedAt + ASSISTANT_MAX_WAIT_MS;

  const processEntries = async (entries, source) => {
    for (const entry of entries) {
      const stableId = entryStableId(entry);
      if (entryShowsRunProgress(entry, startedAt) && !progressIds.has(stableId)) {
        progressIds.add(stableId);
        lastProgressAt = Date.now();
      }
      if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
      if (deliveredIds.has(stableId)) continue;
      const ts = Date.parse(entry.timestamp || "");
      if (Number.isFinite(ts) && ts + 1000 < startedAt) continue;
      if (!hasVisibleAssistantPayload(entry.message)) continue;
      deliveredIds.add(stableId);
      try {
        await sendAssistantEntry(config, target, entry);
      } catch (error) {
        deliveredIds.delete(stableId);
        throw error;
      }
      sentAny = true;
      lastSentAt = Date.now();
      logger.info(`forwarded assistant message ${entry.id ?? stableId} to ${target.kind}:${target.id}${source ? ` via ${source}` : ""}`);
    }
  };

  while (Date.now() < maxDeadline) {
    const mappedFile = getSessionFile(sessionKey);
    if (mappedFile && mappedFile !== file) {
      logger.info(`session file switched for ${sessionKey}: ${file || "none"} -> ${mappedFile}`);
      file = mappedFile;
      cursor = 0;
      trajectoryFile = trajectoryFileForSessionFile(file);
      trajectoryCursor = 0;
    }
    const result = readNewEntries(file, cursor);
    cursor = result.cursor;
    await processEntries(result.entries, "incremental");

    if (trajectoryFile) {
      const trajectoryResult = readNewEntries(trajectoryFile, trajectoryCursor);
      trajectoryCursor = trajectoryResult.cursor;
      for (const entry of trajectoryResult.entries) {
        const stableId = entryStableId(entry);
        if (!yieldDetected && trajectoryEntryDetectedYield(entry, startedAt)) {
          yieldDetected = true;
          logger.info(`yield detected for ${sessionKey}; waiting up to max deadline for follow-up completion`);
        }
        if (trajectoryEntryShowsRunProgress(entry, runId, startedAt) && !progressIds.has(stableId)) {
          progressIds.add(stableId);
          lastProgressAt = Date.now();
          logger.debug(`run progress ${sessionKey} via trajectory ${entry.type || "event"}`);
        }
      }
    }

    if (!sentAny && file && Date.now() - lastCatchupScanAt >= ASSISTANT_CATCHUP_SCAN_MS) {
      lastCatchupScanAt = Date.now();
      await processEntries(readAllEntries(file), "catchup");
      if (await forwardPendingFinalDelivery(config, target, sessionKey, startedAt, "via catchup")) {
        sentAny = true;
        lastSentAt = Date.now();
      }
    }

    if (sentAny && Date.now() - lastSentAt >= ASSISTANT_SETTLE_MS) return true;
    if (!yieldDetected && Date.now() - lastProgressAt >= ASSISTANT_IDLE_TIMEOUT_MS) break;
    await sleep(750);
  }
  if (!sentAny) {
    if (file) await processEntries(readAllEntries(file), "final-catchup");
    if (sentAny) return true;
    if (await forwardPendingFinalDelivery(config, target, sessionKey, startedAt, "before timeout abort")) return true;
  }
  if (!sentAny && runId && !yieldDetected) {
    const waitedMs = Date.now() - startedAt;
    const idleMs = Date.now() - lastProgressAt;
    logger.warn(`assistant timeout for ${sessionKey}; aborting run=${runId} waited_ms=${waitedMs} idle_ms=${idleMs}`);
    try {
      await abortOpenClawRun(sessionKey, runId);
      logger.warn(`aborted timed out run=${runId} for ${sessionKey}`);
    } catch (error) {
      logger.warn(`abort timed out run failed for ${sessionKey}: ${error.message || String(error)}`);
    }
    if (await waitAndForwardPendingFinalDelivery(config, target, sessionKey, startedAt, "after timeout abort")) return true;
  } else {
    logger.warn(`assistant timeout for ${sessionKey}${yieldDetected ? " after yielded wait" : ""}`);
    if (!sentAny && await waitAndForwardPendingFinalDelivery(config, target, sessionKey, startedAt, "after timeout")) return true;
  }
  return sentAny;
}

async function catchUpOrphanedOneBotSessions(config) {
  const sessions = readJson(SESSIONS_PATH, {});
  const minTimestamp = PROCESS_STARTED_AT - 5000;
  for (const [sessionKey, meta] of Object.entries(sessions)) {
    if (!sessionKey.includes(":onebot:")) continue;
    if (sessionQueues.has(sessionKey)) continue;
    const target = targetFromSessionKey(sessionKey);
    if (!target) continue;
    const updatedAt = Number(meta?.updatedAt ?? meta?.endedAt ?? 0);
    if (Number.isFinite(updatedAt) && updatedAt && updatedAt + ORPHAN_CATCHUP_WINDOW_MS < PROCESS_STARTED_AT) continue;
    const file = typeof meta?.sessionFile === "string" ? meta.sessionFile : "";
    if (!file) continue;
    const deliveredIds = deliveredAssistantIds(sessionKey);
    const entries = readAllEntries(file);
    for (const entry of entries) {
      if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
      const stableId = entryStableId(entry);
      if (deliveredIds.has(stableId)) continue;
      const ts = Date.parse(entry.timestamp || "");
      if (!Number.isFinite(ts) || ts + 1000 < minTimestamp) continue;
      if (!hasVisibleAssistantPayload(entry.message)) continue;
      deliveredIds.add(stableId);
      try {
        await sendAssistantEntry(config, target, entry);
        logger.info(`orphan catchup forwarded assistant message ${entry.id ?? stableId} to ${target.kind}:${target.id}`);
      } catch (error) {
        deliveredIds.delete(stableId);
        logger.error(`orphan catchup failed for ${sessionKey}: ${error.stack || error.message || String(error)}`);
      }
    }
    const pendingCreatedAt = Number(meta?.pendingFinalDeliveryCreatedAt ?? 0);
    if (Number.isFinite(pendingCreatedAt) && pendingCreatedAt + 1000 >= minTimestamp) {
      await forwardPendingFinalDelivery(config, target, sessionKey, minTimestamp, "via orphan catchup").catch((error) => {
        logger.error(`orphan pending final failed for ${sessionKey}: ${error.stack || error.message || String(error)}`);
      });
    }
  }
}

function startOrphanCatchup(config) {
  if (orphanCatchupTimer) clearInterval(orphanCatchupTimer);
  orphanCatchupTimer = setInterval(() => {
    void catchUpOrphanedOneBotSessions(config).catch((error) => {
      logger.error(`orphan catchup scan failed: ${error.stack || error.message || String(error)}`);
    });
  }, ORPHAN_CATCHUP_SCAN_MS);
  void catchUpOrphanedOneBotSessions(config).catch((error) => {
    logger.error(`orphan catchup startup failed: ${error.stack || error.message || String(error)}`);
  });
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
  const preparedText = await prepareInboundPromptText(config, decision, message, target);
  queueInboundForDispatch(config, sessionKey, target, { decision, message, preparedText });
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
    startOrphanCatchup(config);
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
  if (orphanCatchupTimer) clearInterval(orphanCatchupTimer);
  for (const buffer of inboundBuffers.values()) {
    if (buffer.timer) clearTimeout(buffer.timer);
  }
  inboundBuffers.clear();
  void currentClient?.stop?.().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (orphanCatchupTimer) clearInterval(orphanCatchupTimer);
  for (const buffer of inboundBuffers.values()) {
    if (buffer.timer) clearTimeout(buffer.timer);
  }
  inboundBuffers.clear();
  void currentClient?.stop?.().finally(() => process.exit(0));
});

await connectOneBot();
setInterval(() => undefined, 1 << 30);
