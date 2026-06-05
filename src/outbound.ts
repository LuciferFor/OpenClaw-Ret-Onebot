import type { CapturedReplyTarget, LoggerLike, OneBotHookConfig, OneBotSendData } from "./types.js";
import { collapseDoubleNewlines, markdownToPlain } from "./markdown.js";
import { isOkResponse, OneBotClient } from "./onebot-client.js";

type ReplyPayload = string | { text?: string; body?: string; mediaUrl?: string; mediaUrls?: string[] };

export interface SendAttempt {
  target: CapturedReplyTarget;
  text: string;
  messageId: string;
}

export type SendTextFn = (target: CapturedReplyTarget, text: string) => Promise<string>;

export async function sendTextToCapturedTarget(
  client: OneBotClient,
  config: OneBotHookConfig,
  target: CapturedReplyTarget,
  text: string,
  logger: LoggerLike = {}
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= config.reply.maxRetries; attempt += 1) {
    try {
      const response = target.kind === "group"
        ? await client.sendGroupMsg(target.id, text)
        : await client.sendPrivateMsg(target.id, text);
      if (!isOkResponse(response)) {
        throw new Error(response.wording ?? response.message ?? `retcode=${response.retcode ?? "unknown"}`);
      }
      const data = response.data as OneBotSendData | undefined;
      const messageId = data?.message_id == null ? "" : String(data.message_id);
      logger.info?.(`[onebot-hook] sent ${target.kind}:${target.id} message_id=${messageId || "(none)"}`);
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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  readonly sent: SendAttempt[] = [];

  constructor(
    private readonly config: OneBotHookConfig,
    private readonly target: CapturedReplyTarget,
    private readonly sendText: SendTextFn,
    private readonly logger: LoggerLike = {}
  ) {}

  async deliver(payload: unknown, info: { kind?: string } = {}): Promise<void> {
    const { text, rawText } = this.extractText(payload as ReplyPayload);
    const trimmedRaw = rawText.trim();
    if (!trimmedRaw || trimmedRaw === "NO_REPLY" || trimmedRaw.endsWith("NO_REPLY")) return;

    this.textBuffer = appendText(this.textBuffer, text);
    this.rawBuffer = appendText(this.rawBuffer, trimmedRaw);

    if (this.shouldFlushNow()) {
      await this.queueFlush();
    } else {
      this.scheduleFlush();
    }

    if (info.kind === "final") {
      await this.finish();
    }
  }

  async finish(): Promise<void> {
    this.clearTimer();
    await this.queueFlush();
    await this.flushChain;
  }

  private extractText(payload: ReplyPayload): { text: string; rawText: string } {
    const raw = typeof payload === "string" ? payload : (payload?.text ?? payload?.body ?? "");
    let text = raw.trim();
    if (this.config.reply.markdownToPlain) text = markdownToPlain(text);
    text = collapseDoubleNewlines(text).trim();
    return { text, rawText: raw };
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
    const text = this.textBuffer.trim();
    this.textBuffer = "";
    this.rawBuffer = "";
    if (!text) return;

    const messageId = await this.sendText(this.target, text);
    this.sent.push({ target: this.target, text, messageId });
  }

  private clearTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
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

