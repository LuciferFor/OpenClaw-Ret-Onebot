import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentMediaPayloadFromParts, extractInboundParts, prepareInboundMediaParts } from "../src/media.js";
import type { InboundMediaPart, OneBotHookConfig } from "../src/types.js";

const tempDirs: string[] = [];

function config(cacheDir: string, overrides: Partial<OneBotHookConfig["media"]> = {}): OneBotHookConfig {
  return {
    enabled: true,
    accountId: "default",
    ws: { mode: "forward", url: "ws://127.0.0.1:3001" },
    trigger: { private: "all", group: "mention_or_keyword", keywords: [], stripMention: true },
    allowFrom: [],
    denyFrom: [],
    reply: { mode: "chunked", flushIntervalMs: 1200, flushChars: 160, markdownToPlain: true, maxRetries: 3 },
    media: {
      enabled: true,
      downloadInboundImages: true,
      cacheDir,
      maxImageBytes: 15_000_000,
      downloadTimeoutMs: 10_000,
      retainHours: 24,
      outboundMode: "segments",
      markdownImages: true,
      maxImagesPerReply: 6,
      ...overrides,
    },
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("inbound media preparation", () => {
  it("builds OpenClaw media payloads from cached local image paths", () => {
    const payload = buildAgentMediaPayloadFromParts([
      {
        kind: "image",
        segmentType: "image",
        data: {},
        file: "pic.png",
        localPath: "/tmp/openclaw/pic.png",
        mime: "image/png",
      },
    ]);

    expect(payload).toEqual({
      MediaPath: "/tmp/openclaw/pic.png",
      MediaUrl: "/tmp/openclaw/pic.png",
      MediaPaths: ["/tmp/openclaw/pic.png"],
      MediaUrls: ["/tmp/openclaw/pic.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });

  it("does not expose bare OneBot file names as model-readable media paths", () => {
    const payload = buildAgentMediaPayloadFromParts([
      {
        kind: "image",
        segmentType: "image",
        data: {},
        file: "pic.png",
        source: "pic.png",
      },
    ]);

    expect(payload).toEqual({});
  });

  it("downloads inbound image URLs into the configured cache", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
      res.end(bytes);
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${address.port}/pic.png`;
      const parts = extractInboundParts({
        post_type: "message",
        message_type: "private",
        self_id: 42,
        user_id: 10001,
        message: [{ type: "image", data: { file: "pic.png", url } }],
      });

      const prepared = await prepareInboundMediaParts(parts, config(cacheDir));
      const image = prepared.find((part): part is InboundMediaPart => part.kind === "image");

      expect(image?.downloadStatus).toBe("saved");
      expect(image?.mime).toBe("image/png");
      expect(image?.localFileUri).toMatch(/^file:\/\//);
      expect(await readFile(image!.localPath!)).toEqual(bytes);
    } finally {
      await close(server);
    }
  });

  it("keeps the original URL when an image exceeds the configured size limit", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from("too-large");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
      res.end(bytes);
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${address.port}/large.png`;
      const parts = extractInboundParts({
        post_type: "message",
        message_type: "private",
        self_id: 42,
        user_id: 10001,
        message: [{ type: "image", data: { file: "large.png", url } }],
      });

      const prepared = await prepareInboundMediaParts(parts, config(cacheDir, { maxImageBytes: 4 }), {});
      const image = prepared.find((part): part is InboundMediaPart => part.kind === "image");

      expect(image?.downloadStatus).toBe("failed");
      expect(image?.url).toBe(url);
      expect(image?.localPath).toBeUndefined();
      expect(image?.downloadError).toContain("maxImageBytes");
    } finally {
      await close(server);
    }
  });

  it("resolves file-only image segments through get_image before caching", async () => {
    const cacheDir = await makeTempDir();
    const parts = extractInboundParts({
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [{ type: "image", data: { file: "only-file.png" } }],
    });

    const prepared = await prepareInboundMediaParts(parts, config(cacheDir), {}, async () => ({
      file: "only-file.png",
      url: "base64://iVBORw0KGgo=",
    }));
    const image = prepared.find((part): part is InboundMediaPart => part.kind === "image");

    expect(image?.downloadStatus).toBe("saved");
    expect(image?.mime).toBe("image/png");
    expect(image?.localPath).toBeTruthy();
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "onebot-hook-media-"));
  tempDirs.push(dir);
  return dir;
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
