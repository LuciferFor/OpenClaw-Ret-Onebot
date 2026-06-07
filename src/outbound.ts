import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import type { CapturedReplyTarget, LoggerLike, OneBotFileUploadData, OneBotHookConfig, OneBotMessageSegment, OneBotOutgoingMessage, OneBotSendData } from "./types.js";
import { collapseDoubleNewlines, markdownToPlain } from "./markdown.js";
import { isOkResponse, OneBotClient } from "./onebot-client.js";

type ReplyPayload = string | {
  text?: unknown;
  body?: unknown;
  content?: unknown;
  contentItems?: unknown;
  mediaUrl?: unknown;
  mediaUrls?: unknown;
  dataUri?: unknown;
  imageUrl?: unknown;
  image_url?: unknown;
  filePath?: unknown;
  fileUrl?: unknown;
  url?: unknown;
  file?: unknown;
  path?: unknown;
  source?: unknown;
  name?: unknown;
  filename?: unknown;
};

type ReplyPart =
  | { kind: "text"; text: string; rawText: string }
  | { kind: "image"; url: string; alt?: string }
  | ReplyFilePart;

export interface ReplyFilePart {
  kind: "file";
  file: string;
  name: string;
  original: string;
  sourceText?: string;
  size?: number;
  fallbackReason?: string;
}

export interface SendAttempt {
  target: CapturedReplyTarget;
  text: string;
  message: OneBotOutgoingMessage;
  messageId: string;
}

export type SendMessageFn = (target: CapturedReplyTarget, message: OneBotOutgoingMessage) => Promise<string>;
export type SendTextFn = (target: CapturedReplyTarget, text: string) => Promise<string>;
export type SendFileFn = (target: CapturedReplyTarget, file: ReplyFilePart) => Promise<string>;

export interface ReplyChunkSenderOptions {
  suppressFinalTextAfterToolResult?: boolean;
  forwardToolResultLinks?: boolean;
  sendFile?: SendFileFn;
}

export async function sendTextToCapturedTarget(
  client: OneBotClient,
  config: OneBotHookConfig,
  target: CapturedReplyTarget,
  text: string,
  logger: LoggerLike = {}
): Promise<string> {
  return sendOneBotMessageToCapturedTarget(client, config, target, text, logger);
}

export async function sendOneBotMessageToCapturedTarget(
  client: OneBotClient,
  config: OneBotHookConfig,
  target: CapturedReplyTarget,
  message: OneBotOutgoingMessage,
  logger: LoggerLike = {}
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= config.reply.maxRetries; attempt += 1) {
    try {
      const response = target.kind === "group"
        ? await client.sendGroupMsg(target.id, message)
        : await client.sendPrivateMsg(target.id, message);
      if (!isOkResponse(response)) {
        throw new Error(response.wording ?? response.message ?? `retcode=${response.retcode ?? "unknown"}`);
      }
      const data = response.data as OneBotSendData | undefined;
      const messageId = data?.message_id == null ? "" : String(data.message_id);
      logger.info?.(`[onebot-hook] sent ${target.kind}:${target.id} message_id=${messageId || "(none)"} ${describeOutgoingMessage(message)}`);
      return messageId;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn?.(`[onebot-hook] send attempt ${attempt}/${config.reply.maxRetries} failed for ${target.kind}:${target.id}: ${lastError.message}`);
      if (attempt < config.reply.maxRetries) await sleep(Math.min(500 * attempt, 2000));
    }
  }
  throw lastError ?? new Error("send failed");
}

