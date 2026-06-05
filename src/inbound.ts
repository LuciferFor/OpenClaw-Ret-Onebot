import { createRequire } from "node:module";
import { isAllowedByPeerLists } from "./config.js";
import {
  buildAgentMediaPayloadFromParts,
  buildOpenClawContent,
  extractInboundParts,
  partsHaveMedia,
  partsToText,
  prepareInboundMediaParts,
  summarizeMediaParts,
} from "./media.js";
import { isOkResponse, OneBotClient } from "./onebot-client.js";
import { ReplyChunkSender, sendOneBotMessageToCapturedTarget, type ReplyChunkSenderOptions } from "./outbound.js";
import type {
  CapturedReplyTarget,
  InboundMessagePart,
  LoggerLike,
  OneBotHookConfig,
  OneBotMessageEvent,
  OpenClawPluginApi,
} from "./types.js";

const MENTION_ONLY_PROMPT = "对方在群里直接 @ 了你，没有附加文字。请简短回应对方。";
const MENTION_ONLY_FALLBACK_REPLY = "嗯？";
const GROUP_TRIGGERED_FALLBACK_REPLY = "在。";

const D2_DIRECT_BRIDGE_PATH = process.env.ONEBOT_D2_DIRECT_BRIDGE || "/home/node/.openclaw/workspace/tools/onebot/bridge-onebot-openclaw.js";
const require = createRequire(import.meta.url);

interface D2DirectBridge {
  buildD2DirectInvocation?: (event: OneBotMessageEvent, text: string) => unknown;
  executeD2DirectInvocation?: (event: OneBotMessageEvent, invocation: unknown, options?: Record<string, unknown>) => Promise<boolean>;
  handleD2DirectRequest?: (event: OneBotMessageEvent, text: string) => Promise<boolean>;
  isD2DirectReplayRequest?: (text: string) => boolean;
}

let d2DirectBridge: D2DirectBridge | null | undefined;
const D2_DIRECT_HINT_WORDS = [
  "命运2", "destiny", "d2", "bungie", "棒鸡", "战绩", "地牢", "突袭", "raid", "dungeon",
  "宗师", "日落", "夜幕", "gm", "热力图", "活跃", "锻造", "图纸", "催化", "仓库", "库存", "背包",
  "装备", "身上", "当前装备", "配装", "套装", "三百", "凑", "生命值", "近战", "手雷", "超能", "职业", "武器", "纪律", "韧性", "恢复", "智慧", "机动", "力量", "pvp", "熔炉", "试炼", "单局", "pgcr",
  "冲锋枪", "微冲", "smg", "手炮", "hc", "hand cannon", "rpm", "射速", "喷子", "霰弹", "自动步枪", "脉冲", "斥候", "狙击",
  "融合", "线融", "榴弹", "火箭", "筒子", "机枪", "剑", "弓", "手枪",
  "发出来", "没发图", "没图", "图呢", "图片呢", "再发一次", "重发",
];

export interface InboundDecision {
  forward: boolean;
  reason: string;
  text: string;
  promptText: string;
  hasMedia: boolean;
  parts: InboundMessagePart[];
  target?: CapturedReplyTarget;
}

export function buildSessionKey(agentId: string, target: CapturedReplyTarget): string {
  const kind = target.kind === "group" ? "group" : "direct";
  return `agent:${agentId}:onebot:${kind}:${target.id}`;
}

