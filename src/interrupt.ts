import type { OneBotHookConfig } from "./types.js";

export interface ActiveRunSnapshot {
  senderId?: string;
  startedAt: number;
  hasForwardedOutput?: boolean;
  superseded?: boolean;
  finished?: boolean;
}

const INTERRUPT_HEADER = "【用户在上一轮回复生成前追加/更正】";
const INTERRUPT_FOOTER = "请以最新补充为准；若与上一条冲突，忽略上一条冲突部分。";

export function formatInterruptGuidance(messages: string[]): string {
  const body = messages
    .map((message) => message.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return `${INTERRUPT_HEADER}\n${body}\n\n${INTERRUPT_FOOTER}`;
}

export function canInterruptRun(
  config: Pick<OneBotHookConfig, "interrupt">,
  run: ActiveRunSnapshot | undefined,
  senderId: string | undefined,
  now = Date.now(),
): boolean {
  if (!config.interrupt.enabled || config.interrupt.mode !== "abort_and_resend") return false;
  if (!run || run.finished || run.superseded) return false;
  if (config.interrupt.sameSenderOnly && (!senderId || run.senderId !== senderId)) return false;
  if (!config.interrupt.interruptAfterOutput && run.hasForwardedOutput) return false;
  return now - run.startedAt <= config.interrupt.followupWindowMs;
}
