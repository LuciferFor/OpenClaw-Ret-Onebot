import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { register } from "../src/index.js";
import { MessageDeduper } from "../src/onebot-client.js";
import { processInboundMessage } from "../src/inbound.js";
import type { OneBotClient } from "../src/onebot-client.js";
import type { OneBotHookConfig, OneBotMessageEvent, OpenClawPluginApi } from "../src/types.js";

function config(): OneBotHookConfig {
  return {
    enabled: true,
    accountId: "default",
    ws: { mode: "forward", url: "ws://127.0.0.1:3001" },
    trigger: { private: "all", group: "mention_or_keyword", keywords: ["openclaw"], stripMention: true },
    allowFrom: [],
    denyFrom: [],
    reply: { mode: "chunked", flushIntervalMs: 1200, flushChars: 160, markdownToPlain: true, maxRetries: 3 },
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
    expect(existsSync(resolve(process.cwd(), "skills"))).toBe(false);
  });
});

