import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyChunkSender, sendOneBotMessageToCapturedTarget, sendTextToCapturedTarget } from "../src/outbound.js";
import type { CapturedReplyTarget, OneBotHookConfig, OneBotOutgoingMessage } from "../src/types.js";
import type { OneBotClient } from "../src/onebot-client.js";

const tempDirs: string[] = [];

function config(overrides: Partial<OneBotHookConfig["reply"]> = {}, fileOverrides: Partial<OneBotHookConfig["files"]> = {}): OneBotHookConfig {
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
    files: {
      enabled: true,
      maxFileBytes: 4_294_967_296,
      detectTextPaths: true,
      downloadInboundFiles: true,
      incomingDir: join(tmpdir(), "onebot-incoming-files"),
      downloadTimeoutMs: 30_000,
      allowedRoots: [tmpdir()],
      pathMappings: [],
      fallbackOnFailure: "text",
      ...fileOverrides,
    },
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempFile(name: string, content = "data"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "onebot-file-test-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
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

  it("sends qqmedia image tags as ordered OneBot segments", async () => {
    const file = await makeTempFile("generated.png", "png");
    const sends: OneBotOutgoingMessage[] = [];
    const uploads: string[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      },
      {},
      {
        sendFile: async (_target, part) => {
          uploads.push(part.file);
          return "f1";
        },
      }
    );

    await sender.deliver(`出了：\n\n<qqmedia>${file}</qqmedia>`, { kind: "final" });

    expect(uploads).toEqual([]);
    expect(sends).toEqual([
      [
        { type: "text", data: { text: "出了：" } },
        { type: "image", data: { file: "base64://cG5n" } },
      ],
    ]);
  });

  it("does not leak qqmedia tags as literal text", async () => {
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      }
    );

    await sender.deliver("<qqmedia>https://example.test/a.png</qqmedia>", { kind: "final" });

    expect(sends).toEqual([
      [{ type: "image", data: { file: "https://example.test/a.png" } }],
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

  it("drops NO_REPLY without sending a fallback", async () => {
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

  it("uploads structured file payloads after flushing text", async () => {
    const file = await makeTempFile("bundle.zip", "zip");
    const sends: OneBotOutgoingMessage[] = [];
    const uploads: Array<{ target: CapturedReplyTarget; file: string; name: string }> = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      },
      {},
      {
        sendFile: async (target, part) => {
          uploads.push({ target, file: part.file, name: part.name });
          return "f1";
        },
      }
    );

    await sender.deliver({ content: [{ type: "text", text: "打包好了" }, { type: "file", path: file, name: "skills.zip" }] }, { kind: "final" });

    expect(sends).toEqual(["打包好了"]);
    expect(uploads).toEqual([{ target: { kind: "private", id: 10001 }, file, name: "skills.zip" }]);
  });

  it("detects local file paths in assistant text and uploads them once", async () => {
    const file = await makeTempFile("imagegen-skills.zip", "zip");
    const uploads: string[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async () => "m1",
      {},
      {
        sendFile: async (_target, part) => {
          uploads.push(part.file);
          return "f1";
        },
      }
    );

    await sender.deliver(`文件在这里：\n${file}\n再说一次 ${file}`, { kind: "final" });

    expect(uploads).toEqual([file]);
  });

  it("maps host file paths to container-visible upload paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "onebot-file-test-"));
    tempDirs.push(root);
    const hostRoot = join(root, "host-workspace");
    const containerRoot = join(root, "container-workspace");
    const containerOut = join(containerRoot, "out");
    mkdirSync(containerOut, { recursive: true });
    const mappedFile = join(containerOut, "bundle.zip");
    await writeFile(mappedFile, "zip");
    const hostPath = join(hostRoot, "out", "bundle.zip");
    const uploads: string[] = [];
    const sender = new ReplyChunkSender(
      config(
        {},
        {
          allowedRoots: [containerRoot],
          pathMappings: [{ from: hostRoot, to: containerRoot }],
        }
      ),
      { kind: "private", id: 10001 },
      async () => "m1",
      {},
      {
        sendFile: async (_target, part) => {
          uploads.push(part.file);
          return "f1";
        },
      }
    );

    await sender.deliver({ type: "file", path: hostPath }, { kind: "final" });

    expect(uploads).toEqual([mappedFile]);
  });

  it("ignores text paths outside allowed roots, directories, and missing files", async () => {
    const allowedDir = await mkdtemp(join(tmpdir(), "onebot-file-test-"));
    tempDirs.push(allowedDir);
    const dirPath = join(allowedDir, "folder");
    mkdirSync(dirPath);
    const missing = join(allowedDir, "missing.zip");
    const outside = join(process.cwd(), "not-allowed.zip");
    const uploads: string[] = [];
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config({}, { allowedRoots: [allowedDir] }),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      },
      {},
      {
        sendFile: async (_target, part) => {
          uploads.push(part.file);
          return "f1";
        },
      }
    );

    await sender.deliver(`这些不要发：\n${dirPath}\n${missing}\n${outside}`, { kind: "final" });

    expect(uploads).toEqual([]);
    expect(sends).toEqual([`这些不要发：\n${dirPath}\n${missing}\n${outside}`]);
  });

  it("falls back to text when a local file exceeds maxFileBytes", async () => {
    const file = await makeTempFile("too-large.zip", "x");
    await truncate(file, 4);
    const sends: OneBotOutgoingMessage[] = [];
    const uploads: string[] = [];
    const sender = new ReplyChunkSender(
      config({}, { maxFileBytes: 3 }),
      { kind: "group", id: 90001 },
      async (_target, message) => {
        sends.push(message);
        return `m${sends.length}`;
      },
      {},
      {
        sendFile: async (_target, part) => {
          uploads.push(part.file);
          return "f1";
        },
      }
    );

    await sender.deliver({ type: "file", path: file, name: "too-large.zip" }, { kind: "final" });

    expect(uploads).toEqual([]);
    expect(String(sends[0])).toContain("文件上传失败：too-large.zip");
    expect(String(sends[0])).toContain("file exceeds maxFileBytes");
  });

  it("falls back to text when file upload fails", async () => {
    const file = await makeTempFile("fail.zip", "zip");
    const sends: OneBotOutgoingMessage[] = [];
    const sender = new ReplyChunkSender(
      config(),
      { kind: "private", id: 10001 },
      async (_target, message) => {
        sends.push(message);
        return "m1";
      },
      {},
      {
        sendFile: async () => {
          throw new Error("NapCat refused upload");
        },
      }
    );

    await sender.deliver({ type: "file", path: file }, { kind: "final" });

    expect(String(sends[0])).toContain("文件上传失败：fail.zip");
    expect(String(sends[0])).toContain("NapCat refused upload");
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

  it("retries and uploads files to private targets", async () => {
    const target: CapturedReplyTarget = { kind: "private", id: 10001 };
    const uploadPrivateFile = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", retcode: 100, wording: "bad gateway" })
      .mockResolvedValueOnce({ status: "ok", retcode: 0, data: { file_id: "file-1" } });
    const client = { uploadPrivateFile } as unknown as OneBotClient;
    const { sendOneBotFileToCapturedTarget } = await import("../src/outbound.js");

    const messageId = await sendOneBotFileToCapturedTarget(client, config({ maxRetries: 2 }), target, {
      kind: "file",
      file: "/tmp/a.zip",
      name: "a.zip",
      original: "/tmp/a.zip",
      size: 3,
    });

    expect(messageId).toBe("file-1");
    expect(uploadPrivateFile).toHaveBeenCalledTimes(2);
    expect(uploadPrivateFile).toHaveBeenCalledWith(10001, "/tmp/a.zip", "a.zip");
  });

  it("uploads files to group targets", async () => {
    const uploadGroupFile = vi.fn().mockResolvedValue({ status: "ok", retcode: 0, data: { file_id: "group-file" } });
    const client = { uploadGroupFile } as unknown as OneBotClient;
    const { sendOneBotFileToCapturedTarget } = await import("../src/outbound.js");

    const messageId = await sendOneBotFileToCapturedTarget(client, config(), { kind: "group", id: 90001 }, {
      kind: "file",
      file: "/tmp/a.zip",
      name: "a.zip",
      original: "/tmp/a.zip",
    });

    expect(messageId).toBe("group-file");
    expect(uploadGroupFile).toHaveBeenCalledWith(90001, "/tmp/a.zip", "a.zip");
  });
});
