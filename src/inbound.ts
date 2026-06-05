import { isAllowedByPeerLists } from "./config.js";
import { OneBotClient } from "./onebot-client.js";
import { ReplyChunkSender, sendTextToCapturedTarget } from "./outbound.js";
import type {
  CapturedReplyTarget,
  LoggerLike,
  OneBotHookConfig,
  OneBotMessageEvent,
  OneBotMessageSegment,
  OpenClawPluginApi,
} from "./types.js";

export interface InboundDecision {
  forward: boolean;
  reason: string;
  text: string;
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

  if (userId == null) return { forward: false, reason: "missing-user-id", text: "" };
  if (selfId != null && userId === selfId) return { forward: false, reason: "self-message", text: "" };
  if (!isAllowedByPeerLists(config, userId, groupId)) return { forward: false, reason: "peer-filtered", text: "" };

  const isGroup = message.message_type === "group";
  const target: CapturedReplyTarget | undefined = isGroup && groupId != null
    ? { kind: "group", id: groupId }
    : { kind: "private", id: userId };
  if (!target) return { forward: false, reason: "missing-target", text: "" };

  const mentioned = isMentioned(message, selfId);
  const text = extractMessageText(message, {
    stripMention: config.trigger.stripMention,
    selfId,
  }).trim();
  if (!text) return { forward: false, reason: "empty-text", text: "" };

  if (!isGroup) return { forward: true, reason: "private", text, target };

  const keywordMatched = config.trigger.keywords.some((keyword) => keyword && text.toLowerCase().includes(keyword.toLowerCase()));
  if (!mentioned && !keywordMatched) {
    return { forward: false, reason: "group-not-triggered", text, target };
  }

  return { forward: true, reason: mentioned ? "group-mentioned" : "group-keyword", text, target };
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

  const body = runtime?.channel?.reply?.formatInboundEnvelope?.({
    channel: "OneBot",
    from: senderLabel,
    timestamp: Date.now(),
    body: decision.text,
    chatType,
    sender: { name: senderLabel, id: String(message.user_id) },
  }) ?? { content: [{ type: "text", text: decision.text }] };

  const ctxPayload = {
    Body: body,
    RawBody: decision.text,
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
    },
  };

  await recordInboundSessionIfAvailable(api, sessionKey, ctxPayload, config, target, logger);

  const chunkSender = new ReplyChunkSender(
    config,
    target,
    (captured, text) => sendTextToCapturedTarget(client, config, captured, text, logger),
    logger
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
  if (Array.isArray(message.message)) {
    return message.message
      .map((segment) => textFromSegment(segment, opts))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  const raw = typeof message.message === "string" ? message.message : (message.raw_message ?? "");
  if (!opts.stripMention || opts.selfId == null) return raw.trim();
  const escaped = String(opts.selfId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return raw.replace(new RegExp(`\\[CQ:at,qq=${escaped}\\]\\s*`, "g"), "").trim();
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

function textFromSegment(segment: OneBotMessageSegment, opts: { stripMention: boolean; selfId?: number | null }): string {
  if (segment.type === "text") {
    return typeof segment.data?.text === "string" ? segment.data.text : "";
  }
  if (segment.type === "at") {
    const qq = segment.data?.qq;
    if (opts.stripMention && opts.selfId != null && String(qq) === String(opts.selfId)) return "";
    return `@${String(qq ?? "")}`;
  }
  return "";
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
