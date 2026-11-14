import { useEffect, useMemo, useRef, useState } from "react";
import { draftStore, type MemoDraft } from "./drafts";
import type { Memo } from "./types";

export type MemoDraftState = "saving" | "local" | "memory";
type SourceMemo = Pick<Memo, "id" | "text">;

// The small coordinator keeps asynchronous storage ordering independent from
// React rendering. Tests use the same implementation with real fake-indexeddb.
export function createMemoDraftWorkspace(userId: string) {
  const draftsRef = { current: new Map<string, string>() };
  const states = new Map<string, MemoDraftState>();
  const conflicts = new Set<string>();
  const records = new Map<string, MemoDraft>();
  const waiting = new Map<string, MemoDraft>();
  const touched = new Set<string>();
  let memos = new Map<string, SourceMemo>();
  let active = false;
  let clearing = false;
  let epoch = 0;
  let clock = 0;
  let notify = () => {};
  let notice: (message: string) => void = () => {};
  let writes = Promise.resolve();
  let loading = Promise.resolve();
  const publish = () => {
    if (active) notify();
  };
  const warn = (message: string) => {
    if (active) notice(message);
  };
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const task = writes.then(action);
    // Public operations handle their own errors; a failure must not poison the
    // queue and prevent a later explicit write or logout cleanup.
    writes = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  function stamp(previous?: MemoDraft) {
    clock = Math.max(
      Date.now(),
      clock + 1,
      previous ? Date.parse(previous.updatedAt) + 1 : 0,
    );
    return new Date(clock).toISOString();
  }
  function erase(id: string) {
    records.delete(id);
    draftsRef.current.delete(id);
    states.delete(id);
    conflicts.delete(id);
  }
  function install(record: MemoDraft, state: MemoDraftState) {
    records.set(record.memoId, record);
    draftsRef.current.set(record.memoId, record.text);
    states.set(record.memoId, state);
    const source = memos.get(record.memoId);
    if (source && source.text !== record.baseText) conflicts.add(record.memoId);
    else conflicts.delete(record.memoId);
  }
  function persist(record: MemoDraft) {
    void enqueue(async () => {
      try {
        await draftStore.put(record);
        if (records.get(record.memoId) !== record) return;
        // Equality to a snapshot is not a write ACK: a PATCH with a different
        // submitted value may still be in flight when the user edits back.
        states.set(record.memoId, "local");
      } catch {
        if (records.get(record.memoId) === record)
          states.set(record.memoId, "memory");
        warn(
          "補足を端末内へ保存できません。このタブ内には残っています。タブを閉じずにサーバーへ保存してください。",
        );
      }
      publish();
    });
  }
  function reconcile() {
    if (!active || clearing) return;
    let changed = false;
    for (const [id, record] of waiting) {
      if (touched.has(id)) {
        waiting.delete(id);
        continue;
      }
      const source = memos.get(id);
      if (!source) continue; // Unknown IDs or a failed/empty API list are not deletion evidence.
      waiting.delete(id);
      if (source.text === record.text) {
        touched.add(id);
        void enqueue(() =>
          draftStore.compareAndRemove(userId, id, record.text),
        ).catch(() => {
          warn(
            "サーバーと同じ補足の端末記録を削除できませんでした。サーバーの文章は変更していません。",
          );
        });
      } else {
        install(record, "local");
        changed = true;
      }
    }
    for (const [id, record] of records) {
      const source = memos.get(id);
      if (!source) continue;
      const conflict = source.text !== record.baseText;
      if (conflict !== conflicts.has(id)) {
        if (conflict) conflicts.add(id);
        else conflicts.delete(id);
        changed = true;
      }
    }
    if (changed) publish();
  }
  function start(onChange: () => void, onNotice: (message: string) => void) {
    active = true;
    notify = onChange;
    notice = onNotice;
    const generation = ++epoch;
    loading = draftStore
      .list(userId)
      .then((items) => {
        if (!active || generation !== epoch || clearing) return;
        for (const item of items)
          if (!touched.has(item.memoId)) waiting.set(item.memoId, item);
        reconcile();
      })
      .catch(() => {
        if (active && generation === epoch)
          warn(
            "端末内の補足を復元できませんでした。新しい入力はこのタブ内に残せます。",
          );
      });
    return () => {
      if (generation !== epoch) return;
      active = false;
      epoch++;
    };
  }
  function change(memo: SourceMemo, text: string) {
    if (!active || clearing) return;
    const previous = records.get(memo.id);
    touched.add(memo.id);
    waiting.delete(memo.id);
    memos.set(memo.id, memo);
    const next: MemoDraft = {
      userId,
      memoId: memo.id,
      text,
      baseText: previous?.baseText ?? memo.text,
      updatedAt: stamp(previous),
    };
    install(next, "saving");
    publish();
    persist(next);
  }
  async function acknowledge(memoId: string, text: string): Promise<boolean> {
    touched.add(memoId);
    waiting.delete(memoId);
    let cleanupSucceeded = true;
    try {
      await enqueue(() => draftStore.compareAndRemove(userId, memoId, text));
    } catch {
      cleanupSucceeded = false;
      warn(
        "補足はサーバーに保存済みです。端末の下書き記録を整理できませんでした。新しい入力はこのタブに残しています。",
      );
    }
    const current = records.get(memoId);
    // An acknowledged server write is saved even if local cleanup failed.
    if (current?.text === text) erase(memoId);
    else if (current) {
      const rebased = { ...current, baseText: text };
      memos.set(memoId, { id: memoId, text });
      install(rebased, "saving");
      persist(rebased);
    }
    publish();
    return cleanupSucceeded;
  }
  async function drop(memoId: string) {
    touched.add(memoId);
    waiting.delete(memoId);
    const before = records.get(memoId);
    try {
      await enqueue(() => draftStore.remove(userId, memoId));
      if (records.get(memoId) === before) erase(memoId);
    } catch {
      if (records.has(memoId)) states.set(memoId, "memory");
      warn(
        "端末の下書きを削除できませんでした。補足はこの画面に残しています。",
      );
    }
    publish();
  }
  async function clear() {
    clearing = true;
    try {
      await enqueue(() => draftStore.clear(userId));
      records.clear();
      waiting.clear();
      touched.clear();
      draftsRef.current.clear();
      states.clear();
      conflicts.clear();
      publish();
    } catch (error) {
      clearing = false;
      throw error; // Logout owns this user-visible failure decision.
    }
  }
  return {
    draftsRef,
    states,
    conflicts,
    start,
    change,
    acknowledge,
    drop,
    clear,
    updateMemos(next: readonly SourceMemo[]) {
      memos = new Map(next.map((memo) => [memo.id, memo]));
      reconcile();
    },
    async settled() {
      await loading;
      await writes;
    },
  };
}

export function useMemoDrafts(
  userId: string,
  memos: readonly Memo[],
  onNotice: (message: string) => void,
) {
  const [, render] = useState(0);
  const workspace = useMemo(() => createMemoDraftWorkspace(userId), [userId]);
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(
    () =>
      workspace.start(
        () => render((value) => value + 1),
        (message) => notice.current(message),
      ),
    [workspace],
  );
  useEffect(() => workspace.updateMemos(memos), [workspace, memos]);
  return {
    drafts: new Map(workspace.draftsRef.current),
    draftsRef: workspace.draftsRef,
    states: new Map(workspace.states),
    conflicts: new Set(workspace.conflicts),
    change: workspace.change,
    acknowledge: workspace.acknowledge,
    drop: workspace.drop,
    clear: workspace.clear,
  };
}
