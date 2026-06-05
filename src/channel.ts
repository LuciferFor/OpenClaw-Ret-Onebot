import { getOneBotHookConfig, listAccountIds } from "./config.js";
import { sendTextToCapturedTarget } from "./outbound.js";
import { OneBotClient } from "./onebot-client.js";

function parseTarget(to: string): { kind: "private" | "group"; id: number } | null {
  const normalized = to.replace(/^(onebot|qq|lagrange):/i, "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("group:")) {
    const id = Number(normalized.slice("group:".length));
    return Number.isFinite(id) ? { kind: "group", id } : null;
  }
  const userRaw = normalized.startsWith("user:") ? normalized.slice("user:".length) : normalized;
  const id = Number(userRaw);
  return Number.isFinite(id) ? { kind: "private", id } : null;
}

export const OneBotHookChannelPlugin = {
  id: "onebot",
  meta: {
    id: "onebot",
    label: "OneBot",
    selectionLabel: "OneBot Hook",
    docsPath: "/channels/onebot-hook",
    blurb: "Reliable OneBot v11 hook channel",
    aliases: ["qq", "napcat", "lagrange", "cqhttp"],
  },
  capabilities: {
    chatTypes: ["direct", "group"] as const,
    media: false,
    reactions: false,
    threads: false,
    polls: false,
  },
  reload: { configPrefixes: ["channels.onebot"] as const },
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string) => ({ accountId: accountId ?? "default", ...cfg?.channels?.onebot }),
  },
  messaging: {
    normalizeTarget: (raw: string) => raw?.replace(/^(onebot|qq|lagrange):/i, "").trim(),
    targetResolver: {
      looksLikeId: (raw: string) => /^(onebot:)?(user:|group:)?\d+$/i.test(raw.trim()),
      hint: "user:<QQ> or group:<GROUP>",
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    chunkerMode: "text" as const,
    textChunkLimit: 4000,
    resolveTarget: ({ to }: { to?: string }) => {
      if (!to?.trim()) return { ok: false, error: new Error("OneBot requires a target") };
      return { ok: true, to: to.trim() };
    },
    sendText: async ({ to, text, accountId, cfg }: { to: string; text: string; accountId?: string; cfg?: any }) => {
      const target = parseTarget(to);
      if (!target) return { channel: "onebot", ok: false, messageId: "", error: new Error(`Invalid target: ${to}`) };
      const config = getOneBotHookConfig(cfg ?? (globalThis as any).__onebotHookApi, accountId);
      if (!config) return { channel: "onebot", ok: false, messageId: "", error: new Error("OneBot is not configured") };
      const client = new OneBotClient(config);
      try {
        const messageId = await sendTextToCapturedTarget(client, config, target, text);
        return { channel: "onebot", ok: true, messageId };
      } catch (error) {
        return { channel: "onebot", ok: false, messageId: "", error: error instanceof Error ? error : new Error(String(error)) };
      } finally {
        await client.stop().catch(() => undefined);
      }
    },
  },
};