export async function sendOneBotFileToCapturedTarget(
  client: OneBotClient,
  config: OneBotHookConfig,
  target: CapturedReplyTarget,
  file: ReplyFilePart,
  logger: LoggerLike = {}
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= config.reply.maxRetries; attempt += 1) {
    try {
      const response = target.kind === "group"
        ? await client.uploadGroupFile(target.id, file.file, file.name)
        : await client.uploadPrivateFile(target.id, file.file, file.name);
      if (!isOkResponse(response)) {
        throw new Error(response.wording ?? response.message ?? `retcode=${response.retcode ?? "unknown"}`);
      }
      const data = response.data as OneBotFileUploadData | undefined;
      const messageId = data?.message_id ?? data?.file_id ?? data?.file ?? "";
      logger.info?.(`[onebot-hook] uploaded ${target.kind}:${target.id} file=${file.name} size=${file.size ?? "unknown"} id=${messageId || "(none)"}`);
      return String(messageId);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn?.(`[onebot-hook] file upload attempt ${attempt}/${config.reply.maxRetries} failed for ${target.kind}:${target.id} ${file.name}: ${lastError.message}`);
      if (attempt < config.reply.maxRetries) await sleep(Math.min(500 * attempt, 2000));
    }
  }
  throw lastError ?? new Error("file upload failed");
}

