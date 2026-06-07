import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type {
  InboundMediaKind,
  InboundMediaPart,
  InboundMessagePart,
  LoggerLike,
  OneBotFileData,
  OneBotHookConfig,
  OneBotImageData,
  OneBotMessageEvent,
  OneBotMessageSegment,
} from "./types.js";

export interface ExtractInboundPartOptions {
  stripMention: boolean;
  selfId?: number | null;
}

export type ResolveOneBotImageSource = (file: string, part: InboundMediaPart) => Promise<OneBotImageData | undefined>;
export type ResolveOneBotFileSource = (part: InboundMediaPart) => Promise<OneBotFileData | undefined>;

let lastCleanupAt = 0;

export function extractInboundParts(
  message: OneBotMessageEvent,
  opts: ExtractInboundPartOptions = { stripMention: true }
): InboundMessagePart[] {
  const segments = Array.isArray(message.message)
    ? message.message
    : parseRawOneBotMessage(typeof message.message === "string" ? message.message : (message.raw_message ?? ""));
  return segments.flatMap((segment) => partFromSegment(segment, opts));
}

export async function prepareInboundMediaParts(
  parts: InboundMessagePart[],
  config: OneBotHookConfig,
  logger: LoggerLike = {},
  resolveImage?: ResolveOneBotImageSource,
  resolveFile?: ResolveOneBotFileSource
): Promise<InboundMessagePart[]> {
  if (!config.media.enabled) return parts.map((part) => markMediaSkipped(part, "media-disabled"));
  await cleanupExpiredMedia(config, logger).catch((error) => {
    logger.warn?.(`[onebot-hook] media cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  const prepared: InboundMessagePart[] = [];
  for (const part of parts) {
    if (part.kind === "image") {
      prepared.push(await downloadImagePart(part, config, logger, resolveImage));
      continue;
    }
    if (part.kind === "file") {
      prepared.push(await downloadFilePart(part, config, logger, resolveFile));
      continue;
    }
    prepared.push(part);
  }
  return prepared;
}

export function partsHaveMedia(parts: InboundMessagePart[]): boolean {
  return parts.some((part) => part.kind === "image" || part.kind === "record" || part.kind === "video" || part.kind === "file");
}

export function partsToText(parts: InboundMessagePart[], opts: { includeMedia: boolean }): string {
  let text = "";
  for (const part of parts) {
    if (part.kind === "text" || part.kind === "mention") {
      text += part.text;
      continue;
    }
    if (part.kind === "unknown") {
      if (opts.includeMedia) text += part.text;
      continue;
    }
    if (opts.includeMedia) {
      text += mediaPlaceholder(part);
    }
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildOpenClawContent(parts: InboundMessagePart[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    textBuffer = "";
    if (text) content.push({ type: "text", text });
  };

  for (const part of parts) {
    if (part.kind === "text" || part.kind === "mention") {
      textBuffer += part.text;
      continue;
    }
    if (part.kind === "unknown") {
      textBuffer += part.text;
      continue;
    }
    if (part.kind === "file" && part.localPath) {
      flushText();
      content.push({
        type: "file",
        path: part.localPath,
        filePath: part.localPath,
        fileUrl: part.localFileUri,
        url: part.localFileUri ?? part.localPath,
        name: part.filename ?? part.file,
        filename: part.filename ?? part.file,
        size: part.size,
        mediaType: part.mime,
        mime_type: part.mime,
        alt: mediaPlaceholder(part).trim(),
        onebot: {
          type: part.segmentType,
          file: part.file,
          fileId: part.fileId,
          url: part.url,
          summary: part.summary,
          size: part.size,
          localPath: part.localPath,
          downloadStatus: part.downloadStatus,
          downloadError: part.downloadError,
        },
      });
      continue;
    }

    if (part.kind !== "image") {
      textBuffer += mediaPlaceholder(part);
      continue;
    }

    flushText();
    const url = part.localFileUri ?? part.url ?? part.source ?? part.file;
    if (!url) {
      content.push({ type: "text", text: mediaPlaceholder(part).trim() });
      continue;
    }
    content.push({
      type: "image",
      url,
      imageUrl: url,
      image_url: { url },
      mediaType: part.mime,
      mime_type: part.mime,
      filename: part.filename ?? part.file,
      alt: mediaPlaceholder(part).trim(),
      onebot: {
        type: part.segmentType,
        file: part.file,
        url: part.url,
        summary: part.summary,
        size: part.size,
        localPath: part.localPath,
        downloadStatus: part.downloadStatus,
        downloadError: part.downloadError,
      },
    });
  }
  flushText();
  return content.length > 0 ? content : [{ type: "text", text: "" }];
}

export function buildAgentMediaPayloadFromParts(parts: InboundMessagePart[]): Record<string, unknown> {
  const media = parts.flatMap((part) => {
    if (part.kind !== "image") return [];
      const path = agentReadableMediaPath(part);
    return path ? [{ path, contentType: part.mime }] : [];
  });
  const files = parts.flatMap((part) => {
    if (part.kind !== "file" || !part.localPath) return [];
    return [{ path: part.localPath, name: part.filename ?? part.file, contentType: part.mime, size: part.size }];
  });

  const payload: Record<string, unknown> = {};
  const first = media[0];
  if (first) {
    const paths = media.map((item) => item.path);
    const mediaTypes = media.map((item) => item.contentType).filter((item): item is string => Boolean(item));
    payload.MediaPath = first.path;
    payload.MediaUrl = first.path;
    payload.MediaPaths = paths;
    payload.MediaUrls = paths;
    if (first.contentType) payload.MediaType = first.contentType;
    if (mediaTypes.length > 0) payload.MediaTypes = mediaTypes;
  }

  const firstFile = files[0];
  if (firstFile) {
    payload.FilePath = firstFile.path;
    payload.FileUrl = firstFile.path;
    payload.FilePaths = files.map((item) => item.path);
    payload.FileUrls = files.map((item) => item.path);
    payload.FileName = firstFile.name;
    payload.FileNames = files.map((item) => item.name).filter(Boolean);
  }

  return payload;
}

export function summarizeMediaParts(parts: InboundMessagePart[]): Record<string, unknown>[] {
  return parts
    .filter((part): part is InboundMediaPart => part.kind === "image" || part.kind === "record" || part.kind === "video" || part.kind === "file")
    .map((part) => ({
      kind: part.kind,
      type: part.segmentType,
      file: part.file,
      url: part.url,
      source: part.source,
      summary: part.summary,
      filename: part.filename,
      mime: part.mime,
      size: part.size,
      localPath: part.localPath,
      localFileUri: part.localFileUri,
      downloadStatus: part.downloadStatus,
      downloadError: part.downloadError,
    }));
}

export function mediaPlaceholder(part: InboundMediaPart): string {
  const name = part.summary ?? part.filename ?? part.file ?? part.url ?? part.source ?? "media";
  if (part.kind === "file" && part.localPath) {
    return `\n[file: ${name}]\n[path: ${part.localPath}]\n`;
  }
  if (part.kind === "file" && part.downloadStatus === "failed" && part.downloadError) {
    return `\n[file: ${name}]\n[download failed: ${part.downloadError}]\n`;
  }
  return `\n[${part.kind}: ${name}]\n`;
}

export function parseRawOneBotMessage(raw: string): OneBotMessageSegment[] {
  if (!raw) return [];
  const segments: OneBotMessageSegment[] = [];
  const cqPattern = /\[CQ:([A-Za-z0-9_-]+)((?:,[^\]]*)?)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = cqPattern.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", data: { text: decodeCqText(raw.slice(lastIndex, match.index)) } });
    }
    segments.push({ type: match[1], data: parseCqData(match[2] ?? "") });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < raw.length) {
    segments.push({ type: "text", data: { text: decodeCqText(raw.slice(lastIndex)) } });
  }
  return segments;
}

export function resolveMediaCacheDir(cacheDir: string): string {
  if (cacheDir === "~") return homedir();
  if (cacheDir.startsWith("~/") || cacheDir.startsWith("~\\")) {
    return resolve(homedir(), cacheDir.slice(2));
  }
  return resolve(cacheDir);
}

function partFromSegment(segment: OneBotMessageSegment, opts: ExtractInboundPartOptions): InboundMessagePart[] {
  const data = segment.data ?? {};
  if (segment.type === "text") {
    const text = stringValue(data.text);
    return text ? [{ kind: "text", text }] : [];
  }
  if (segment.type === "at") {
    const qq = String(data.qq ?? "");
    const self = opts.selfId != null && qq === String(opts.selfId);
    if (self && opts.stripMention) return [];
    return qq ? [{ kind: "mention", qq, text: `@${qq}`, self }] : [];
  }
  if (isInboundMediaKind(segment.type)) {
    return [mediaPartFromSegment(segment.type, data)];
  }
  return [{ kind: "unknown", segmentType: segment.type, data, text: `\n[${segment.type}]\n` }];
}

function mediaPartFromSegment(kind: InboundMediaKind, data: Record<string, unknown>): InboundMediaPart {
  const file = stringValue(data.file);
  const fileId = stringValue(data.file_id) ?? stringValue(data.id);
  const url = stringValue(data.url);
  const source = url ?? file;
  const summary = stringValue(data.summary);
  const filename = stringValue(data.name) ?? stringValue(data.filename) ?? stringValue(data.file_name) ?? inferFilename(file ?? url);
  const size = numberValue(data.file_size) ?? numberValue(data.size);
  return {
    kind,
    segmentType: kind,
    data,
    file,
    fileId,
    url,
    source,
    summary,
    filename,
    size,
    mime: stringValue(data.mime) ?? stringValue(data.mime_type),
    downloadStatus: "skipped",
  };
}

function isInboundMediaKind(type: string): type is InboundMediaKind {
  return type === "image" || type === "record" || type === "video" || type === "file";
}

function markMediaSkipped(part: InboundMessagePart, reason: string): InboundMessagePart {
  if (part.kind !== "image" && part.kind !== "record" && part.kind !== "video" && part.kind !== "file") return part;
  return { ...part, downloadStatus: "skipped", downloadError: reason };
}

async function downloadImagePart(
  part: InboundMediaPart,
  config: OneBotHookConfig,
  logger: LoggerLike,
  resolveImage?: ResolveOneBotImageSource
): Promise<InboundMediaPart> {
  if (!config.media.downloadInboundImages) return { ...part, downloadStatus: "skipped", downloadError: "download-disabled" };
  const resolvedPart = await resolveOneBotImagePart(part, resolveImage, logger);
  const source = chooseReadableImageSource(resolvedPart);
  if (!source) return { ...resolvedPart, downloadStatus: "skipped", downloadError: "missing-image-source" };

  try {
    const cached = await readImageSource(source, config);
    const cacheDir = resolveMediaCacheDir(config.media.cacheDir);
    await mkdir(cacheDir, { recursive: true });
    const ext = guessImageExtension(cached.mime ?? resolvedPart.mime, resolvedPart.filename ?? source);
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 24);
    const localPath = join(cacheDir, `${hash}${ext}`);
    await writeFile(localPath, cached.bytes);
    return {
      ...resolvedPart,
      mime: cached.mime ?? resolvedPart.mime ?? mimeFromExtension(ext),
      size: cached.bytes.length,
      localPath,
      localFileUri: pathToFileURL(localPath).href,
      downloadStatus: "saved",
      downloadError: undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`[onebot-hook] inbound image download failed: ${message}`);
    return { ...resolvedPart, downloadStatus: "failed", downloadError: message };
  }
}

async function downloadFilePart(
  part: InboundMediaPart,
  config: OneBotHookConfig,
  logger: LoggerLike,
  resolveFile?: ResolveOneBotFileSource
): Promise<InboundMediaPart> {
  if (!config.files.enabled) return { ...part, downloadStatus: "skipped", downloadError: "files-disabled" };
  if (!config.files.downloadInboundFiles) return { ...part, downloadStatus: "skipped", downloadError: "download-disabled" };
  const resolvedPart = await resolveOneBotFilePart(part, resolveFile, logger);
  const source = chooseReadableFileSource(resolvedPart);
  if (!source) return { ...resolvedPart, downloadStatus: "failed", downloadError: "missing-file-source" };

  try {
    const incomingDir = resolveMediaCacheDir(config.files.incomingDir);
    await mkdir(incomingDir, { recursive: true });
    const filename = safeFilename(resolvedPart.filename ?? inferFilename(source) ?? resolvedPart.fileId ?? resolvedPart.file ?? "onebot-file");
    const hash = createHash("sha256").update(`${source}\n${filename}`).digest("hex").slice(0, 16);
    const localPath = join(incomingDir, `${Date.now()}-${hash}-${filename}`);
    const downloaded = await writeFileSource(source, localPath, config, resolvedPart.mime);
    return {
      ...resolvedPart,
      filename,
      mime: downloaded.mime ?? resolvedPart.mime,
      size: downloaded.size,
      localPath,
      localFileUri: pathToFileURL(localPath).href,
      downloadStatus: "saved",
      downloadError: undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`[onebot-hook] inbound file download failed: ${message}`);
    return { ...resolvedPart, downloadStatus: "failed", downloadError: message };
  }
}

async function resolveOneBotFilePart(
  part: InboundMediaPart,
  resolveFile: ResolveOneBotFileSource | undefined,
  logger: LoggerLike
): Promise<InboundMediaPart> {
  if (chooseReadableFileSource(part) || !resolveFile) return part;
  try {
    const resolved = await resolveFile(part);
    if (!resolved || typeof resolved !== "object") return part;

    const resolvedUrl = stringValue(resolved.url);
    const resolvedPath = stringValue(resolved.path);
    const resolvedFile = stringValue(resolved.file);
    const resolvedFileId = stringValue(resolved.file_id);
    const source = firstReadableFileSource(resolvedUrl, resolvedPath, resolvedFile);
    const filename =
      stringValue(resolved.name) ??
      stringValue(resolved.filename) ??
      stringValue(resolved.file_name) ??
      part.filename ??
      inferFilename(resolvedFile ?? resolvedPath ?? resolvedUrl);
    return {
      ...part,
      data: { ...part.data, _resolved: resolved },
      file: resolvedFile ?? part.file,
      fileId: resolvedFileId ?? part.fileId,
      url: resolvedUrl ?? part.url,
      source: source ?? part.source,
      filename,
      size: part.size ?? numberValue(resolved.size) ?? numberValue(resolved.file_size),
      mime: part.mime ?? stringValue(resolved.mime) ?? stringValue(resolved.mime_type),
    };
  } catch (error) {
    logger.warn?.(`[onebot-hook] get_file failed for ${part.fileId ?? part.file ?? "file"}: ${error instanceof Error ? error.message : String(error)}`);
    return part;
  }
}

async function resolveOneBotImagePart(
  part: InboundMediaPart,
  resolveImage: ResolveOneBotImageSource | undefined,
  logger: LoggerLike
): Promise<InboundMediaPart> {
  if (chooseReadableImageSource(part) || !part.file || !resolveImage) return part;
  try {
    const resolved = await resolveImage(part.file, part);
    if (!resolved || typeof resolved !== "object") return part;

    const resolvedUrl = stringValue(resolved.url);
    const resolvedPath = stringValue(resolved.path);
    const resolvedFile = stringValue(resolved.file);
    const source = firstReadableImageSource(resolvedUrl, resolvedPath, resolvedFile);
    return {
      ...part,
      data: { ...part.data, _resolved: resolved },
      file: resolvedFile ?? part.file,
      url: resolvedUrl ?? part.url,
      source: source ?? part.source,
      filename: part.filename ?? inferFilename(resolvedFile ?? resolvedPath ?? resolvedUrl),
      mime: part.mime ?? stringValue(resolved.mime) ?? stringValue(resolved.mime_type),
    };
  } catch (error) {
    logger.warn?.(`[onebot-hook] get_image failed for ${part.file}: ${error instanceof Error ? error.message : String(error)}`);
    return part;
  }
}

function agentReadableMediaPath(part: InboundMediaPart): string | undefined {
  if (part.localPath) return part.localPath;
  if (part.localFileUri) return part.localFileUri;
  return chooseReadableImageSource(part);
}

function chooseReadableImageSource(part: InboundMediaPart): string | undefined {
  return firstReadableImageSource(part.url, part.source, part.file);
}

function chooseReadableFileSource(part: InboundMediaPart): string | undefined {
  return firstReadableFileSource(part.url, part.source, part.file);
}

function firstReadableImageSource(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value != null && isReadableImageSource(value));
}

function firstReadableFileSource(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value != null && isReadableFileSource(value));
}

function isReadableImageSource(source: string): boolean {
  return /^https?:\/\//i.test(source) || source.startsWith("file://") || source.startsWith("base64://") || isPlainFilePath(source);
}

function isReadableFileSource(source: string): boolean {
  return /^https?:\/\//i.test(source) || source.startsWith("file://") || source.startsWith("base64://") || /^data:/i.test(source) || isPlainFilePath(source);
}

function isPlainFilePath(source: string): boolean {
  return isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source);
}

async function readImageSource(source: string, config: OneBotHookConfig): Promise<{ bytes: Buffer; mime?: string }> {
  if (/^https?:\/\//i.test(source)) return fetchImage(source, config);
  if (source.startsWith("file://")) return readFileUriImage(source, config);
  if (source.startsWith("base64://")) return readBase64Image(source, config);
  if (isPlainFilePath(source)) return readPlainFileImage(source, config);
  throw new Error("unsupported image source");
}

async function writeFileSource(source: string, localPath: string, config: OneBotHookConfig, fallbackMime?: string): Promise<{ size: number; mime?: string }> {
  const tempPath = `${localPath}.tmp-${process.pid}`;
  try {
    const result = await writeFileSourceToTemp(source, tempPath, config, fallbackMime);
    await rename(tempPath, localPath);
    return result;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function writeFileSourceToTemp(source: string, tempPath: string, config: OneBotHookConfig, fallbackMime?: string): Promise<{ size: number; mime?: string }> {
  if (/^https?:\/\//i.test(source)) return fetchFileToPath(source, tempPath, config, fallbackMime);
  if (source.startsWith("file://")) return copyPlainFileToPath(fileURLToPath(source), tempPath, config, fallbackMime);
  if (source.startsWith("base64://")) return writeBase64FileToPath(source.slice("base64://".length), tempPath, config, fallbackMime);
  if (/^data:/i.test(source)) return writeDataUriFileToPath(source, tempPath, config, fallbackMime);
  if (isPlainFilePath(source)) return copyPlainFileToPath(source, tempPath, config, fallbackMime);
  throw new Error("unsupported file source");
}

async function fetchFileToPath(url: string, tempPath: string, config: OneBotHookConfig, fallbackMime?: string): Promise<{ size: number; mime?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.files.downloadTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = numberValue(response.headers.get("content-length"));
    if (length != null && length > config.files.maxFileBytes) {
      throw new Error(`file exceeds maxFileBytes (${length})`);
    }
    if (!response.body) throw new Error("HTTP response has no body");
    const size = await streamToFileWithLimit(Readable.fromWeb(response.body as any), tempPath, config.files.maxFileBytes);
    return { size, mime: response.headers.get("content-type")?.split(";")[0]?.trim() || fallbackMime };
  } finally {
    clearTimeout(timer);
  }
}

async function copyPlainFileToPath(path: string, tempPath: string, config: OneBotHookConfig, fallbackMime?: string): Promise<{ size: number; mime?: string }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("source path is not a regular file");
  if (info.size > config.files.maxFileBytes) throw new Error(`file exceeds maxFileBytes (${info.size})`);
  await copyFile(path, tempPath);
  return { size: info.size, mime: fallbackMime ?? mimeFromExtension(extname(path)) };
}

async function writeBase64FileToPath(encoded: string, tempPath: string, config: OneBotHookConfig, fallbackMime?: string): Promise<{ size: number; mime?: string }> {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > config.files.maxFileBytes) throw new Error(`file exceeds maxFileBytes (${bytes.length})`);
  await writeFile(tempPath, bytes);
  return { size: bytes.length, mime: fallbackMime };
}

async function writeDataUriFileToPath(source: string, tempPath: string, config: OneBotHookConfig, fallbackMime?: string): Promise<{ size: number; mime?: string }> {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(source);
  if (!match) throw new Error("invalid data URI");
  const mime = match[1] || fallbackMime;
  const payload = match[3] ?? "";
  const bytes = match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  if (bytes.length > config.files.maxFileBytes) throw new Error(`file exceeds maxFileBytes (${bytes.length})`);
  await writeFile(tempPath, bytes);
  return { size: bytes.length, mime };
}

async function streamToFileWithLimit(readable: Readable, tempPath: string, maxBytes: number): Promise<number> {
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error(`file exceeds maxFileBytes (${total})`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(readable, limiter, createWriteStream(tempPath));
  return total;
}

async function fetchImage(url: string, config: OneBotHookConfig): Promise<{ bytes: Buffer; mime?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.media.downloadTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = numberValue(response.headers.get("content-length"));
    if (length != null && length > config.media.maxImageBytes) {
      throw new Error(`image exceeds maxImageBytes (${length})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > config.media.maxImageBytes) {
      throw new Error(`image exceeds maxImageBytes (${bytes.length})`);
    }
    return { bytes, mime: response.headers.get("content-type")?.split(";")[0]?.trim() || undefined };
  } finally {
    clearTimeout(timer);
  }
}

async function readFileUriImage(source: string, config: OneBotHookConfig): Promise<{ bytes: Buffer; mime?: string }> {
  const path = fileURLToPath(source);
  return readPlainFileImage(path, config);
}

async function readPlainFileImage(path: string, config: OneBotHookConfig): Promise<{ bytes: Buffer; mime?: string }> {
  const info = await stat(path);
  if (info.size > config.media.maxImageBytes) throw new Error(`image exceeds maxImageBytes (${info.size})`);
  const ext = extname(path) || ".img";
  return { bytes: await readFile(path), mime: mimeFromExtension(ext) };
}

function readBase64Image(source: string, config: OneBotHookConfig): { bytes: Buffer; mime?: string } {
  const bytes = Buffer.from(source.slice("base64://".length), "base64");
  if (bytes.length > config.media.maxImageBytes) throw new Error(`image exceeds maxImageBytes (${bytes.length})`);
  return { bytes };
}

async function cleanupExpiredMedia(config: OneBotHookConfig, logger: LoggerLike): Promise<void> {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = now;
  const dir = resolveMediaCacheDir(config.media.cacheDir);
  const retainMs = config.media.retainHours * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const info = await stat(fullPath);
      if (info.isFile() && now - info.mtimeMs > retainMs) await unlink(fullPath);
    } catch (error) {
      logger.warn?.(`[onebot-hook] failed to clean cached media ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function parseCqData(rawParams: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const raw = rawParams.startsWith(",") ? rawParams.slice(1) : rawParams;
  if (!raw) return data;
  for (const part of raw.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    data[part.slice(0, index)] = decodeCqText(part.slice(index + 1));
  }
  return data;
}

function decodeCqText(value: string): string {
  return value
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function inferFilename(source?: string): string | undefined {
  if (!source) return undefined;
  try {
    if (/^https?:\/\//i.test(source)) {
      const name = basename(new URL(source).pathname);
      return name || undefined;
    }
    if (source.startsWith("file://")) return basename(fileURLToPath(source));
  } catch {
    return undefined;
  }
  return basename(source);
}

function safeFilename(name: string): string {
  const normalized = basename(name)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .trim();
  if (!normalized || normalized === "." || normalized === "..") return "onebot-file";
  return normalized.slice(0, 180);
}

function guessImageExtension(mime: string | undefined, name: string): string {
  const byMime = mime ? mimeFromExtension(`.${mime.split("/").pop() ?? ""}`) : undefined;
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (byMime) return `.${mime!.split("/").pop()}`;
  const ext = extname(name).toLowerCase();
  return ext && ext.length <= 8 ? ext : ".img";
}

function mimeFromExtension(ext: string): string | undefined {
  const normalized = ext.toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".png") return "image/png";
  if (normalized === ".gif") return "image/gif";
  if (normalized === ".webp") return "image/webp";
  return undefined;
}
