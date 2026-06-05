import { describe, expect, it, vi } from "vitest";
import { ReplyChunkSender, sendTextToCapturedTarget } from "../src/outbound.js";
import type { CapturedReplyTarget, OneBotHookConfig } from "../src/types.js";
import type { OneBotClient } from "../src/onebot-client.js";

function config(overrides: Partial<OneBotHookConfig["reply"]> = {}): OneBotHookConfig {
  return {
    enabled: true,
    accountId: "default",
    ws: { mode: "forward", url: "ws://127.0.0.1:3001" },
    trigger: { private: "all", group: "mention_or_keyword", keywords: [], stripMention: true },
    allowFrom: [],
    denyFrom: [],
    reply: {
      mode: "chunked",
      flushIntervalMs: 1200,
      flushChars: 160,
      markdownToPlain: true,
      maxRetries: 3,
      ...overrides,
    },
  };
}

describe("ReplyChunkSender", () => {
  it("flushes residual text on final", async () => {
    const sends: string[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, text) => {
        sends.push(text);
        return `m${sends.length}`;
      }
    );

    await sender.deliver("hello", { kind: "partial" });
    expect(sends).toEqual([]);
    await sender.deliver(" world", { kind: "final" });
    expect(sends).toEqual(["hello world"]);
  });

  it("flushes by timer when no final arrives", async () => {
    vi.useFakeTimers();
    const sends: string[] = [];
    const sender = new ReplyChunkSender(
      config({ flushIntervalMs: 1000 }),
      { kind: "group", id: 90001 },
      async (_target, text) => {
        sends.push(text);
        return "m1";
      }
    );

    await sender.deliver("buffered reply", { kind: "partial" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sends).toEqual(["buffered reply"]);
    vi.useRealTimers();
  });

  it("strips simple markdown before sending", async () => {
    const sends: string[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, text) => {
        sends.push(text);
        return "m1";
      }
    );

    await sender.deliver("**bold** and `code`", { kind: "final" });
    expect(sends).toEqual(["bold and code"]);
  });
});

describe("sendTextToCapturedTarget", () => {
  it("retries failed OneBot sends and returns the message id", async () => {
    const target: CapturedReplyTarget = { kind: "private", id: 10001 };
    const sendPrivateMsg = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", retcode: 100, wording: "bad gateway" })
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: { message_id: 77 } });
    const client = { sendPrivateMsg } as unknown as OneBotClient;

    const messageId = await sendTextToCapturedTarget(client, config({ maxRetries: 2 }), target, "hello");
    expect(messageId).toBe("77");
    expect(sendPrivateMsg).toHaveBeenCalledTimes(2);
    expect(sendPrivateMsg).toHaveBeenCalledWith(10001, "hello");
  });

  it("uses group send for captured group targets", async () => {
    const sendGroupMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 88 } });
    const client = { sendGroupMsg } as unknown as OneBotClient;

    const messageId = await sendTextToCapturedTarget(client, config(), { kind: "group", id: 90001 }, "hello group");
    expect(messageId).toBe("88");
    expect(sendGroupMsg).toHaveBeenCalledWith(90001, "hello group");
  });
});

