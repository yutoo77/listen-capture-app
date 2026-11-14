import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canApplyGeneration,
  characterCount,
  generationFailure,
  GenerationIntents,
  GenerationPoller,
  restoreGenerationJob,
} from "./generation";
import type { GenerationJob } from "./types";

const job = (
  id = "first",
  state: GenerationJob["state"] = "queued",
): GenerationJob => ({
  id,
  client_id: "intent",
  document_version: "version",
  state,
  audio_version: state === "succeeded" ? "audio" : null,
  error_code: null,
  created_at: "",
  updated_at: "",
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("generation status polling", () => {
  it("polls queued/running and stops on completion without generating or playing audio", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce(job("first", "running"))
      .mockResolvedValueOnce(job("first", "succeeded"));
    const receive = vi.fn();
    const expired = vi.fn();
    const poller = new GenerationPoller({
      read,
      receive,
      expired,
      failed: vi.fn(),
      visible: () => true,
    });
    poller.start("first");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(receive).toHaveBeenCalledTimes(3);
    expect(expired).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not poll hidden pages and resumes only when visible", async () => {
    let visible = false;
    const read = vi.fn().mockResolvedValue(job());
    const poller = new GenerationPoller({
      read,
      receive: vi.fn(),
      expired: vi.fn(),
      failed: vi.fn(),
      visible: () => visible,
    });
    poller.start("first");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(read).not.toHaveBeenCalled();
    visible = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    visible = false;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledOnce();
    poller.stop();
  });
  it("aborts an in-flight status read when the page is hidden", async () => {
    let visible = true;
    let signal: AbortSignal;
    const read = vi.fn((_id: string, activeSignal: AbortSignal) => {
      signal = activeSignal;
      return new Promise<GenerationJob>((_resolve, reject) =>
        activeSignal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    });
    const failed = vi.fn();
    const poller = new GenerationPoller({
      read,
      failed,
      receive: vi.fn(),
      expired: vi.fn(),
      visible: () => visible,
    });
    poller.start("first");
    visible = false;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal!.aborted).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    poller.stop();
  });
  it("ignores a late result after switching to a different document job", async () => {
    let resolveFirst!: (job: GenerationJob) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GenerationJob>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(job("second", "succeeded"));
    const receive = vi.fn();
    const poller = new GenerationPoller({
      read,
      receive,
      expired: vi.fn(),
      failed: vi.fn(),
      visible: () => true,
    });
    poller.start("first");
    poller.start("second");
    await vi.advanceTimersByTimeAsync(0);
    resolveFirst(job("first", "succeeded"));
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0][0].id).toBe("second");
  });
  it("stops after a wall-clock budget and leaves a deliberate status refresh to the user", async () => {
    const read = vi.fn().mockResolvedValue(job());
    const expired = vi.fn();
    const poller = new GenerationPoller({
      read,
      expired,
      receive: vi.fn(),
      failed: vi.fn(),
      visible: () => true,
    });
    poller.start("first");
    await vi.advanceTimersByTimeAsync(180_000);
    const calls = read.mock.calls.length;
    expect(expired).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not automatically retry a failed status request or a terminal failed job", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"));
    const failed = vi.fn();
    const poller = new GenerationPoller({
      read,
      failed,
      expired: vi.fn(),
      receive: vi.fn(),
      visible: () => true,
    });
    poller.start("first");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    read.mockResolvedValue(job("second", "failed"));
    poller.start("second");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
describe("generation result safety", () => {
  it("does not replace an uncertain retry intention with an older failed job after reload", () => {
    const oldFailure = { ...job("old", "failed"), client_id: "old-intention" };
    const pendingIntention = "new-uncertain-intention";
    expect(restoreGenerationJob(oldFailure, pendingIntention)).toBeNull();
    const sameRequestReplay = {
      ...job("new", "failed"),
      client_id: pendingIntention,
    };
    expect(restoreGenerationJob(sameRequestReplay, pendingIntention)).toBe(
      sameRequestReplay,
    );
    expect(restoreGenerationJob(oldFailure)).toBe(oldFailure);
    const activeReusedJob = job("reused", "running");
    expect(restoreGenerationJob(activeReusedJob, pendingIntention)).toBe(
      activeReusedJob,
    );
  });
  it("restores an uncertain intention after reloading the same tab without crossing accounts or versions", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const id = "2b5bc828-10c2-49fa-88cf-134a41163f96";
    const first = new GenerationIntents("alice", storage);
    first.set("v1", id);
    const reloaded = new GenerationIntents("alice", storage);
    expect(reloaded.get("v1")).toBe(id);
    expect(reloaded.has("v2")).toBe(false);
    expect(new GenerationIntents("bob", storage).get("v1")).toBeUndefined();
  });
  it("keeps the current intention in memory when browser storage is denied", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const intents = new GenerationIntents("alice", storage);
    intents.set("version", "2b5bc828-10c2-49fa-88cf-134a41163f96");
    expect(intents.get("version")).toBe("2b5bc828-10c2-49fa-88cf-134a41163f96");
  });
  it("counts Unicode code points instead of UTF-16 units for the 3000 character limit", () => {
    expect(characterCount("日本語😀𠮷")).toBe(5);
    expect(characterCount("😀".repeat(3000))).toBe(3000);
  });
  it("refuses to switch a recording source, a different version, document or tab", () => {
    expect(canApplyGeneration("doc", "v1", "doc", "v1", "idle", "listen")).toBe(
      true,
    );
    expect(
      canApplyGeneration("doc", "v1", "doc", "v1", "recording", "listen"),
    ).toBe(false);
    expect(canApplyGeneration("doc", "v1", "doc", "v2", "idle", "listen")).toBe(
      false,
    );
    expect(
      canApplyGeneration("doc", "v1", "another", "v1", "idle", "listen"),
    ).toBe(false);
    expect(canApplyGeneration("doc", "v1", "doc", "v1", "idle", "memos")).toBe(
      false,
    );
  });
  it("explains an ambiguous provider outcome without exposing unknown provider errors", () => {
    expect(generationFailure("execution_unknown")).toContain(
      "課金が発生した可能性",
    );
    expect(generationFailure("execution_unknown")).toContain(
      "自動で再試行しません",
    );
    expect(generationFailure("secret/raw/provider/error")).not.toContain(
      "secret/raw",
    );
  });
});
