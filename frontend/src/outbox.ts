import type { PendingMemo } from "./types";

const DB_NAME = "listen-capture-outbox-v1";
const STORE = "recordings";
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, {
          keyPath: ["userId", "clientId"],
        });
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error("端末内の保存領域を開けません。"));
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  return database;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    let value: T;
    request.onsuccess = () => {
      value = request.result;
    };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () =>
      reject(tx.error ?? new Error("端末への保存に失敗しました。"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("端末への保存が中断されました。"));
  });
}
export const outbox = {
  put: (memo: PendingMemo) =>
    transaction("readwrite", (store) => store.put(memo)),
  remove: (userId: string, clientId: string) =>
    transaction("readwrite", (store) => store.delete([userId, clientId])),
  list: async (userId: string): Promise<PendingMemo[]> => {
    const all = await transaction<PendingMemo[]>("readonly", (store) =>
      store.getAll(),
    );
    return all
      .filter((memo) => memo.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
};
// Only the matching account may send an outbox entry. The server rechecks parent ownership.
export function assertOutboxOwner(memo: PendingMemo, userId: string): void {
  if (memo.userId !== userId)
    throw new Error("別のアカウントの録音は送信できません。");
}
