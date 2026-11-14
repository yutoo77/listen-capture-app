import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { PendingMemo } from "./types";

function recording(userId = "alice", clientId = "one"): PendingMemo {
  return {
    userId,
    clientId,
    audioVersion: "audio-1",
    documentId: "doc-1",
    documentTitle: "自分の資料",
    positionMs: 12500,
    durationMs: 900,
    blob: new Blob(["voice"], { type: "audio/webm" }),
    createdAt: "2026-10-17T00:00:00Z",
    text: "",
  };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
});
describe("durable recording outbox", () => {
  it("roundtrips the audio bytes and original anchor after re-opening", async () => {
    const { outbox } = await import("./outbox");
    const original = recording();
    await outbox.put(original);
    vi.resetModules();
    const reopened = await import("./outbox");
    const [saved] = await reopened.outbox.list("alice");
    expect(saved.positionMs).toBe(12500);
    expect(saved.audioVersion).toBe("audio-1");
    expect(await saved.blob.text()).toBe("voice");
  });
  it("lists, deletes and retries only within the matching account", async () => {
    const { outbox, assertOutboxOwner } = await import("./outbox");
    await outbox.put(recording());
    await outbox.put(recording("bob"));
    expect(await outbox.list("alice")).toHaveLength(1);
    expect(await outbox.list("bob")).toHaveLength(1);
    expect(() => assertOutboxOwner(recording("bob"), "alice")).toThrow(
      "別のアカウント",
    );
    await outbox.remove("alice", "one");
    expect(await outbox.list("alice")).toHaveLength(0);
    expect(await outbox.list("bob")).toHaveLength(1);
  });
  it("deduplicates the same client UUID locally without dropping a different recording", async () => {
    const { outbox } = await import("./outbox");
    await outbox.put(recording());
    await outbox.put(recording());
    await outbox.put(recording("alice", "two"));
    expect(await outbox.list("alice")).toHaveLength(2);
  });
  it("does not claim durability when the transaction aborts after request success", async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    const { outbox } = await import("./outbox");
    await expect(outbox.put(recording())).rejects.toThrow();
    expect(await outbox.list("alice")).toEqual([]);
  });
});