export function decideInbound(config: OneBotHookConfig, message: OneBotMessageEvent): InboundDecision {
  const selfId = numberValue(message.self_id);
  const userId = numberValue(message.user_id);
  const groupId = numberValue(message.group_id);

  const emptyParts: InboundMessagePart[] = [];
  if (userId == null) return { forward: false, reason: "missing-user-id", text: "", promptText: "", hasMedia: false, parts: emptyParts };
  if (selfId != null && userId === selfId) return { forward: false, reason: "self-message", text: "", promptText: "", hasMedia: false, parts: emptyParts };
  if (!isAllowedByPeerLists(config, userId, groupId)) {
    return { forward: false, reason: "peer-filtered", text: "", promptText: "", hasMedia: false, parts: emptyParts };
  }

  const isGroup = message.message_type === "group";
  const target: CapturedReplyTarget | undefined = isGroup && groupId != null
    ? { kind: "group", id: groupId }
    : { kind: "private", id: userId };
  if (!target) return { forward: false, reason: "missing-target", text: "", promptText: "", hasMedia: false, parts: emptyParts };

  const mentioned = isMentioned(message, selfId);
  let parts = extractInboundParts(message, {
    stripMention: config.trigger.stripMention,
    selfId,
  });
  let text = partsToText(parts, { includeMedia: false }).trim();
  let promptText = partsToText(parts, { includeMedia: true }).trim();
  let hasMedia = partsHaveMedia(parts);
  if (isGroup && mentioned && !text && !hasMedia) {
    parts = [{ kind: "text", text: MENTION_ONLY_PROMPT }];
    text = MENTION_ONLY_PROMPT;
    promptText = MENTION_ONLY_PROMPT;
    hasMedia = false;
  }
  if (!text && !hasMedia) return { forward: false, reason: "empty-text", text: "", promptText: "", hasMedia: false, parts };

  if (!isGroup) return { forward: true, reason: "private", text, promptText, hasMedia, parts, target };

  const keywordMatched = config.trigger.keywords.some((keyword) => keyword && text.toLowerCase().includes(keyword.toLowerCase()));
  if (!mentioned && !keywordMatched) {
    return { forward: false, reason: "group-not-triggered", text, promptText, hasMedia, parts, target };
  }

  return { forward: true, reason: mentioned ? "group-mentioned" : "group-keyword", text, promptText, hasMedia, parts, target };
}

