import type { OneBotProgressConfig } from "./types.js";

export interface ProgressMessage {
  id: string;
  text: string;
  terminal?: boolean;
}

export function formatProgressAck(config: OneBotProgressConfig): ProgressMessage | null {
  if (!config.enabled || !config.ack) return null;
  return { id: "ack", text: trimProgressText("已收到，正在交给 OpenClaw。", config) };
}

export function formatProgressWait(elapsedMs: number, config: OneBotProgressConfig): ProgressMessage | null {
  if (!config.enabled) return null;
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return { id: `wait:${seconds}`, text: trimProgressText(`还在等模型返回，已等待 ${seconds} 秒。`, config) };
}

export function formatProgressTimeout(runId: string | undefined, waitedMs: number, config: OneBotProgressConfig): ProgressMessage | null {
  if (!config.enabled) return null;
  const seconds = Math.max(1, Math.round(waitedMs / 1000));
  const suffix = runId ? ` run=${shortRunId(runId)}` : "";
  return { id: `timeout:${runId ?? seconds}`, text: trimProgressText(`OpenClaw 等待超时，已等待 ${seconds} 秒。${suffix}`, config), terminal: true };
}

export function formatProgressFailure(reason: unknown, config: OneBotProgressConfig): ProgressMessage | null {
  if (!config.enabled) return null;
  const text = typeof reason === "string" ? reason : reason instanceof Error ? reason.message : String(reason ?? "unknown");
  const detail = trimProgressText(redactIfNeeded(text, config), config);
  return { id: `failure:${detail}`, text: trimProgressText(`OpenClaw 提交失败：${detail}`, config), terminal: true };
}

export function formatTrajectoryProgress(entry: any, config: OneBotProgressConfig): ProgressMessage | null {
  if (!config.enabled || !entry || typeof entry !== "object") return null;
  const type = typeof entry.type === "string" ? entry.type : "";
  const data = entry.data && typeof entry.data === "object" ? entry.data : {};
  const id = progressEventId(entry);

  if (type === "prompt.submitted") {
    if (!config.modelEvents) return null;
    return { id, text: trimProgressText("已提交模型。", config) };
  }

  if (type === "tool.call") {
    if (!config.toolEvents) return null;
    return { id, text: trimProgressText(`正在调用工具：${safeToolName(data.name ?? entry.name, config)}`, config) };
  }

  if (type === "tool.result") {
    if (!config.toolEvents) return null;
    const duration = formatDuration(durationMsFromToolResult(data));
    return { id, text: trimProgressText(`工具完成：${safeToolName(data.name ?? entry.name, config)}${duration}`, config) };
  }

  if (type === "session.error" || type === "model.error") {
    if (!config.modelEvents) return null;
    const reason = errorReason(data, config);
    return { id, text: trimProgressText(`OpenClaw 运行失败${reason ? `：${reason}` : "。"}`, config), terminal: true };
  }

  return null;
}

export function progressEventId(entry: any): string {
  const type = typeof entry?.type === "string" ? entry.type : "event";
  const seq = entry?.sourceSeq ?? entry?.seq;
  if (seq != null) return `${entry?.runId ?? ""}:${type}:${seq}`;
  return `${entry?.runId ?? ""}:${type}:${entry?.data?.toolCallId ?? entry?.data?.itemId ?? entry?.ts ?? entry?.timestamp ?? ""}`;
}

function durationMsFromToolResult(data: any): number | undefined {
  const candidates = [data?.durationMs, data?.result?.durationMs, data?.elapsedMs, data?.result?.elapsedMs];
  for (const value of candidates) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `，耗时 ${Math.round(ms)}ms`;
  return `，耗时 ${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}秒`;
}

function safeToolName(value: unknown, config: OneBotProgressConfig): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "工具";
  return trimProgressText(redactIfNeeded(raw.replace(/[^\p{L}\p{N}_.:-]+/gu, "_"), config), config);
}

function errorReason(data: any, config: OneBotProgressConfig): string {
  const raw = data?.error?.message ?? data?.error ?? data?.promptError ?? data?.message ?? data?.reason;
  if (typeof raw !== "string") return "";
  return trimProgressText(redactIfNeeded(raw, config), config);
}

function trimProgressText(input: string, config: OneBotProgressConfig): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= config.maxTextChars) return compact;
  return `${compact.slice(0, Math.max(0, config.maxTextChars - 1))}…`;
}

function redactIfNeeded(input: string, config: OneBotProgressConfig): string {
  if (!config.redact) return input;
  return input
    .replace(/(authorization|access[_-]?token|api[_-]?key|token|password|secret)\s*[:=]\s*["']?bearer\s+[a-z0-9._~+/=-]{8,}/giu, "$1=<redacted>")
    .replace(/(authorization|access[_-]?token|api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"',\s]+/giu, "$1=<redacted>")
    .replace(/bearer\s+[a-z0-9._~+/=-]{12,}/giu, "Bearer <redacted>")
    .replace(/[a-z0-9_-]{24,}\.[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}/giu, "<redacted-token>");
}

function shortRunId(runId: string): string {
  return runId.length <= 8 ? runId : runId.slice(0, 8);
}
