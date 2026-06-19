import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentMediaPayloadFromParts, extractInboundParts, partsToText, prepareInboundMediaParts } from "../src/media.js";
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
    files: {
      enabled: true,
      maxFileBytes: 4_294_967_296,
      detectTextPaths: true,
      downloadInboundFiles: true,
      incomingDir: join(cacheDir, "incoming-files"),
      downloadTimeoutMs: 10_000,
      allowedRoots: [cacheDir],
      pathMappings: [],
      fallbackOnFailure: "text",
    },
    interrupt: {
      enabled: true,
      mode: "abort_and_resend",
      sameSenderOnly: true,
      debounceMs: 800,
      followupWindowMs: 120_000,
      maxBufferedMessages: 8,
      suppressSupersededReplies: true,
      interruptAfterOutput: false,
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
      MediaKind: "image",
      MediaKinds: ["image"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });

  it("includes cached image paths in model-readable placeholder text", () => {
    const text = partsToText(
      [
        {
          kind: "image",
          segmentType: "image",
          data: {},
          file: "pic.png",
          localPath: "/tmp/openclaw/pic.png",
          mime: "image/png",
        },
      ],
      { includeMedia: true },
    );

    expect(text).toContain("[image: pic.png]");
    expect(text).toContain("[path: /tmp/openclaw/pic.png]");
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

  it("downloads inbound file URLs into the configured incoming directory", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from("zip-data");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip", "content-length": String(bytes.length) });
      res.end(bytes);
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${address.port}/imagegen-skills.zip`;
      const parts = extractInboundParts({
        post_type: "message",
        message_type: "private",
        self_id: 42,
        user_id: 10001,
        message: [{ type: "file", data: { file: "imagegen-skills.zip", url, file_size: bytes.length } }],
      });

      const prepared = await prepareInboundMediaParts(parts, config(cacheDir));
      const file = prepared.find((part): part is InboundMediaPart => part.kind === "file");
      const payload = buildAgentMediaPayloadFromParts(prepared);

      expect(file?.downloadStatus).toBe("saved");
      expect(file?.localPath).toContain("imagegen-skills.zip");
      expect(file?.localFileUri).toMatch(/^file:\/\//);
      expect(await readFile(file!.localPath!)).toEqual(bytes);
      expect(payload.FilePath).toBe(file?.localPath);
    } finally {
      await close(server);
    }
  });

  it("downloads inbound video URLs into the configured incoming directory", async () => {
    const cacheDir = await makeTempDir();
    const bytes = Buffer.from("mp4-data");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": String(bytes.length) });
      res.end(bytes);
    });
    await listen(server);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server address unavailable");
      const url = `http://127.0.0.1:${address.port}/clip.mp4`;
      const parts = extractInboundParts({
        post_type: "message",
        message_type: "private",
        self_id: 42,
        user_id: 10001,
        message: [{ type: "video", data: { file: "clip.mp4", url, file_size: bytes.length } }],
      });

      const prepared = await prepareInboundMediaParts(parts, config(cacheDir));
      const video = prepared.find((part): part is InboundMediaPart => part.kind === "video");
      const text = partsToText(prepared, { includeMedia: true });
      const payload = buildAgentMediaPayloadFromParts(prepared);

      expect(video?.downloadStatus).toBe("saved");
      expect(video?.localPath).toContain("clip.mp4");
      expect(video?.mime).toBe("video/mp4");
      expect(await readFile(video!.localPath!)).toEqual(bytes);
      expect(text).toContain("[video: clip.mp4]");
      expect(text).toContain("[path: ");
      expect(payload.MediaPath).toBe(video?.localPath);
      expect(payload.FilePath).toBe(video?.localPath);
    } finally {
      await close(server);
    }
  });

  it("resolves file-only file segments before downloading", async () => {
    const cacheDir = await makeTempDir();
    const parts = extractInboundParts({
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [{ type: "file", data: { file_id: "fid-1", name: "bundle.zip" } }],
    });

    const prepared = await prepareInboundMediaParts(parts, config(cacheDir), {}, undefined, async () => ({
      file_id: "fid-1",
      url: "base64://emlw",
      file_name: "bundle.zip",
      mime: "application/zip",
    }));
    const file = prepared.find((part): part is InboundMediaPart => part.kind === "file");

    expect(file?.downloadStatus).toBe("saved");
    expect(file?.filename).toBe("bundle.zip");
    expect(file?.mime).toBe("application/zip");
    expect(await readFile(file!.localPath!, "utf8")).toBe("zip");
  });

  it("resolves OneBot reply segments into model-readable quote text", async () => {
    const cacheDir = await makeTempDir();
    const parts = extractInboundParts({
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [
        { type: "reply", data: { id: 123 } },
        { type: "text", data: { text: " 我的引用看得到么" } },
      ],
    });

    expect(partsToText(parts, { includeMedia: false })).toBe("我的引用看得到么");
    expect(partsToText(parts, { includeMedia: true })).toContain("[reply #123]");

    const prepared = await prepareInboundMediaParts(
      parts,
      config(cacheDir),
      {},
      undefined,
      undefined,
      async () => ({
        message_id: 123,
        user_id: 20002,
        sender: { nickname: "鸦羽绯夜" },
        message: [{ type: "text", data: { text: "正在被主人的 B草。" } }],
      }),
    );

    expect(partsToText(prepared, { includeMedia: true })).toBe(
      "[reply #123 from 鸦羽绯夜]\n正在被主人的 B草。\n[/reply]\n我的引用看得到么",
    );
  });

  it("downloads images inside quoted OneBot reply messages", async () => {
    const cacheDir = await makeTempDir();
    const parts = extractInboundParts({
      post_type: "message",
      message_type: "group",
      self_id: 42,
      user_id: 10001,
      group_id: 90001,
      message: [
        { type: "reply", data: { id: 123 } },
        { type: "at", data: { qq: 42 } },
        { type: "text", data: { text: " COS一下" } },
      ],
    });

    const prepared = await prepareInboundMediaParts(
      parts,
      config(cacheDir),
      {},
      async () => ({
        file: "quoted.png",
        url: "base64://iVBORw0KGgo=",
      }),
      undefined,
      async () => ({
        message_id: 123,
        user_id: 20002,
        sender: { nickname: "锡纸烤盘韩科长" },
        message: [{ type: "image", data: { file: "quoted.png" } }],
      }),
    );
    const text = partsToText(prepared, { includeMedia: true });

    expect(text).toContain("[reply #123 from 锡纸烤盘韩科长]");
    expect(text).toContain("[image: quoted.png]");
    expect(text).toContain("[path: ");
    expect(text).toContain("COS一下");
  });

  it("keeps file metadata when an inbound file exceeds the configured size limit", async () => {
    const cacheDir = await makeTempDir();
    const parts = extractInboundParts({
      post_type: "message",
      message_type: "private",
      self_id: 42,
      user_id: 10001,
      message: [{ type: "file", data: { file: "large.zip", url: "base64://dG9vLWxhcmdl" } }],
    });

    const cfg = config(cacheDir);
    cfg.files.maxFileBytes = 4;
    const prepared = await prepareInboundMediaParts(parts, cfg, {});
    const file = prepared.find((part): part is InboundMediaPart => part.kind === "file");

    expect(file?.downloadStatus).toBe("failed");
    expect(file?.localPath).toBeUndefined();
    expect(file?.downloadError).toContain("maxFileBytes");
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