export async function processInboundMessage(
  api: OpenClawPluginApi,
  client: OneBotClient,
  config: OneBotHookConfig,
  message: OneBotMessageEvent
): Promise<boolean> {
  const logger = api.logger ?? {};
  const decision = decideInbound(config, message);
  if (!decision.forward || !decision.target) {
    logger.debug?.(`[onebot-hook] inbound ignored: ${decision.reason}`);
    return false;
  }

  if (await processD2DirectIfMatched(client, config, message, decision, logger)) {
    return true;
  }

  const runtime = api.runtime;
  const dispatcher =
    runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher ??
    runtime?.channel?.inbound?.dispatchReplyWithBufferedBlockDispatcher;
  if (typeof dispatcher !== "function") {
    logger.warn?.("[onebot-hook] OpenClaw reply dispatcher is unavailable");
    return false;
  }

  const target = decision.target;
  const agentId = resolveAgentId(api, config, target);
  const sessionKey = buildSessionKey(agentId, target);
  const senderLabel = formatSenderLabel(message);
  const chatType = target.kind === "group" ? "group" : "direct";
  const replyTo = target.kind === "group" ? `group:${target.id}` : `user:${target.id}`;
  const preparedParts = await prepareInboundMediaParts(decision.parts, config, logger, async (file, part) => {
    if (typeof (client as any).getImage !== "function") return undefined;
    const response = await (client as any).getImage(file);
    if (!response || !isOkResponse(response)) {
      throw new Error(response?.message ?? response?.wording ?? `retcode ${response?.retcode ?? "unknown"}`);
    }
    return response?.data ?? { file: part.file };
  });
  const content = buildOpenClawContent(preparedParts);
  const mediaPayload = buildAgentMediaPayloadFromParts(preparedParts);
  const promptText = partsToText(preparedParts, { includeMedia: true }) || decision.promptText || decision.text;

  const formattedBody = runtime?.channel?.reply?.formatInboundEnvelope?.({
    channel: "OneBot",
    from: senderLabel,
    timestamp: Date.now(),
    body: promptText,
    content,
    mediaParts: summarizeMediaParts(preparedParts),
    chatType,
    sender: { name: senderLabel, id: String(message.user_id) },
  });
  const body = mergeInboundBody(formattedBody, content);

  const baseCtxPayload = {
    Body: body,
    BodyForAgent: promptText,
    CommandBody: decision.text,
    BodyForCommands: decision.text,
    RawBody: promptText,
    From: target.kind === "group" ? `onebot:group:${target.id}` : `onebot:user:${target.id}`,
    To: `onebot:${replyTo}`,
    SessionKey: sessionKey,
    AccountId: config.accountId,
    ChatType: chatType,
    ConversationLabel: `onebot:${replyTo}`,
    SenderName: senderLabel,
    SenderId: String(message.user_id),
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: message.message_id == null ? `onebot-${Date.now()}` : `onebot-${message.message_id}`,
    Timestamp: Date.now(),
    OriginatingChannel: "onebot",
    OriginatingTo: `onebot:${replyTo}`,
    CommandAuthorized: true,
    DeliveryContext: {
      channel: "onebot",
      to: replyTo,
      accountId: config.accountId,
      capturedTarget: target,
    },
    _onebot: {
      capturedTarget: target,
      userId: message.user_id,
      groupId: message.group_id,
      selfId: message.self_id,
      parts: preparedParts,
      mediaParts: summarizeMediaParts(preparedParts),
    },
    ...mediaPayload,
  };
  const ctxPayload = finalizeInboundContextIfAvailable(runtime, baseCtxPayload, logger);

  await recordInboundSessionIfAvailable(api, sessionKey, ctxPayload, config, target, logger);

  const replyOptions = noReplyFallbackOptions(decision, target);
  if (maybeD2DirectText(decision.text)) {
    replyOptions.suppressFinalTextAfterToolResult = true;
    replyOptions.forwardToolResultLinks = true;
  }

  const chunkSender = new ReplyChunkSender(
    config,
    target,
    (captured, message) => sendOneBotMessageToCapturedTarget(client, config, captured, message, logger),
    logger,
    replyOptions
  );

  try {
    await dispatcher.call(runtime?.channel?.reply ?? runtime?.channel?.inbound, {
      ctx: ctxPayload,
      cfg: api.config,
      dispatcherOptions: {
        deliver: async (payload: unknown, info: { kind?: string }) => {
          await chunkSender.deliver(payload, info);
        },
        onError: async (error: unknown, info: { kind?: string }) => {
          logger.error?.(`[onebot-hook] ${info?.kind ?? "reply"} failed: ${error instanceof Error ? error.message : String(error)}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: false,
        sourceReplyDeliveryMode: "automatic",
        verboseLevel: "on",
        shouldEmitToolResult: () => true,
        shouldEmitToolOutput: () => false,
        onToolResult: async (payload: unknown) => {
          await chunkSender.deliverToolResult(payload);
        },
      },
    });
    return true;
  } catch (error) {
    logger.error?.(`[onebot-hook] dispatch failed for ${replyTo}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    await chunkSender.finish().catch((error) => {
      logger.error?.(`[onebot-hook] final reply flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

export function extractMessageText(
  message: OneBotMessageEvent,
  opts: { stripMention: boolean; selfId?: number | null } = { stripMention: true }
): string {
  return partsToText(extractInboundParts(message, opts), { includeMedia: false });
}

async function processD2DirectIfMatched(
  client: OneBotClient,
  config: OneBotHookConfig,
  message: OneBotMessageEvent,
  decision: InboundDecision,
  logger: LoggerLike
): Promise<boolean> {
  const text = decision.text.trim();
  if (!text || decision.hasMedia || !decision.target) return false;
  if (!maybeD2DirectText(text)) return false;

  const bridge = loadD2DirectBridge(logger);
  if (!bridge) {
    await sendOneBotMessageToCapturedTarget(client, config, decision.target, "命运2查询失败：D2 直通组件不可用，请检查 bridge 部署。", logger);
    return true;
  }

  const event: OneBotMessageEvent = {
    ...message,
    raw_message: text,
    message: text,
  };

  const invocation = bridge.buildD2DirectInvocation?.(event, text);
  const replay = invocation ? false : Boolean(bridge.isD2DirectReplayRequest?.(text));
  if (!invocation && !replay) {
    await sendOneBotMessageToCapturedTarget(client, config, decision.target, "没有生成图片：这条命运2查询没有识别到可执行的卡片类型。", logger);
    return true;
  }

  try {
    logger.info?.(`[onebot-hook] d2-direct-start ${decision.target.kind}:${decision.target.id} user:${message.user_id ?? ""} ${invocation ? "fresh" : "replay"}`);
    const handled = invocation && bridge.executeD2DirectInvocation
      ? await bridge.executeD2DirectInvocation(event, invocation, { replay: false })
      : await bridge.handleD2DirectRequest?.(event, text);
    if (!handled) {
      await sendOneBotMessageToCapturedTarget(client, config, decision.target, "没有生成图片：命运2直通查询没有返回可发送内容。", logger);
    }
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger.error?.(`[onebot-hook] d2-direct failed: ${messageText}`);
    await sendOneBotMessageToCapturedTarget(client, config, decision.target, `命运2查询失败：${messageText}`, logger).catch((sendError) => {
      logger.error?.(`[onebot-hook] d2-direct error reply failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    });
    return true;
  }
}

function maybeD2DirectText(text: string): boolean {
  const value = text.toLowerCase();
  return D2_DIRECT_HINT_WORDS.some((word) => value.includes(word.toLowerCase()));
}

function loadD2DirectBridge(logger: LoggerLike): D2DirectBridge | null {
  if (d2DirectBridge !== undefined) return d2DirectBridge;
  try {
    const loaded = require(D2_DIRECT_BRIDGE_PATH) as D2DirectBridge;
    d2DirectBridge = loaded && typeof loaded === "object" ? loaded : null;
  } catch (error) {
    d2DirectBridge = null;
    logger.warn?.(`[onebot-hook] d2-direct bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return d2DirectBridge;
}

export function isMentioned(message: OneBotMessageEvent, selfId?: number | null): boolean {
  if (selfId == null) return false;
  if (Array.isArray(message.message)) {
    return message.message.some((segment) => {
      if (segment.type !== "at") return false;
      const qq = segment.data?.qq;
      return String(qq) === String(selfId);
    });
  }
  const raw = message.raw_message ?? (typeof message.message === "string" ? message.message : "");
  return raw.includes(`[CQ:at,qq=${selfId}]`);
}

function resolveAgentId(api: OpenClawPluginApi, config: OneBotHookConfig, target: CapturedReplyTarget): string {
  const runtime = api.runtime;
  const peer = target.kind === "group"
    ? { kind: "group", id: String(target.id) }
    : { kind: "direct", id: String(target.id) };
  const route = runtime?.channel?.routing?.resolveAgentRoute?.({
    cfg: api.config,
    sessionKey: `onebot:${target.kind}:${target.id}`,
    channel: "onebot",
    accountId: config.accountId,
    peer,
  });
  return typeof route?.agentId === "string" && route.agentId.trim() ? route.agentId : "main";
}

function noReplyFallbackOptions(decision: InboundDecision, target: CapturedReplyTarget): ReplyChunkSenderOptions {
  if (target.kind !== "group") return {};
  if (decision.reason === "group-mentioned" && decision.text === MENTION_ONLY_PROMPT) {
    return { noReplyFallback: MENTION_ONLY_FALLBACK_REPLY, alwaysFallbackOnEmpty: true };
  }
  if (decision.reason === "group-mentioned" || decision.reason === "group-keyword") {
    return { noReplyFallback: GROUP_TRIGGERED_FALLBACK_REPLY, alwaysFallbackOnEmpty: true };
  }
  return {};
}

function mergeInboundBody(formattedBody: unknown, content: Record<string, unknown>[]): Record<string, unknown> {
  if (formattedBody && typeof formattedBody === "object" && !Array.isArray(formattedBody)) {
    return { ...(formattedBody as Record<string, unknown>), content };
  }
  return { content };
}

function finalizeInboundContextIfAvailable(runtime: any, ctxPayload: Record<string, unknown>, logger: LoggerLike): Record<string, unknown> {
  const finalize = runtime?.channel?.reply?.finalizeInboundContext ?? runtime?.channel?.inbound?.finalizeInboundContext;
  if (typeof finalize !== "function") return ctxPayload;
  try {
    const finalized = finalize(ctxPayload);
    if (finalized && typeof finalized === "object" && !Array.isArray(finalized)) {
      return finalized as Record<string, unknown>;
    }
  } catch (error) {
    logger.warn?.(`[onebot-hook] finalizeInboundContext failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ctxPayload;
}

async function recordInboundSessionIfAvailable(
  api: OpenClawPluginApi,
  sessionKey: string,
  ctxPayload: Record<string, unknown>,
  config: OneBotHookConfig,
  target: CapturedReplyTarget,
  logger: LoggerLike
): Promise<void> {
  const session = api.runtime?.channel?.session;
  if (typeof session?.recordInboundSession !== "function") return;
  const storePath = session.resolveStorePath?.(api.config?.session?.store, { agentId: sessionKey.split(":")[1] }) ?? "";
  await session.recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    updateLastRoute: target.kind === "private"
      ? { sessionKey, channel: "onebot", to: `user:${target.id}`, accountId: config.accountId }
      : undefined,
    onRecordError: (error: unknown) => logger.warn?.(`[onebot-hook] recordInboundSession: ${String(error)}`),
  });
}

function formatSenderLabel(message: OneBotMessageEvent): string {
  const card = message.sender?.card?.trim();
  const nickname = message.sender?.nickname?.trim();
  const name = card || nickname || String(message.user_id ?? "unknown");
  return `${name}(qq: ${message.user_id ?? "unknown"})`;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
