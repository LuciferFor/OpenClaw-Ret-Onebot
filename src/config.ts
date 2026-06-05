import type { OneBotHookConfig, OneBotMediaConfig, OneBotReplyConfig, OneBotTriggerConfig, OneBotWsConfig } from "./types.js";

const DEFAULT_WS_PATH = "/onebot/v11/ws";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeWsConfig(raw: any): OneBotWsConfig {
  const mode = raw?.mode === "reverse" ? "reverse" : "forward";
  return {
    mode,
    url: asString(raw?.url),
    listenHost: asString(raw?.listenHost) ?? "127.0.0.1",
    listenPort: asNumber(raw?.listenPort, 3002, 1, 65535),
    path: asString(raw?.path) ?? DEFAULT_WS_PATH,
  };
}

function normalizeTriggerConfig(raw: any): OneBotTriggerConfig {
  return {
    private: "all",
    group: "mention_or_keyword",
    keywords: asStringArray(raw?.keywords),
    stripMention: raw?.stripMention === undefined ? true : Boolean(raw.stripMention),
  };
}

function normalizeReplyConfig(raw: any): OneBotReplyConfig {
  return {
    mode: "chunked",
    flushIntervalMs: asNumber(raw?.flushIntervalMs, 1200, 100, 10000),
    flushChars: asNumber(raw?.flushChars, 160, 20, 4000),
    markdownToPlain: raw?.markdownToPlain === undefined ? true : Boolean(raw.markdownToPlain),
    maxRetries: asNumber(raw?.maxRetries, 3, 1, 10),
  };
}

function normalizeMediaConfig(raw: any): OneBotMediaConfig {
  return {
    enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
    downloadInboundImages: raw?.downloadInboundImages === undefined ? true : Boolean(raw.downloadInboundImages),
    cacheDir: asString(raw?.cacheDir) ?? "~/.openclaw/media/onebot",
    maxImageBytes: asNumber(raw?.maxImageBytes, 15_000_000, 1, 100_000_000),
    downloadTimeoutMs: asNumber(raw?.downloadTimeoutMs, 10_000, 100, 60_000),
    retainHours: asNumber(raw?.retainHours, 24, 1, 24 * 30),
    outboundMode: "segments",
    markdownImages: raw?.markdownImages === undefined ? true : Boolean(raw.markdownImages),
    maxImagesPerReply: asNumber(raw?.maxImagesPerReply, 6, 0, 50),
  };
}

export function getOneBotHookConfig(apiOrConfig: any, accountId = "default"): OneBotHookConfig | null {
  const root = apiOrConfig?.config ?? apiOrConfig ?? {};
  const channel = root?.channels?.onebot;
  if (!channel) return null;

  const account = channel?.accounts?.[accountId];
  const raw = account ? { ...channel, ...account } : channel;

  return {
    enabled: raw.enabled !== false,
    accountId,
    ws: normalizeWsConfig(raw.ws ?? raw),
    httpUrl: asString(raw.httpUrl),
    accessToken: asString(raw.accessToken),
    trigger: normalizeTriggerConfig(raw.trigger),
    allowFrom: asStringArray(raw.allowFrom).map(normalizePeerRef),
    denyFrom: asStringArray(raw.denyFrom).map(normalizePeerRef),
    reply: normalizeReplyConfig(raw.reply),
    media: normalizeMediaConfig(raw.media),
  };
}

export function listAccountIds(apiOrConfig: any): string[] {
  const root = apiOrConfig?.config ?? apiOrConfig ?? {};
  const accounts = root?.channels?.onebot?.accounts;
  if (accounts && typeof accounts === "object") {
    return Object.keys(accounts);
  }
  return root?.channels?.onebot ? ["default"] : [];
}

export function normalizePeerRef(value: string): string {
  return value.replace(/^(onebot|qq|lagrange):/i, "").trim().toLowerCase();
}

export function peerRefsForMessage(userId: number | undefined, groupId: number | undefined): string[] {
  const refs: string[] = [];
  if (userId != null) refs.push(`user:${userId}`);
  if (groupId != null) refs.push(`group:${groupId}`);
  return refs;
}

export function isAllowedByPeerLists(config: OneBotHookConfig, userId: number | undefined, groupId: number | undefined): boolean {
  const refs = peerRefsForMessage(userId, groupId).map(normalizePeerRef);
  if (refs.some((ref) => config.denyFrom.includes(ref))) return false;
  if (config.allowFrom.length === 0) return true;
  return refs.some((ref) => config.allowFrom.includes(ref));
}
