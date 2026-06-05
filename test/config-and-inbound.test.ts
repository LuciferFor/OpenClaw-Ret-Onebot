import { describe, expect, it } from "vitest";
import { decideInbound, buildSessionKey, extractMessageText, isMentioned } from "../src/inbound.js";
import { extractInboundParts, partsToText } from "../src/media.js";
import type { OneBotHookConfig, OneBotMessageEvent } from "../src/types.js";

function config(overrides: Partial<OneBotHookConfig> = {}): OneBotHookConfig {
  return {
    enabled: true,
    accountId: "default",
    ws: { mode: "forward", url: "ws://127.0.0.1:3001" },
    trigger: {
      private: "all",
      group: "mention_or_keyword",
      keywords: ["openclaw"],
      stripMention: true,
    },
    allowFrom: [],
    denyFrom: [],
    reply: {
      mode: "chunked",
      flushIntervalMs: 1200,
      flushChars: 160,
      markdownToPlain: true,
      maxRetries: 3,
    },
    media: {
      enabled: true,
      downloadInboundImages: true,
      cacheDir: "~/.openclaw/media/onebot",
      maxImageBytes: 15_000_000,
      downloadTimeoutMs: 10_000,
      retainHours: 24,
      outboundMode: "segments",
      markdownImages: true,
      maxImagesPerReply: 6,
    },
    ...overrides,
  };
}

describe("inbound decisions", () => {
  it("forwards all private text messages by default", () => {
    const message: OneBotMessageEvent = {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      raw_message: "hello",
    };

    const decision = decideInbound(config(), message);
    expect(decision.forward).toBe(true);
    expect(decision.target).toEqual({ kind: "private", id: 10001 });
    expect(decision.text).toBe("hello");
  });

  it("ignores self messages", () => {
    const decision = decideInbound(config(), {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 42,
      raw_message: "loop",
    });
    expect(decision.forward).toBe(false);
    expect(decision.reason).toBe("self-message");
  });

  it("requires mention or keyword in groups", () => {
    const base: OneBotMessageEvent = {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      raw_message: "just chatting",
    };

    expect(decideInbound(config(), base).forward).toBe(false);
    expect(decideInbound(config(), { ...base, raw_message: "openclaw ping" }).forward).toBe(true);
    expect(decideInbound(config(), { ...base, raw_message: "[CQ:at,qq=42] ping" }).forward).toBe(true);
  });

  it("forwards group mention-only pings after stripping the self mention", () => {
    const decision = decideInbound(config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [{ type: "at", data: { qq: 42 } }],
      raw_message: "[CQ:at,qq=42]",
    });

    expect(decision.forward).toBe(true);
    expect(decision.reason).toBe("group-mentioned");
    expect(decision.text).toBe("对方在群里直接 @ 了你，没有附加文字。请简短回应对方。");
    expect(decision.promptText).toBe("对方在群里直接 @ 了你，没有附加文字。请简短回应对方。");
    expect(decision.parts).toEqual([{ kind: "text", text: "对方在群里直接 @ 了你，没有附加文字。请简短回应对方。" }]);
  });

  it("forwards pure image private messages", () => {
    const decision = decideInbound(config(), {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [{ type: "image", data: { file: "pic.jpg", url: "https://example.test/pic.jpg" } }],
    });

    expect(decision.forward).toBe(true);
    expect(decision.hasMedia).toBe(true);
    expect(decision.text).toBe("");
    expect(decision.promptText).toContain("[image: pic.jpg]");
  });

  it("requires mention or keyword for group image messages", () => {
    const base: OneBotMessageEvent = {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [{ type: "image", data: { file: "pic.jpg" } }],
    };

    expect(decideInbound(config(), base).forward).toBe(false);
    expect(decideInbound(config(), { ...base, message: [{ type: "at", data: { qq: 42 } }, ...(base.message as any[])] }).forward).toBe(true);
    expect(decideInbound(config(), { ...base, message: [{ type: "text", data: { text: "openclaw " } }, ...(base.message as any[])] }).forward).toBe(true);
  });

  it("strips self mention from text when configured", () => {
    const message: OneBotMessageEvent = {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [
        { type: "at", data: { qq: 42 } },
        { type: "text", data: { text: " ping" } },
      ],
    };

    expect(isMentioned(message, 42)).toBe(true);
    expect(extractMessageText(message, { stripMention: true, selfId: 42 })).toBe("ping");
  });

  it("keeps text and image segment order in prompt text", () => {
    const parts = extractInboundParts({
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [
        { type: "text", data: { text: "before " } },
        { type: "image", data: { file: "middle.png" } },
        { type: "text", data: { text: " after" } },
      ],
    });

    expect(partsToText(parts, { includeMedia: true })).toBe("before\n[image: middle.png]\nafter");
  });

  it("applies allow and deny peer filters to users and groups", () => {
    const message: OneBotMessageEvent = {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      raw_message: "[CQ:at,qq=42] ping",
    };

    expect(decideInbound(config({ allowFrom: ["group:90001"], denyFrom: [] }), message).forward).toBe(true);
    expect(decideInbound(config({ allowFrom: ["group:1"], denyFrom: [] }), message).forward).toBe(false);
    expect(decideInbound(config({ allowFrom: [], denyFrom: ["user:10001"] }), message).forward).toBe(false);
  });

  it("builds stable OpenClaw session keys", () => {
    expect(buildSessionKey("main", { kind: "private", id: 10001 })).toBe("agent:main:onebot:direct:10001");
    expect(buildSessionKey("ops", { kind: "group", id: 90001 })).toBe("agent:ops:onebot:group:90001");
  });
});
