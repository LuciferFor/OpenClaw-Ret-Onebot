import { describe, expect, it } from "vitest";
import {
  formatProgressAck,
  formatProgressFailure,
  formatProgressTimeout,
  formatProgressWait,
  formatTrajectoryProgress,
  progressEventId,
} from "../src/progress.js";
import type { OneBotProgressConfig } from "../src/types.js";

const progress: OneBotProgressConfig = {
  enabled: true,
  ack: true,
  firstDelayMs: 30_000,
  intervalMs: 60_000,
  toolEvents: true,
  modelEvents: true,
  target: "same_conversation",
  group: "triggered_only",
  redact: true,
  maxTextChars: 120,
};

describe("progress receipts", () => {
  it("formats ack and waiting receipts", () => {
    expect(formatProgressAck(progress)?.text).toBe("已收到，正在交给 OpenClaw。");
    expect(formatProgressWait(30_200, progress)?.text).toBe("还在等模型返回，已等待 30 秒。");
  });

  it("formats concise trajectory events", () => {
    expect(formatTrajectoryProgress({ type: "prompt.submitted", runId: "r1", seq: 1 }, progress)?.text).toBe("已提交模型。");
    expect(formatTrajectoryProgress({ type: "tool.call", runId: "r1", seq: 2, data: { name: "web_search" } }, progress)?.text).toBe("正在调用工具：web_search");
    expect(formatTrajectoryProgress({ type: "tool.result", runId: "r1", seq: 3, data: { name: "web_search", result: { durationMs: 1530 } } }, progress)?.text).toBe("工具完成：web_search，耗时 1.5秒");
  });

  it("does not forward hidden reasoning, tool arguments, or tool output", () => {
    const entry = {
      type: "tool.call",
      runId: "r1",
      seq: 4,
      data: {
        name: "bash",
        arguments: { command: "curl -H Authorization=Bearer abc.def.ghi https://example.test" },
        output: "secret-token-value",
      },
    };

    const text = formatTrajectoryProgress(entry, progress)?.text ?? "";
    expect(text).toBe("正在调用工具：bash");
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("secret-token-value");
  });

  it("redacts and trims failure and timeout receipts", () => {
    const failure = formatProgressFailure("Authorization=Bearer abcdefghijklmnopqrstuvwxyz1234567890", { ...progress, maxTextChars: 60 });
    expect(failure?.text).toContain("<redacted>");
    expect(failure?.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(failure?.text.length).toBeLessThanOrEqual(60);
    expect(formatProgressTimeout("2cc46c67-2ff1-48c5-af25-6ef89c63ced3", 600_000, progress)?.text).toBe("OpenClaw 等待超时，已等待 600 秒。 run=2cc46c67");
  });

  it("provides stable ids for repeated scans", () => {
    const entry = { type: "tool.result", runId: "r1", seq: 8, data: { name: "web_search" } };
    expect(progressEventId(entry)).toBe(progressEventId({ ...entry, data: { name: "web_search", ignored: "new" } }));
  });

  it("respects disabled event classes", () => {
    expect(formatProgressAck({ ...progress, ack: false })).toBeNull();
    expect(formatTrajectoryProgress({ type: "tool.call", data: { name: "bash" } }, { ...progress, toolEvents: false })).toBeNull();
    expect(formatTrajectoryProgress({ type: "prompt.submitted" }, { ...progress, modelEvents: false })).toBeNull();
  });
});