export class ReplyChunkSender {
  private textBuffer = "";
  private rawBuffer = "";
  private partsBuffer: ReplyPart[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private imageCount = 0;
  private seenImageUrls = new Set<string>();
  private seenFiles = new Set<string>();
  private toolResultSeen = false;
  private toolResultOutputSeen = false;
  readonly sent: SendAttempt[] = [];

  constructor(
    private readonly config: OneBotHookConfig,
    private readonly target: CapturedReplyTarget,
    private readonly sendMessage: SendMessageFn,
    private readonly logger: LoggerLike = {},
    private readonly options: ReplyChunkSenderOptions = {}
  ) {}

  async deliver(payload: unknown, info: { kind?: string } = {}): Promise<void> {
    const toolInfo = isToolInfo(info);
    let parts = this.extractParts(payload as ReplyPayload, {
      mediaOnly: toolInfo,
      textLinksOnly: toolInfo && this.options.forwardToolResultLinks === true,
    });
    if (info.kind === "final" && this.shouldFilterFinalAfterToolResult()) {
      if (this.toolResultOutputSeen) {
        this.logger.debug?.("[onebot-hook] final reply suppressed after tool result output");
        return;
      }
      parts = finalImageOrLinkParts(parts);
      if (parts.length === 0) {
        this.logger.debug?.("[onebot-hook] final reply suppressed after empty tool result");
        return;
      }
    }
    if (toolInfo) this.toolResultSeen = true;
    if (parts.length === 0) return;
    if (isNoReply(parts)) {
      return;
    }
    if (toolInfo) this.toolResultOutputSeen = true;

    for (const part of parts) {
      if (part.kind === "text") {
        this.textBuffer = appendText(this.textBuffer, part.text);
        this.rawBuffer = appendText(this.rawBuffer, part.rawText);
        continue;
      }

      if (part.kind === "file") {
        await this.deliverFilePart(part);
        continue;
      }

      if (!this.config.media.enabled) continue;
      if (this.seenImageUrls.has(part.url)) {
        this.logger.debug?.("[onebot-hook] outbound image skipped: duplicate media source");
        continue;
      }
      if (this.imageCount >= this.config.media.maxImagesPerReply) {
        this.logger.warn?.("[onebot-hook] outbound image skipped: maxImagesPerReply reached");
        continue;
      }
      this.flushTextIntoParts();
      this.partsBuffer.push(part);
      this.imageCount += 1;
      this.seenImageUrls.add(part.url);
    }

    if (toolInfo || this.shouldFlushNow() || info.kind === "final") {
      await this.queueFlush();
    } else {
      this.scheduleFlush();
    }

    if (info.kind === "final") {
      await this.finish();
    }
  }

  async deliverToolResult(payload: unknown): Promise<void> {
    await this.deliver(payload, { kind: "tool-result" });
  }

  async finish(): Promise<void> {
    this.clearTimer();
    await this.queueFlush();
    await this.flushChain;
  }

  private extractParts(payload: ReplyPayload, opts: { mediaOnly?: boolean; textLinksOnly?: boolean } = {}): ReplyPart[] {
    if (typeof payload === "string") {
      if (opts.mediaOnly) return opts.textLinksOnly ? this.extractToolResultLinkText(payload) : [];
      return this.extractTextAndMarkdownImages(payload);
    }
    if (!payload || typeof payload !== "object") return [];

    const parts: ReplyPart[] = [];
    const contentParts = Array.isArray(payload.content) ? this.extractContentParts(payload.content, opts) : [];
    const contentItemParts = Array.isArray(payload.contentItems) ? this.extractContentParts(payload.contentItems, opts) : [];
    parts.push(...contentParts, ...contentItemParts);
    if (!opts.mediaOnly && parts.length === 0) {
      parts.push(...this.extractTextAndMarkdownImages(stringValue(payload.text) ?? stringValue(payload.body) ?? ""));
    }
    for (const url of normalizeUrlList(payload.mediaUrl)) parts.push({ kind: "image", url });
    for (const url of normalizeUrlList(payload.mediaUrls)) parts.push({ kind: "image", url });
    const directImage = imageUrlFromContentItem(payload as Record<string, unknown>);
    if (directImage) parts.push({ kind: "image", url: directImage });
    const directFile = filePartFromContentItem(payload as Record<string, unknown>, this.config, false);
    if (directFile) parts.push(directFile);
    return parts;
  }

  private extractContentParts(content: unknown[], opts: { mediaOnly?: boolean; textLinksOnly?: boolean } = {}): ReplyPart[] {
    const parts: ReplyPart[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        if (!opts.mediaOnly) parts.push(...this.extractTextAndMarkdownImages(item));
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const type = stringValue(value.type);
      if (type === "text") {
        const text = stringValue(value.text) ?? "";
        if (opts.mediaOnly) {
          if (opts.textLinksOnly) parts.push(...this.extractToolResultLinkText(text));
        } else {
          parts.push(...this.extractTextAndMarkdownImages(text));
        }
        continue;
      }
      const imageUrl = imageUrlFromContentItem(value);
      if (imageUrl && isImageContentType(type)) {
        parts.push({ kind: "image", url: imageUrl, alt: stringValue(value.alt) });
      }
      const file = filePartFromContentItem(value, this.config, false);
      if (file) parts.push(file);
      if (Array.isArray(value.content)) parts.push(...this.extractContentParts(value.content, opts));
      if (Array.isArray(value.contentItems)) parts.push(...this.extractContentParts(value.contentItems, opts));
    }
    return parts;
  }

  private extractToolResultLinkText(input: string): ReplyPart[] {
    const text = this.prepareText(input);
    if (!text || !hasUsefulLink(text)) return [];
    return [{ kind: "text", text, rawText: input }];
  }

  private extractTextAndMarkdownImages(input: string): ReplyPart[] {
    if (!input.trim()) return [];
    if (!this.config.media.enabled || !this.config.media.markdownImages) {
      const text = this.prepareText(input);
      return text ? [{ kind: "text", text, rawText: input }] : [];
    }

    const parts: ReplyPart[] = [];
    const pattern = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      const before = input.slice(lastIndex, match.index);
      const text = this.prepareText(before);
      if (text) parts.push({ kind: "text", text, rawText: before });
      const url = normalizeOutboundImageSource(match[2].replace(/^<|>$/g, ""));
      if (url) parts.push({ kind: "image", url, alt: match[1] || undefined });
      lastIndex = match.index + match[0].length;
    }
    const rest = input.slice(lastIndex);
    const text = this.prepareText(rest);
    if (text) parts.push({ kind: "text", text, rawText: rest });
    if (this.config.files.enabled && this.config.files.detectTextPaths) {
      parts.push(...filePartsFromText(input, this.config));
    }
    return parts;
  }

  private prepareText(input: string): string {
    let text = input.trim();
    if (!text) return "";
    if (this.config.reply.markdownToPlain) text = markdownToPlain(text);
    return collapseDoubleNewlines(text).trim();
  }

