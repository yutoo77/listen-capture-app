import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBObjectStore } from "fake-indexeddb";
import type { MemoDraft } from "./drafts";

let factory = new IDBFactory();
const first = "2026-10-20T08:00:00.000Z";
const second = "2026-10-20T08:00:01.000Z";
function draft(values: Partial<MemoDraft> = {}): MemoDraft {
  return {
    userId: "alice",
    memoId: "memo-1",
    text: "まだ保存していない考え。",
    baseText: "サーバーで確認した補足。",
    updatedAt: first,
    ...values,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
});

describe("owner scoped memo drafts", () => {
  it("restores text, base text and metadata after reopening the module", async () => {
    const { draftStore } = await import("./drafts");
    const original = draft();
    await draftStore.put(original);
    vi.resetModules();
    const reopened = await import("./drafts");
    expect(await reopened.draftStore.list("alice")).toEqual([original]);
    expect(await reopened.draftStore.list("bob")).toEqual([]);
  });

  it("keeps the same memo ID independent for different owners", async () => {
    const { draftStore } = await import("./drafts");
    const alice = draft();
    const bob = draft({ userId: "bob", text: "別の利用者の補足。" });
    await draftStore.put(alice);
    await draftStore.put(bob);
    expect(await draftStore.list("alice")).toEqual([alice]);
    expect(await draftStore.list("bob")).toEqual([bob]);
    await draftStore.remove("alice", "memo-1");
    expect(await draftStore.list("alice")).toEqual([]);
    expect(await draftStore.list("bob")).toEqual([bob]);
  });

  it("clears only one owner's drafts, retaining other owners and audio outbox", async () => {
    const { draftStore } = await import("./drafts");
    const { outbox } = await import("./outbox");
    const audio = {
      userId: "alice",
      clientId: "voice-1",
      audioVersion: "audio-1",
      documentId: "doc-1",
      documentTitle: "教材",
      positionMs: 12000,
      durationMs: 1000,
      blob: new Blob(["private-voice"]),
      createdAt: first,
      text: "",
    };
    await outbox.put(audio);
    await draftStore.put(draft());
    await draftStore.put(draft({ memoId: "memo-2" }));
    const bob = draft({ userId: "bob" });
    await draftStore.put(bob);
    await draftStore.clear("alice");
    await draftStore.clear("nonexistent");
    expect(await draftStore.list("alice")).toEqual([]);
    expect(await draftStore.list("bob")).toEqual([bob]);
    const [voice] = await outbox.list("alice");
    expect(voice.clientId).toBe(audio.clientId);
    expect(await voice.blob.text()).toBe("private-voice");
    expect((await factory.databases()).map((db) => db.name).sort()).toEqual([
      "listen-capture-memo-drafts-v1",
      "listen-capture-outbox-v1",
    ]);
  });

  it("preserves an empty string as an intentional unsaved edit", async () => {
    const { draftStore } = await import("./drafts");
    const empty = draft({ text: "", baseText: "消したい文章" });
    await draftStore.put(empty);
    expect(await draftStore.list("alice")).toEqual([empty]);
    expect(
      await draftStore.compareAndRemove("alice", "memo-1", "消したい文章"),
    ).toBe(false);
    expect(await draftStore.compareAndRemove("alice", "memo-1", "")).toBe(true);
    expect(await draftStore.list("alice")).toEqual([]);
  });

  it("takes a snapshot before opening storage and does not retain caller references", async () => {
    const { draftStore } = await import("./drafts");
    const original = draft();
    const saved = { ...original };
    const pending = draftStore.put(original);
    original.userId = "bob";
    original.text = "後から変えた値";
    original.updatedAt = second;
    await pending;
    expect(await draftStore.list("alice")).toEqual([saved]);
    expect(await draftStore.list("bob")).toEqual([]);
  });

  it("refuses older writes without replacing a newer draft or its base text", async () => {
    const { draftStore } = await import("./drafts");
    const newer = draft({
      text: "新しい入力",
      baseText: "新しい基準",
      updatedAt: second,
    });
    await draftStore.put(newer);
    await expect(draftStore.put(draft())).rejects.toThrow("新しい下書き");
    expect(await draftStore.list("alice")).toEqual([newer]);
  });

  it("serializes writes across connections and lets a same-time later write win", async () => {
    const { draftStore: one } = await import("./drafts");
    await one.list("alice");
    vi.resetModules();
    const { draftStore: two } = await import("./drafts");
    await two.list("alice");
    const newer = draft({ text: "新しい入力", updatedAt: second });
    const firstWrites = await Promise.allSettled([
      one.put(newer),
      two.put(draft()),
    ]);
    expect(firstWrites.map((write) => write.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await one.list("alice")).toEqual([newer]);
    const last = draft({ text: "同じ時刻の最後の入力", updatedAt: second });
    await Promise.all([one.put(newer), two.put(last)]);
    expect(await one.list("alice")).toEqual([last]);
  });

  it("atomically ignores an old ACK while another connection queues a newer edit", async () => {
    const { draftStore: one } = await import("./drafts");
    await one.put(draft());
    vi.resetModules();
    const { draftStore: two } = await import("./drafts");
    await two.list("alice");
    const newer = draft({
      text: "ACKを待つ間に追加した入力",
      updatedAt: second,
    });
    const results = await Promise.all([
      two.put(newer),
      one.compareAndRemove("alice", "memo-1", draft().text),
    ]);
    expect(results[1]).toBe(false);
    expect(await one.list("alice")).toEqual([newer]);
  });

  it("only removes the expected owner's matching text after an ACK", async () => {
    const { draftStore } = await import("./drafts");
    const alice = draft();
    const bob = draft({ userId: "bob" });
    await draftStore.put(alice);
    await draftStore.put(bob);
    expect(
      await draftStore.compareAndRemove("alice", "memo-1", "古い文章"),
    ).toBe(false);
    expect(
      await draftStore.compareAndRemove("alice", "absent", alice.text),
    ).toBe(false);
    expect(
      await draftStore.compareAndRemove("alice", "memo-1", alice.text),
    ).toBe(true);
    expect(await draftStore.list("alice")).toEqual([]);
    expect(await draftStore.list("bob")).toEqual([bob]);
  });

  it("sorts the latest edits first and normalizes a UTC timestamp without fractions", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(
      draft({ memoId: "older", updatedAt: "2026-10-20T08:00:00Z" }),
    );
    await draftStore.put(draft({ memoId: "newer", updatedAt: second }));
    expect(
      (await draftStore.list("alice")).map((entry) => [
        entry.memoId,
        entry.updatedAt,
      ]),
    ).toEqual([
      ["newer", second],
      ["older", first],
    ]);
  });

  it("accepts the exact text limit without trimming whitespace or Japanese text", async () => {
    const { draftStore } = await import("./drafts");
    const full = draft({ text: "あ".repeat(10_000), baseText: "" });
    await draftStore.put(full);
    expect(await draftStore.list("alice")).toEqual([full]);
    await draftStore.put(draft({ text: " \n\t ", updatedAt: second }));
    expect((await draftStore.list("alice"))[0].text).toBe(" \n\t ");
  });

  it("rejects malformed IDs, text and timestamps before opening the database", async () => {
    const { draftStore } = await import("./drafts");
    const opening = vi.spyOn(factory, "open");
    for (const id of ["", " alice", "../bob", "a\0", "x".repeat(129)]) {
      await expect(draftStore.put(draft({ userId: id }))).rejects.toThrow();
      await expect(draftStore.put(draft({ memoId: id }))).rejects.toThrow();
      await expect(draftStore.list(id)).rejects.toThrow();
      await expect(draftStore.remove("alice", id)).rejects.toThrow();
      await expect(draftStore.clear(id)).rejects.toThrow();
      await expect(
        draftStore.compareAndRemove(id, "memo-1", ""),
      ).rejects.toThrow();
    }
    for (const text of ["\0", "a".repeat(10_001)]) {
      await expect(draftStore.put(draft({ text }))).rejects.toThrow();
      await expect(draftStore.put(draft({ baseText: text }))).rejects.toThrow();
      await expect(
        draftStore.compareAndRemove("alice", "memo-1", text),
      ).rejects.toThrow();
    }
    for (const updatedAt of [
      "",
      "invalid",
      "2026-02-30T08:00:00.000Z",
      "2026-10-20",
      "2026-10-20T08:00:00+09:00",
    ]) {
      await expect(draftStore.put(draft({ updatedAt }))).rejects.toThrow();
    }
    expect(opening).not.toHaveBeenCalled();
  });

  it("does not resolve a write before transaction commit", async () => {
    const { draftStore } = await import("./drafts");
    const put = IDBObjectStore.prototype.put;
    let settled = false;
    const observed: boolean[] = [];
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = put.apply(this, args);
      request.addEventListener("success", () =>
        queueMicrotask(() => observed.push(settled)),
      );
      return request;
    });
    await draftStore.put(draft()).then(() => {
      settled = true;
    });
    expect(observed).toEqual([false]);
    expect(await draftStore.list("alice")).toEqual([draft()]);
  });

  it("rejects an aborted write after request success and preserves the older row", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(draft());
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = put.apply(this, args);
        request.addEventListener("success", () => this.transaction.abort());
        return request;
      });
    await expect(
      draftStore.put(draft({ text: "書込み中断", updatedAt: second })),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(await draftStore.list("alice")).toEqual([draft()]);
  });

  it("rejects conditional deletion if its transaction aborts instead of claiming ACK cleanup", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(draft());
    const remove = IDBObjectStore.prototype.delete;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "delete")
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = remove.apply(this, args);
        request.addEventListener("success", () => this.transaction.abort());
        return request;
      });
    await expect(
      draftStore.compareAndRemove("alice", "memo-1", draft().text),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(await draftStore.list("alice")).toEqual([draft()]);
  });

  it("propagates quota failures from a queued write and remains usable afterward", async () => {
    const { draftStore } = await import("./drafts");
    const quota = new DOMException("No storage left", "QuotaExceededError");
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw quota;
    });
    await expect(draftStore.put(draft())).rejects.toBe(quota);
    expect(await draftStore.list("alice")).toEqual([]);
    await draftStore.put(draft());
    expect(await draftStore.list("alice")).toEqual([draft()]);
  });

  it("does not drop stored drafts if a read transaction fails", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(draft());
    const getAll = IDBIndex.prototype.getAll;
    const spy = vi
      .spyOn(IDBIndex.prototype, "getAll")
      .mockImplementation(function (this: IDBIndex, ...args) {
        const request = getAll.apply(this, args);
        request.addEventListener("success", () =>
          this.objectStore.transaction.abort(),
        );
        return request;
      });
    await expect(draftStore.list("alice")).rejects.toThrow();
    spy.mockRestore();
    expect(await draftStore.list("alice")).toEqual([draft()]);
  });

  it("rejects blocked opens, closes a late connection, and permits an explicit retry", async () => {
    const { draftStore } = await import("./drafts");
    const close = vi.fn();
    const request = { result: { close } } as unknown as IDBOpenDBRequest;
    vi.spyOn(factory, "open").mockReturnValueOnce(request);
    const attempt = draftStore.list("alice");
    request.onblocked!.call(
      request,
      new Event("blocked") as IDBVersionChangeEvent,
    );
    await expect(attempt).rejects.toThrow("保存領域");
    request.onsuccess!.call(request, new Event("success"));
    expect(close).toHaveBeenCalledOnce();
    expect(await draftStore.list("alice")).toEqual([]);
  });
});
