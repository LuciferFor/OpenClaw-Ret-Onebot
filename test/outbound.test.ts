import { describe, expect, it, vi } from "vitest";
import { ReplyChunkSender, sendOneBotMessageToCapturedTarget, sendTextToCapturedTarget } from "../src/outbound.js";
import type { CapturedReplyTarget, OneBotHookConfig, OneBotOutgoingMessage } from "../src/types.js";
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

  it("sends markdown images as ordered OneBot segments", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      }
    );

    await sender.deliver("hello ![pic](https://example.test/a.png) world", { kind: "final" });

    expect(sends).toEqual([
      [
        { type: "text", data: { text: "hello" } },
        { type: "image", data: { file: "https://example.test/a.png", summary: "pic" } },
        { type: "text", data: { text: "world" } },
      ],
    ]);
  });

  it("sends mediaUrl payloads as mixed text and image segments", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      }
    );

    await sender.deliver({ text: "caption", mediaUrls: ["https://example.test/a.png", "https://example.test/b.png"] }, { kind: "final" });

    expect(sends).toEqual([
      [
        { type: "text", data: { text: "caption" } },
        { type: "image", data: { file: "https://example.test/a.png" } },
        { type: "image", data: { file: "https://example.test/b.png" } },
      ],
    ]);
  });

  it("sends tool result inputImage contentItems as OneBot image segments", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      }
    );

    await sender.deliverToolResult({
      contentItems: [
        { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
      ],
    });

    expect(sends).toEqual([
      [{ type: "image", data: { file: "base64://iVBORw0KGgo=" } }],
    ]);
  });

  it("extracts nested tool result images and ignores text-only tool logs", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      }
    );

    await sender.deliver("destiny2_card_query completed", { kind: "tool-result" });
    await sender.deliver(
      {
        type: "tool_result",
        contentItems: [
          { type: "text", text: "completed" },
          { type: "output_image", image_url: { url: "https://example.test/card.png" } },
        ],
      },
      { kind: "tool" }
    );

    expect(sends).toEqual([
      [{ type: "image", data: { file: "https://example.test/card.png" } }],
    ]);
  });

  it("deduplicates images across tool and final replies", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      }
    );

    await sender.deliverToolResult({ contentItems: [{ type: "inputImage", imageUrl: "https://example.test/card.png" }] });
    await sender.deliver({ text: "查好了", mediaUrl: "https://example.test/card.png" }, { kind: "final" });

    expect(sends).toEqual([
      [{ type: "image", data: { file: "https://example.test/card.png" } }],
      "查好了",
    ]);
  });

  it("suppresses final chatter after strict tool image output", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      },
      {},
      { suppressFinalTextAfterToolResult: true }
    );

    await sender.deliverToolResult({ contentItems: [{ type: "inputImage", imageUrl: "https://example.test/d2.png" }] });
    await sender.deliver("查好了，主人。", { kind: "final" });

    expect(sends).toEqual([
      [{ type: "image", data: { file: "https://example.test/d2.png" } }],
    ]);
  });

  it("forwards strict tool result links and suppresses final chatter", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      },
      {},
      { suppressFinalTextAfterToolResult: true, forwardToolResultLinks: true }
    );

    await sender.deliverToolResult({
      contentItems: [{ type: "text", text: "请打开 https://www.luciferfore.com/d2/share/abc 查看结果" }],
    });
    await sender.deliver("我已经给你整理好了。", { kind: "final" });

    expect(sends).toEqual(["请打开 https://www.luciferfore.com/d2/share/abc 查看结果"]);
  });

  it("suppresses final chatter when strict tool results contain no sendable output", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      },
      {},
      { suppressFinalTextAfterToolResult: true, forwardToolResultLinks: true }
    );

    await sender.deliverToolResult("destiny2_card_query completed");
    await sender.deliver("查好了，主人。", { kind: "final" });
    await sender.finish();

    expect(sends).toEqual([]);
  });

  it("only forwards final links after empty strict tool results", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      },
      {},
      { suppressFinalTextAfterToolResult: true, forwardToolResultLinks: true }
    );

    await sender.deliverToolResult("destiny2_card_query completed");
    await sender.deliver("查好了，网页在 https://www.luciferfore.com/d2/share/def", { kind: "final" });

    expect(sends).toEqual(["https://www.luciferfore.com/d2/share/def"]);
  });

  it("can send a configured fallback when the model returns NO_REPLY", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      },
      {},
      { noReplyFallback: "嗯？" }
    );

    await sender.deliver("NO_REPLY", { kind: "final" });
    await sender.finish();

    expect(sends).toEqual(["嗯？"]);
  });

  it("does not send a fallback for NO_REPLY unless one is configured", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      }
    );

    await sender.deliver("NO_REPLY", { kind: "final" });
    await sender.finish();

    expect(sends).toEqual([]);
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

  it("retries and sends image segment arrays", async () => {
    const target: CapturedReplyTarget = { kind: "private", id: 10001 };
    const message: OneBotOutgoingMessage = [{ type: "image", data: { file: "https://example.test/a.png" } }];
    const sendPrivateMsg = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", retcode: 100, wording: "bad gateway" })
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: { message_id: 99 } });
    const client = { sendPrivateMsg } as unknown as OneBotClient;

    const messageId = await sendOneBotMessageToCapturedTarget(client, config({ maxRetries: 2 }), target, message);

    expect(messageId).toBe("99");
    expect(sendPrivateMsg).toHaveBeenCalledTimes(2);
    expect(sendPrivateMsg).toHaveBeenCalledWith(10001, message);
  });
});