  private shouldFlushNow(): boolean {
    if (this.textBuffer.length >= this.config.reply.flushChars) return true;
    if (this.rawBuffer.length < 24) return false;
    return /[.!?。！？]\s*$/.test(this.rawBuffer);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.queueFlush().catch((error) => {
        this.logger.error?.(`[onebot-hook] scheduled flush failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.config.reply.flushIntervalMs);
  }

  private async queueFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.flush());
    return this.flushChain;
  }

  private async flush(): Promise<void> {
    this.clearTimer();
    this.flushTextIntoParts();
    const parts = this.partsBuffer;
    this.partsBuffer = [];
    if (parts.length === 0) return;

    const message = replyPartsToOneBotMessage(parts);
    const messageId = await this.sendMessage(this.target, message);
    this.sent.push({ target: this.target, text: summarizeReplyParts(parts), message, messageId });
  }

  private flushTextIntoParts(): void {
    const text = this.textBuffer.trim();
    const rawText = this.rawBuffer.trim();
    this.textBuffer = "";
    this.rawBuffer = "";
    if (text) this.partsBuffer.push({ kind: "text", text, rawText });
  }

  private clearTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private shouldFilterFinalAfterToolResult(): boolean {
    if (!this.options.suppressFinalTextAfterToolResult) return false;
    return this.toolResultSeen;
  }

  private async deliverFilePart(part: ReplyFilePart): Promise<void> {
    if (!this.config.files.enabled) return;
    const key = `${part.file}\n${part.name}`;
    if (this.seenFiles.has(key)) {
      this.logger.debug?.("[onebot-hook] outbound file skipped: duplicate file source");
      return;
    }
    this.seenFiles.add(key);
    await this.queueFlush();
    const sendFile = this.options.sendFile;
    if (part.fallbackReason || !sendFile) {
      await this.sendFileFallback(part, part.fallbackReason ?? "file upload function is unavailable");
      return;
    }
    try {
      const messageId = await sendFile(this.target, part);
      this.sent.push({ target: this.target, text: summarizeReplyParts([part]), message: `[file:${part.name}]`, messageId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.sendFileFallback(part, reason);
    }
  }

  private async sendFileFallback(part: ReplyFilePart, reason: string): Promise<void> {
    const message = [
      `文件上传失败：${part.name}`,
      `路径：${part.original}`,
      part.size == null ? undefined : `大小：${formatBytes(part.size)}`,
      `原因：${reason}`,
    ].filter((item): item is string => Boolean(item)).join("\n");
    const messageId = await this.sendMessage(this.target, message);
    this.sent.push({ target: this.target, text: message, message, messageId });
  }
}

function replyPartsToOneBotMessage(parts: ReplyPart[]): OneBotOutgoingMessage {
  const hasImage = parts.some((part) => part.kind === "image");
  if (!hasImage) return parts.filter((part) => part.kind === "text").map((part) => part.text).join("");

  const segments: OneBotMessageSegment[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      if (part.text) segments.push({ type: "text", data: { text: part.text } });
      continue;
    }
    if (part.kind === "file") continue;
    segments.push({ type: "image", data: { file: normalizeOutboundImageSource(part.url), ...(part.alt ? { summary: part.alt } : {}) } });
  }
  return segments;
}

function isNoReply(parts: ReplyPart[]): boolean {
  const hasImage = parts.some((part) => part.kind === "image");
  const hasFile = parts.some((part) => part.kind === "file");
  if (hasImage || hasFile) return false;
  const raw = parts.filter((part) => part.kind === "text").map((part) => part.rawText).join("").trim();
  return !raw || raw === "NO_REPLY" || raw.endsWith("NO_REPLY");
}

function normalizeUrlList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => {
    if (item && typeof item === "object") return imageUrlFromContentItem(item as Record<string, unknown>);
    return normalizeOutboundImageSource(stringValue(item));
  }).filter((item): item is string => Boolean(item));
  const single = normalizeOutboundImageSource(stringValue(value));
  return single ? [single] : [];
}

function imageUrlFromContentItem(value: Record<string, unknown>): string | undefined {
  const type = stringValue(value.type);
  if (isFileContentType(type)) return undefined;
  const direct =
    stringValue(value.url) ??
    stringValue(value.imageUrl) ??
    stringValue(value.mediaUrl) ??
    stringValue(value.dataUri);
  if (direct) return normalizeOutboundImageSource(direct);
  if (isImageContentType(type) && type) {
    const imageFileSource = stringValue(value.file) ?? stringValue(value.path) ?? stringValue(value.source);
    if (imageFileSource) return normalizeOutboundImageSource(imageFileSource);
  }
  const camelImageUrl = value.imageUrl;
  if (camelImageUrl && typeof camelImageUrl === "object") return normalizeOutboundImageSource(stringValue((camelImageUrl as Record<string, unknown>).url));
  const imageUrl = value.image_url;
  if (typeof imageUrl === "string") return normalizeOutboundImageSource(imageUrl);
  if (imageUrl && typeof imageUrl === "object") return normalizeOutboundImageSource(stringValue((imageUrl as Record<string, unknown>).url));
  return undefined;
}

function filePartFromContentItem(value: Record<string, unknown>, config: OneBotHookConfig, fromText: boolean): ReplyFilePart | undefined {
  if (!config.files.enabled) return undefined;
  const type = stringValue(value.type);
  if (type && !isFileContentType(type)) return undefined;
  const source =
    stringValue(value.filePath) ??
    stringValue(value.fileUrl) ??
    stringValue(value.path) ??
    stringValue(value.file) ??
    (isFileContentType(type) ? stringValue(value.url) ?? stringValue(value.source) : undefined);
  if (!source) return undefined;
  const name = stringValue(value.name) ?? stringValue(value.filename);
  return filePartFromSource(source, name, config, fromText);
}

function filePartsFromText(input: string, config: OneBotHookConfig): ReplyFilePart[] {
  if (!config.files.enabled || !config.files.detectTextPaths) return [];
  const parts: ReplyFilePart[] = [];
  const seen = new Set<string>();
  const pattern = /(^|[\s(["'：:])((?:\/[^\s`"'<>]+|[A-Za-z]:\\[^\s`"'<>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const source = trimPathCandidate(match[2]);
    const part = filePartFromSource(source, undefined, config, true);
    if (!part) continue;
    const key = `${part.file}\n${part.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts;
}

function filePartFromSource(source: string, name: string | undefined, config: OneBotHookConfig, fromText: boolean): ReplyFilePart | undefined {
  const normalizedSource = normalizeFileSource(source);
  if (!normalizedSource) return undefined;
  if (/^https?:\/\//i.test(normalizedSource)) {
    if (fromText) return undefined;
    return { kind: "file", file: normalizedSource, name: name ?? inferFileName(normalizedSource), original: source, sourceText: source };
  }
  if (!isAbsolute(normalizedSource)) {
    return fromText ? undefined : fileFallback(source, name, "file path is not absolute");
  }

  const candidates = localFileCandidates(normalizedSource, config);
  let allowedCandidateSeen = false;
  for (const candidate of candidates) {
    if (!isAllowedLocalFilePath(candidate, config)) continue;
    allowedCandidateSeen = true;
    let info;
    try {
      info = statSync(candidate);
    } catch {
      continue;
    }
    if (!info.isFile()) {
      return fromText ? undefined : fileFallback(source, name, "path is not a regular file");
    }
    if (info.size > config.files.maxFileBytes) {
      return {
        kind: "file",
        file: candidate,
        name: name ?? inferFileName(source),
        original: source,
        sourceText: source,
        size: info.size,
        fallbackReason: `file exceeds maxFileBytes (${config.files.maxFileBytes})`,
      };
    }
    return {
      kind: "file",
      file: candidate,
      name: name ?? inferFileName(source),
      original: source,
      sourceText: source,
      size: info.size,
    };
  }

  if (fromText) return undefined;
  return fileFallback(source, name, allowedCandidateSeen ? "file does not exist" : "file is outside allowed roots");
}

function fileFallback(source: string, name: string | undefined, reason: string): ReplyFilePart {
  return {
    kind: "file",
    file: source,
    name: name ?? inferFileName(source),
    original: source,
    sourceText: source,
    fallbackReason: reason,
  };
}

function normalizeFileSource(source: string): string | undefined {
  const value = source.trim();
  if (!value) return undefined;
  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  if (/^https?:\/\//i.test(value)) return value;
  return expandHome(value);
}

function localFileCandidates(source: string, config: OneBotHookConfig): string[] {
  const base = normalize(resolve(expandHome(source)));
  const candidates = [base];
  for (const mapping of config.files.pathMappings) {
    const from = normalize(resolve(expandHome(mapping.from)));
    const to = normalize(resolve(expandHome(mapping.to)));
    if (!pathStartsWith(base, from)) continue;
    const suffix = base === from ? "" : base.slice(from.length);
    candidates.push(normalize(`${to}${suffix}`));
  }
  return [...new Set(candidates)];
}

function isAllowedLocalFilePath(file: string, config: OneBotHookConfig): boolean {
  const normalizedFile = normalize(resolve(expandHome(file)));
  return config.files.allowedRoots.some((root) => pathStartsWith(normalizedFile, normalize(resolve(expandHome(root)))));
}

function pathStartsWith(value: string, root: string): boolean {
  const lhs = normalize(value);
  const rhs = normalize(root);
  const same = process.platform === "win32" ? lhs.toLowerCase() === rhs.toLowerCase() : lhs === rhs;
  if (same) return true;
  const prefix = rhs.endsWith(sep) ? rhs : `${rhs}${sep}`;
  return process.platform === "win32" ? lhs.toLowerCase().startsWith(prefix.toLowerCase()) : lhs.startsWith(prefix);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return `${homedir()}${value.slice(1)}`;
  return value;
}

function inferFileName(source: string): string {
  try {
    if (/^https?:\/\//i.test(source)) {
      const name = basename(new URL(source).pathname);
      if (name) return name;
    }
    if (/^file:\/\//i.test(source)) return basename(fileURLToPath(source)) || "file";
  } catch {
    // Fall through to path basename.
  }
  return basename(trimPathCandidate(source)) || "file";
}

function trimPathCandidate(value: string): string {
  return value.trim().replace(/[.,，。;；!！?？)\]】》]+$/u, "");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024) return `${Number(size.toFixed(size >= 10 ? 1 : 2))}${unit}`;
    size /= 1024;
  }
  return `${Number(size.toFixed(2))}PB`;
}

export function normalizeOutboundImageSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dataUri = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i.exec(value);
  if (dataUri) return `base64://${dataUri[1].replace(/\s+/g, "")}`;
  if (/^(https?:\/\/|file:\/\/|base64:\/\/)/i.test(value)) return value;
  if (isAbsolute(value)) return pathToFileURL(value).href;
  return value;
}

function isImageContentType(type: string | undefined): boolean {
  return !type || type === "image" || type === "image_url" || type === "input_image" || type === "inputImage" || type === "output_image";
}

function isFileContentType(type: string | undefined): boolean {
  return type === "file" || type === "attachment" || type === "output_file";
}

function isToolInfo(info: { kind?: string }): boolean {
  return (info.kind ?? "").toLowerCase().includes("tool");
}

function hasUsefulLink(text: string): boolean {
  return /https?:\/\/\S+/iu.test(text);
}

function finalImageOrLinkParts(parts: ReplyPart[]): ReplyPart[] {
  const filtered: ReplyPart[] = [];
  for (const part of parts) {
    if (part.kind === "image" || part.kind === "file") {
      filtered.push(part);
      continue;
    }
    const links = part.text.match(/https?:\/\/\S+/giu) ?? [];
    if (links.length) {
      filtered.push({ kind: "text", text: links.join("\n"), rawText: part.rawText });
    }
  }
  return filtered;
}

function summarizeReplyParts(parts: ReplyPart[]): string {
  return parts.map((part) => {
    if (part.kind === "text") return part.text;
    if (part.kind === "image") return `[image:${part.url}]`;
    return `[file:${part.name}]`;
  }).join("");
}

function describeOutgoingMessage(message: OneBotOutgoingMessage): string {
  if (typeof message === "string") return `text_chars=${message.length}`;
  return `segments=${message.map((segment) => segment.type).join(",")}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function appendText(current: string, next: string): string {
  const value = next.trim();
  if (!value) return current;
  if (!current) return value;
  const last = current[current.length - 1];
  const first = value[0];
  if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first)) return `${current} ${value}`;
  return `${current}${value}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
