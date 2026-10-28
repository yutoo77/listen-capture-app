import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { MemoDraft } from "./drafts";

const memo = { id: "memo-1", text: "保存済みの補足" };
const saved = (values: Partial<MemoDraft> = {}): MemoDraft => ({
  userId: "alice",
  memoId: memo.id,
  text: "端末に残した入力",
  baseText: memo.text,
  updatedAt: "2026-10-20T08:00:00.000Z",
  ...values,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
});
async function setup(userId = "alice", initial = [memo]) {
  const { createMemoDraftWorkspace } = await import("./useMemoDrafts");
  const workspace = createMemoDraftWorkspace(userId);
  const notice = vi.fn();
  const changed = vi.fn();
  const dispose = workspace.start(changed, notice);
  workspace.updateMemos(initial);
  return { workspace, notice, changed, dispose };
}

describe("memo draft workspace used by the React hook", () => {
  it("hydrates only known memo IDs and keeps unknown drafts until a later successful list", async () => {
    const { draftStore } = await import("./drafts");
    const original = saved();
    await draftStore.put(original);
    const { workspace } = await setup("alice", []);
    await workspace.settled();
    expect(workspace.draftsRef.current.size).toBe(0);
    expect(await draftStore.list("alice")).toEqual([original]);
    workspace.updateMemos([memo]);
    expect(workspace.draftsRef.current.get(memo.id)).toBe(original.text);
    expect(workspace.states.get(memo.id)).toBe("local");
  });

  it("marks restored base text conflicts without changing server text or discarding input", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(saved({ baseText: "別の古い基準" }));
    const { workspace } = await setup();
    await workspace.settled();
    expect(workspace.conflicts.has(memo.id)).toBe(true);
    expect(workspace.draftsRef.current.get(memo.id)).toBe(saved().text);
    expect((await draftStore.list("alice"))[0].baseText).toBe("別の古い基準");
    expect(memo.text).toBe("保存済みの補足");
  });

  it("conditionally removes a restored server-identical draft, including empty text", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(saved({ text: "", baseText: "以前の文章" }));
    const { workspace } = await setup("alice", [{ ...memo, text: "" }]);
    await workspace.settled();
    expect(workspace.draftsRef.current.size).toBe(0);
    expect(await draftStore.list("alice")).toEqual([]);
  });

  it("preserves new input over a late hydrate and assigns monotonic edit timestamps", async () => {
    const { draftStore } = await import("./drafts");
    const old = saved();
    await draftStore.put(old);
    const loading = deferred<MemoDraft[]>();
    vi.spyOn(draftStore, "list").mockReturnValueOnce(loading.promise);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(old.updatedAt) + 1000);
    const { workspace } = await setup();
    workspace.change(memo, "先に入力した値");
    expect(workspace.draftsRef.current.get(memo.id)).toBe("先に入力した値");
    expect(workspace.states.get(memo.id)).toBe("saving");
    workspace.change(memo, "いちばん新しい入力");
    loading.resolve([old]);
    await workspace.settled();
    const [stored] = await draftStore.list("alice");
    expect(stored.text).toBe("いちばん新しい入力");
    expect(stored.updatedAt).toBe("2026-10-20T08:00:01.001Z");
    expect(workspace.states.get(memo.id)).toBe("local");
  });

  it("keeps quota failures in memory and can persist the next explicit edit", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace, notice } = await setup();
    await workspace.settled();
    vi.spyOn(draftStore, "put").mockRejectedValueOnce(
      new DOMException("Full", "QuotaExceededError"),
    );
    workspace.change(memo, "失いたくない入力");
    await workspace.settled();
    expect(workspace.draftsRef.current.get(memo.id)).toBe("失いたくない入力");
    expect(workspace.states.get(memo.id)).toBe("memory");
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("このタブ内"));
    workspace.change(memo, "次の入力");
    await workspace.settled();
    expect(workspace.states.get(memo.id)).toBe("local");
    expect((await draftStore.list("alice"))[0].text).toBe("次の入力");
  });

  it("an old ACK keeps the newer text and rebases it on our saved server value", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace } = await setup();
    await workspace.settled();
    workspace.change(memo, "送信した文章");
    workspace.change(memo, "ACK待ちの間の新しい入力");
    expect(await workspace.acknowledge(memo.id, "送信した文章")).toBe(true);
    await workspace.settled();
    expect(workspace.draftsRef.current.get(memo.id)).toBe(
      "ACK待ちの間の新しい入力",
    );
    expect((await draftStore.list("alice"))[0]).toMatchObject({
      text: "ACK待ちの間の新しい入力",
      baseText: "送信した文章",
    });
    expect(workspace.conflicts.has(memo.id)).toBe(false);
  });

  it("a server ACK clears matching dirty text even when local cleanup fails", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace, notice } = await setup();
    await workspace.settled();
    workspace.change(memo, "保存した文章");
    await workspace.settled();
    vi.spyOn(draftStore, "compareAndRemove").mockRejectedValueOnce(
      new Error("Disk unavailable"),
    );
    expect(await workspace.acknowledge(memo.id, "保存した文章")).toBe(false);
    expect(workspace.draftsRef.current.has(memo.id)).toBe(false);
    expect(workspace.states.has(memo.id)).toBe(false);
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining("サーバーに保存済み"),
    );
    expect((await draftStore.list("alice"))[0].text).toBe("保存した文章");
    const restored = await setup("alice", [{ ...memo, text: "保存した文章" }]);
    await restored.workspace.settled();
    expect(restored.workspace.draftsRef.current.size).toBe(0);
    expect(await draftStore.list("alice")).toEqual([]);
  });

  it("a cleanup failure after ACK preserves newer memory-only input and its new base", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace } = await setup();
    await workspace.settled();
    workspace.change(memo, "新しい入力");
    await workspace.settled();
    vi.spyOn(draftStore, "compareAndRemove").mockRejectedValueOnce(
      new Error("Cleanup failed"),
    );
    const writes = vi
      .spyOn(draftStore, "put")
      .mockRejectedValueOnce(new Error("Rebase could not persist"));
    expect(await workspace.acknowledge(memo.id, "ACKされた文章")).toBe(false);
    await workspace.settled();
    expect(workspace.draftsRef.current.get(memo.id)).toBe("新しい入力");
    expect(workspace.states.get(memo.id)).toBe("memory");
    expect(writes).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "新しい入力",
        baseText: "ACKされた文章",
      }),
    );
  });

  it("retains live input when a server snapshot happens to match it before an explicit ACK", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace } = await setup();
    await workspace.settled();
    workspace.change(memo, "すでにサーバーへ保存された文章");
    await workspace.settled();
    workspace.updateMemos([
      { ...memo, text: "すでにサーバーへ保存された文章" },
    ]);
    await workspace.settled();
    expect(workspace.draftsRef.current.get(memo.id)).toBe(
      "すでにサーバーへ保存された文章",
    );
    expect((await draftStore.list("alice"))[0].text).toBe(
      "すでにサーバーへ保存された文章",
    );
    expect(
      await workspace.acknowledge(memo.id, "すでにサーバーへ保存された文章"),
    ).toBe(true);
    expect(workspace.draftsRef.current.size).toBe(0);
  });

  it("keeps a newer empty edit equal to the old server value while a PATCH ACK is delayed", async () => {
    const { draftStore } = await import("./drafts");
    const original = { ...memo, text: "" };
    const { workspace } = await setup("alice", [original]);
    await workspace.settled();
    workspace.change(original, "送信中の文章");
    await workspace.settled();
    // The request submitted this value, but its ACK has not reached the client.
    workspace.change(original, "");
    await workspace.settled();
    workspace.updateMemos([original]);
    await workspace.settled();
    expect(workspace.draftsRef.current.has(memo.id)).toBe(true);
    expect(workspace.draftsRef.current.get(memo.id)).toBe("");
    expect(workspace.states.get(memo.id)).toBe("local");
    expect(await workspace.acknowledge(memo.id, "送信中の文章")).toBe(true);
    await workspace.settled();
    expect(workspace.draftsRef.current.has(memo.id)).toBe(true);
    expect(workspace.draftsRef.current.get(memo.id)).toBe("");
    expect((await draftStore.list("alice"))[0]).toMatchObject({
      text: "",
      baseText: "送信中の文章",
    });
  });

  it("drop waits for queued writes and does not erase a subsequent edit", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace } = await setup();
    await workspace.settled();
    const blocked = deferred<void>();
    const original = draftStore.put.bind(draftStore);
    vi.spyOn(draftStore, "put").mockImplementationOnce(async (value) => {
      await blocked.promise;
      await original(value);
    });
    workspace.change(memo, "破棄する入力");
    const drop = workspace.drop(memo.id);
    workspace.change(memo, "破棄処理の後の新しい入力");
    blocked.resolve();
    await drop;
    await workspace.settled();
    expect(workspace.draftsRef.current.get(memo.id)).toBe(
      "破棄処理の後の新しい入力",
    );
    expect((await draftStore.list("alice"))[0].text).toBe(
      "破棄処理の後の新しい入力",
    );
  });

  it("logout cleanup waits for queued writes, blocks late writes and clears only its owner", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(saved({ userId: "bob" }));
    const { workspace } = await setup();
    await workspace.settled();
    const blocked = deferred<void>();
    const original = draftStore.put.bind(draftStore);
    vi.spyOn(draftStore, "put").mockImplementationOnce(async (value) => {
      await blocked.promise;
      await original(value);
    });
    workspace.change(memo, "ログアウト直前の入力");
    const cleanup = workspace.clear();
    workspace.change(memo, "ログアウト後に走った古いcallback");
    blocked.resolve();
    await cleanup;
    await workspace.settled();
    expect(workspace.draftsRef.current.size).toBe(0);
    expect(await draftStore.list("alice")).toEqual([]);
    expect((await draftStore.list("bob"))[0].userId).toBe("bob");
  });

  it("rejects failed logout cleanup while retaining input and allowing an explicit retry", async () => {
    const { draftStore } = await import("./drafts");
    const { workspace } = await setup();
    await workspace.settled();
    workspace.change(memo, "未保存の文章");
    await workspace.settled();
    const failure = new Error("Clear failed");
    vi.spyOn(draftStore, "clear").mockRejectedValueOnce(failure);
    await expect(workspace.clear()).rejects.toBe(failure);
    expect(workspace.draftsRef.current.get(memo.id)).toBe("未保存の文章");
    expect((await draftStore.list("alice"))[0].text).toBe("未保存の文章");
    await workspace.clear();
    expect(await draftStore.list("alice")).toEqual([]);
  });

  it("does not hydrate or notify an old owner after disposal while a different owner is active", async () => {
    const { draftStore } = await import("./drafts");
    const delayed = deferred<MemoDraft[]>();
    vi.spyOn(draftStore, "list").mockReturnValueOnce(delayed.promise);
    const alice = await setup();
    alice.dispose();
    const bob = await setup("bob");
    await bob.workspace.settled();
    delayed.resolve([saved()]);
    await alice.workspace.settled();
    alice.workspace.change(memo, "disposed callback");
    expect(alice.workspace.draftsRef.current.size).toBe(0);
    expect(alice.notice).not.toHaveBeenCalled();
    expect(alice.changed).not.toHaveBeenCalled();
    expect(bob.workspace.draftsRef.current.size).toBe(0);
    expect(await draftStore.list("alice")).toEqual([]);
  });

  it("ignores an earlier setup's late failure after the next setup succeeds", async () => {
    const { draftStore } = await import("./drafts");
    await draftStore.put(saved());
    const delayed = deferred<MemoDraft[]>();
    vi.spyOn(draftStore, "list").mockReturnValueOnce(delayed.promise);
    const old = await setup();
    old.dispose();
    const secondNotice = vi.fn();
    old.workspace.start(vi.fn(), secondNotice);
    await old.workspace.settled();
    delayed.reject(new Error("Earlier setup failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(secondNotice).not.toHaveBeenCalled();
    expect(old.workspace.draftsRef.current.get(memo.id)).toBe(saved().text);
  });
});
