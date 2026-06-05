import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { CapturedReplyTarget, LoggerLike, OneBotHookConfig, OneBotMessageSegment, OneBotOutgoingMessage, OneBotSendData } from "./types.js";
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
  url?: unknown;
  file?: unknown;
  path?: unknown;
  source?: unknown;
};

type ReplyPart = { kind: "text"; text: string; rawText: string } | { kind: "image"; url: string; alt?: string };

export interface SendAttempt {
  target: CapturedReplyTarget;
  text: string;
  message: OneBotOutgoingMessage;
  messageId: string;
}

export type SendMessageFn = (target: CapturedReplyTarget, message: OneBotOutgoingMessage) => Promise<string>;
export type SendTextFn = (target: CapturedReplyTarget, text: string) => Promise<string>;

export interface ReplyChunkSenderOptions {
  noReplyFallback?: string;
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

export class ReplyChunkSender {
  private textBuffer = "";
  private rawBuffer = "";
  private partsBuffer: ReplyPart[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private imageCount = 0;
  private seenImageUrls = new Set<string>();
  private noReplySeen = false;
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
    const parts = this.extractParts(payload as ReplyPayload, { mediaOnly: toolInfo });
    if (parts.length === 0) return;
    if (isNoReply(parts)) {
      this.noReplySeen = true;
      return;
    }

    for (const part of parts) {
      if (part.kind === "text") {
        this.textBuffer = appendText(this.textBuffer, part.text);
        this.rawBuffer = appendText(this.rawBuffer, part.rawText);
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
    if (this.shouldSendNoReplyFallback()) {
      this.textBuffer = this.options.noReplyFallback!.trim();
      this.rawBuffer = this.options.noReplyFallback!.trim();
      this.noReplySeen = false;
    }
    await this.queueFlush();
    await this.flushChain;
  }

  private extractParts(payload: ReplyPayload, opts: { mediaOnly?: boolean } = {}): ReplyPart[] {
    if (typeof payload === "string") return opts.mediaOnly ? [] : this.extractTextAndMarkdownImages(payload);
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
    return parts;
  }

  private extractContentParts(content: unknown[], opts: { mediaOnly?: boolean } = {}): ReplyPart[] {
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
        if (!opts.mediaOnly) parts.push(...this.extractTextAndMarkdownImages(stringValue(value.text) ?? ""));
        continue;
      }
      const imageUrl = imageUrlFromContentItem(value);
      if (imageUrl && isImageContentType(type)) {
        parts.push({ kind: "image", url: imageUrl, alt: stringValue(value.alt) });
      }
      if (Array.isArray(value.content)) parts.push(...this.extractContentParts(value.content, opts));
      if (Array.isArray(value.contentItems)) parts.push(...this.extractContentParts(value.contentItems, opts));
    }
    return parts;
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

  private shouldSendNoReplyFallback(): boolean {
    const fallback = this.options.noReplyFallback?.trim();
    if (!fallback) return false;
    if (!this.noReplySeen) return false;
    if (this.sent.length > 0) return false;
    if (this.textBuffer.trim() || this.rawBuffer.trim() || this.partsBuffer.length > 0) return false;
    return true;
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
    segments.push({ type: "image", data: { file: normalizeOutboundImageSource(part.url), ...(part.alt ? { summary: part.alt } : {}) } });
  }
  return segments;
}

function isNoReply(parts: ReplyPart[]): boolean {
  const hasImage = parts.some((part) => part.kind === "image");
  if (hasImage) return false;
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
  const direct =
    stringValue(value.url) ??
    stringValue(value.imageUrl) ??
    stringValue(value.file) ??
    stringValue(value.path) ??
    stringValue(value.source) ??
    stringValue(value.mediaUrl) ??
    stringValue(value.dataUri);
  if (direct) return normalizeOutboundImageSource(direct);
  const camelImageUrl = value.imageUrl;
  if (camelImageUrl && typeof camelImageUrl === "object") return normalizeOutboundImageSource(stringValue((camelImageUrl as Record<string, unknown>).url));
  const imageUrl = value.image_url;
  if (typeof imageUrl === "string") return normalizeOutboundImageSource(imageUrl);
  if (imageUrl && typeof imageUrl === "object") return normalizeOutboundImageSource(stringValue((imageUrl as Record<string, unknown>).url));
  return undefined;
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

function isToolInfo(info: { kind?: string }): boolean {
  return (info.kind ?? "").toLowerCase().includes("tool");
}

function summarizeReplyParts(parts: ReplyPart[]): string {
  return parts.map((part) => part.kind === "text" ? part.text : `[image:${part.url}]`).join("");
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
