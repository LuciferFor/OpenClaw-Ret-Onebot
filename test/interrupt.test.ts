import { describe, expect, it } from "vitest";
import { canInterruptRun, formatInterruptGuidance } from "../src/interrupt.js";
import type { OneBotHookConfig } from "../src/types.js";

function interrupt(overrides: Partial<OneBotHookConfig["interrupt"]> = {}): Pick<OneBotHookConfig, "interrupt"> {
  return {
    interrupt: {
      enabled: true,
      mode: "abort_and_resend",
      sameSenderOnly: true,
      debounceMs: 800,
      followupWindowMs: 120_000,
      maxBufferedMessages: 8,
      suppressSupersededReplies: true,
      interruptAfterOutput: false,
      ...overrides,
    },
  };
}

describe("interrupt helpers", () => {
  it("formats the fixed guidance message", () => {
    expect(formatInterruptGuidance(["不对，是白丝", "[image: ref.png]\n[path: /tmp/ref.png]"])).toBe(
      "【用户在上一轮回复生成前追加/更正】\n不对，是白丝\n[image: ref.png]\n[path: /tmp/ref.png]\n\n请以最新补充为准；若与上一条冲突，忽略上一条冲突部分。",
    );
  });

  it("allows same-sender active runs before output", () => {
    expect(canInterruptRun(interrupt(), { senderId: "user:10001", startedAt: 1000 }, "user:10001", 2000)).toBe(true);
  });

  it("rejects different senders, expired windows, and already-output runs by default", () => {
    expect(canInterruptRun(interrupt(), { senderId: "user:10001", startedAt: 1000 }, "user:20002", 2000)).toBe(false);
    expect(canInterruptRun(interrupt(), { senderId: "user:10001", startedAt: 1000 }, "user:10001", 122_001)).toBe(false);
    expect(canInterruptRun(interrupt(), { senderId: "user:10001", startedAt: 1000, hasForwardedOutput: true }, "user:10001", 2000)).toBe(false);
  });

  it("honors disabled and output override switches", () => {
    expect(canInterruptRun(interrupt({ enabled: false }), { senderId: "user:10001", startedAt: 1000 }, "user:10001", 2000)).toBe(false);
    expect(
      canInterruptRun(interrupt({ interruptAfterOutput: true }), { senderId: "user:10001", startedAt: 1000, hasForwardedOutput: true }, "user:10001", 2000),
    ).toBe(true);
  });
});
