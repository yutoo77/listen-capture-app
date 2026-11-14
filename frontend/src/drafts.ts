export type MemoDraft = {
  userId: string;
  memoId: string;
  text: string;
  baseText: string;
  updatedAt: string;
};

const DB_NAME = "listen-capture-memo-drafts-v1";
const STORE = "drafts";
let database: Promise<IDBDatabase> | undefined;

function validId(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
    throw new Error("下書きの利用者またはメモIDが正しくありません。");
}
function validText(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 10_000 ||
    value.includes("\0")
  )
    throw new Error("下書きはNULを含まない10,000文字以内で入力してください。");
}
function validated(draft: MemoDraft): MemoDraft {
  if (!draft || typeof draft !== "object")
    throw new Error("下書きの形式が正しくありません。");
  validId(draft.userId);
  validId(draft.memoId);
  validText(draft.text);
  validText(draft.baseText);
  const supplied = draft.updatedAt;
  if (
    typeof supplied !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(supplied) ||
    !Number.isFinite(Date.parse(supplied))
  )
    throw new Error("下書きの更新日時が正しくありません。");
  const updatedAt = new Date(supplied).toISOString();
  if (
    updatedAt !==
    (supplied.includes(".") ? supplied : supplied.replace("Z", ".000Z"))
  )
    throw new Error("下書きの更新日時が正しくありません。");
  return {
    userId: draft.userId,
    memoId: draft.memoId,
    text: draft.text,
    baseText: draft.baseText,
    updatedAt,
  };
}

function open(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, {
          keyPath: ["userId", "memoId"],
        });
        store.createIndex("userId", "userId");
      };
      request.onblocked = () => {
        blocked = true;
        reject(new Error("端末内の下書き保存領域を開けません。"));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        db.onclose = () => {
          database = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  return database;
}

async function transaction<T>(
  mode: IDBTransactionMode,
  action: (
    store: IDBObjectStore,
    result: (value: T) => void,
    fail: (error: unknown) => void,
  ) => void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T;
    let failure: unknown;
    const fail = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () =>
      reject(failure ?? tx.error ?? new Error("下書きの保存に失敗しました。"));
    tx.onabort = () =>
      reject(
        failure ?? tx.error ?? new Error("下書きの保存が中断されました。"),
      );
    try {
      action(tx.objectStore(STORE), (next) => (value = next), fail);
    } catch (error) {
      fail(error);
    }
  });
}

export const draftStore = {
  async put(draft: MemoDraft): Promise<void> {
    // Snapshot the caller's input before the first await. A delayed older write
    // must not replace a newer edit already committed by another tab/write.
    const next = validated(draft);
    return transaction<void>("readwrite", (store, _result, fail) => {
      const request = store.get([next.userId, next.memoId]);
      request.onsuccess = () => {
        try {
          const current = request.result
            ? validated(request.result)
            : undefined;
          if (current && current.updatedAt > next.updatedAt)
            throw new Error("別の画面の新しい下書きを上書きできません。");
          store.put(next);
        } catch (error) {
          fail(error);
        }
      };
    });
  },
  async list(userId: string): Promise<MemoDraft[]> {
    validId(userId);
    return transaction("readonly", (store, result, fail) => {
      const request = store.index("userId").getAll(userId);
      request.onsuccess = () => {
        try {
          const drafts = (request.result as MemoDraft[]).map(validated);
          if (drafts.some((draft) => draft.userId !== userId))
            throw new Error("別の利用者の下書きは読み込めません。");
          result(
            drafts.sort(
              (a, b) =>
                b.updatedAt.localeCompare(a.updatedAt) ||
                a.memoId.localeCompare(b.memoId),
            ),
          );
        } catch (error) {
          fail(error);
        }
      };
    });
  },
  async remove(userId: string, memoId: string): Promise<void> {
    validId(userId);
    validId(memoId);
    return transaction("readwrite", (store) => {
      store.delete([userId, memoId]);
    });
  },
  async compareAndRemove(
    userId: string,
    memoId: string,
    expectedText: string,
  ): Promise<boolean> {
    validId(userId);
    validId(memoId);
    validText(expectedText);
    return transaction("readwrite", (store, result, fail) => {
      const request = store.get([userId, memoId]);
      request.onsuccess = () => {
        try {
          const current = request.result
            ? validated(request.result)
            : undefined;
          const matches = current?.text === expectedText;
          if (matches) store.delete([userId, memoId]);
          result(matches);
        } catch (error) {
          fail(error);
        }
      };
    });
  },
  async clear(userId: string): Promise<void> {
    validId(userId);
    return transaction("readwrite", (store, _result, fail) => {
      const request = store.index("userId").openCursor(userId);
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        } catch (error) {
          fail(error);
        }
      };
    });
  },
};
