import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "../src/index.js";
import { MessageDeduper } from "../src/onebot-client.js";
import { processInboundMessage } from "../src/inbound.js";
import type { OneBotClient } from "../src/onebot-client.js";
import type { OneBotHookConfig, OneBotMessageEvent, OpenClawPluginApi } from "../src/types.js";

const tempDirs: string[] = [];

function config(mediaOverrides: Partial<OneBotHookConfig["media"]> = {}): OneBotHookConfig {
  return {
    enabled: true,
    accountId: "default",
    ws: { mode: "forward", url: "ws://127.0.0.1:3001" },
    trigger: { private: "all", group: "mention_or_keyword", keywords: ["openclaw"], stripMention: true },
    allowFrom: [],
    denyFrom: [],
    reply: { mode: "chunked", flushIntervalMs: 1200, flushChars: 160, markdownToPlain: true, maxRetries: 3 },
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
      ...mediaOverrides,
    },
  };
}

function api(dispatcher: any): OpenClawPluginApi {
  return {
    config: { channels: { onebot: config() } },
    logger: {},
    runtime: {
      channel: {
        routing: { resolveAgentRoute: () => ({ agentId: "main" }) },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatcher,
          formatInboundEnvelope: ({ body }: { body: string }) => ({ content: [{ type: "text", text: body }] }),
        },
      },
    },
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("MessageDeduper", () => {
  it("deduplicates repeated message ids within the TTL", () => {
    const deduper = new MessageDeduper(1000);
    const message: OneBotMessageEvent = {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message_id: 1,
      raw_message: "hello",
    };

    expect(deduper.isDuplicate(message, 0)).toBe(false);
    expect(deduper.isDuplicate(message, 500)).toBe(true);
    expect(deduper.isDuplicate(message, 1501)).toBe(false);
  });
});

describe("processInboundMessage integration", () => {
  it("dispatches private inbound messages and sends replies to the captured private target", async () => {
    const sendPrivateMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 1 } });
    const client = { sendPrivateMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver("private reply", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      raw_message: "hello",
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendPrivateMsg).toHaveBeenCalledWith(10001, "private reply");
  });

  it("dispatches mentioned group messages and sends replies to the captured group target", async () => {
    const sendGroupMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 2 } });
    const client = { sendGroupMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver("group reply", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      raw_message: "[CQ:at,qq=42] hello",
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendGroupMsg).toHaveBeenCalledWith(90001, "group reply");
  });

  it("dispatches group mention-only pings and sends replies to the captured group target", async () => {
    const sendGroupMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 6 } });
    const client = { sendGroupMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ ctx, dispatcherOptions }) => {
      expect(ctx.RawBody).toBe("对方在群里直接 @ 了你，没有附加文字。请简短回应对方。");
      expect(ctx.BodyForAgent).toBe("对方在群里直接 @ 了你，没有附加文字。请简短回应对方。");
      await dispatcherOptions.deliver("mention reply", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [{ type: "at", data: { qq: 42 } }],
      raw_message: "[CQ:at,qq=42]",
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendGroupMsg).toHaveBeenCalledWith(90001, "mention reply");
  });

  it("sends a fallback reply when a group mention-only ping gets NO_REPLY", async () => {
    const sendGroupMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 7 } });
    const client = { sendGroupMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver("NO_REPLY", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [{ type: "at", data: { qq: 42 } }],
      raw_message: "[CQ:at,qq=42]",
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendGroupMsg).toHaveBeenCalledWith(90001, "嗯？");
  });

  it("passes inbound image blocks to OpenClaw and sends mixed private replies as OneBot segments", async () => {
    const sendPrivateMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 3 } });
    const client = { sendPrivateMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ ctx, dispatcherOptions }) => {
      expect(ctx.RawBody).toContain("[image: pic.jpg]");
      expect(ctx.Body.content).toEqual([
        { type: "text", text: "look" },
        expect.objectContaining({ type: "image", url: "pic.jpg" }),
      ]);
      expect(ctx._onebot.mediaParts).toEqual([expect.objectContaining({ kind: "image", file: "pic.jpg" })]);
      await dispatcherOptions.deliver({ content: [{ type: "text", text: "reply" }, { type: "image", url: "https://example.test/reply.png" }] }, { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [
        { type: "text", data: { text: "look" } },
        { type: "image", data: { file: "pic.jpg" } },
      ],
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendPrivateMsg).toHaveBeenCalledWith(10001, [
      { type: "text", data: { text: "reply" } },
      { type: "image", data: { file: "https://example.test/reply.png" } },
    ]);
  });

  it("passes cached inbound image paths through OpenClaw media payload fields", async () => {
    const cacheDir = await makeTempDir();
    const sendPrivateMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 5 } });
    const client = { sendPrivateMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ ctx, dispatcherOptions }) => {
      expect(ctx.BodyForAgent).toContain("[image: pic.png]");
      expect(ctx.RawBody).toContain("[image: pic.png]");
      expect(ctx.MediaPath).toEqual(expect.stringContaining(cacheDir));
      expect(ctx.MediaUrl).toBe(ctx.MediaPath);
      expect(ctx.MediaPaths).toEqual([ctx.MediaPath]);
      expect(ctx.MediaUrls).toEqual([ctx.MediaPath]);
      expect(ctx.MediaType).toBe("image/png");
      expect(ctx.Body.content).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^file:\/\//) }),
      ]);
      await dispatcherOptions.deliver("saw it", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config({ cacheDir }), {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [{ type: "image", data: { file: "pic.png", url: "base64://iVBORw0KGgo=" } }],
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendPrivateMsg).toHaveBeenCalledWith(10001, "saw it");
  });

  it("dispatches mentioned group image messages and sends image replies to the captured group target", async () => {
    const sendGroupMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 4 } });
    const client = { sendGroupMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "https://example.test/group.png" }, { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [
        { type: "at", data: { qq: 42 } },
        { type: "image", data: { file: "group.jpg" } },
      ],
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendGroupMsg).toHaveBeenCalledWith(90001, [{ type: "image", data: { file: "https://example.test/group.png" } }]);
  });

  it("sends tool result images to the captured group target while preserving the final text reply", async () => {
    const sendGroupMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 8 } });
    const client = { sendGroupMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ dispatcherOptions, replyOptions }) => {
      expect(replyOptions.verboseLevel).toBe("on");
      expect(replyOptions.shouldEmitToolResult()).toBe(true);
      expect(replyOptions.shouldEmitToolOutput()).toBe(false);
      await replyOptions.onToolResult({
        contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }],
      });
      await dispatcherOptions.deliver("小家伙，查好了。", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [
        { type: "at", data: { qq: 42 } },
        { type: "text", data: { text: "查下我的天气" } },
      ],
    });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(sendGroupMsg).toHaveBeenNthCalledWith(1, 90001, [{ type: "image", data: { file: "base64://iVBORw0KGgo=" } }]);
    expect(sendGroupMsg).toHaveBeenNthCalledWith(2, 90001, "小家伙，查好了。");
  });

  it("does not forward text-only tool results to a captured private target", async () => {
    const sendPrivateMsg = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { message_id: 9 } });
    const client = { sendPrivateMsg } as unknown as OneBotClient;
    const dispatcher = vi.fn(async ({ replyOptions, dispatcherOptions }) => {
      await replyOptions.onToolResult("destiny2_card_query completed");
      await dispatcherOptions.deliver("final reply", { kind: "final" });
    });

    await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      raw_message: "查下我的天气",
    });

    expect(sendPrivateMsg).toHaveBeenCalledTimes(1);
    expect(sendPrivateMsg).toHaveBeenCalledWith(10001, "final reply");
  });

  it("does not dispatch untriggered group messages", async () => {
    const client = {} as OneBotClient;
    const dispatcher = vi.fn();

    const handled = await processInboundMessage(api(dispatcher), client, config(), {
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      raw_message: "ordinary chat",
    });

    expect(handled).toBe(false);
    expect(dispatcher).not.toHaveBeenCalled();
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "onebot-hook-service-"));
  tempDirs.push(dir);
  return dir;
}

describe("plugin contract", () => {
  it("registers only channel and service, never agent tools", () => {
    const registerChannel = vi.fn();
    const registerService = vi.fn();
    const registerTool = vi.fn(() => {
      throw new Error("registerTool must not be called");
    });

    register({
      config: {},
      logger: {},
      runtime: {},
      registerChannel,
      registerService,
      registerTool: registerTool as never,
    });

    expect(registerChannel).toHaveBeenCalledTimes(1);
    expect(registerService).toHaveBeenCalledTimes(1);
    expect(registerTool).not.toHaveBeenCalled();
    expect((registerChannel.mock.calls[0][0].plugin as any).capabilities.media).toBe(true);
    expect((registerChannel.mock.calls[0][0].plugin as any).outbound.sendMedia).toEqual(expect.any(Function));
    expect(existsSync(resolve(process.cwd(), "skills"))).toBe(false);
  });
});
