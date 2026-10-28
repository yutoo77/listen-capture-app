import { api, ApiError } from "./api";
import type { PdfImportJob } from "./types";

export type PdfPageIntent = {
  client_id: string;
  start_page: number;
  end_page: number;
  revision: number;
};
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class PdfPageStorageError extends Error {}
export function parsePdfPageIntent(value: unknown): PdfPageIntent {
  const input = value as PdfPageIntent;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !==
      "client_id,end_page,revision,start_page" ||
    typeof input.client_id !== "string" ||
    !uuid.test(input.client_id) ||
    !Number.isSafeInteger(input.start_page) ||
    !Number.isSafeInteger(input.end_page) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    input.revision > 2147483646 ||
    input.start_page < 1 ||
    input.end_page > 200 ||
    input.start_page > input.end_page ||
    input.end_page - input.start_page >= 50
  )
    throw new PdfPageStorageError(
      "ページ選択の受付記録を安全に読み取れません。",
    );
  return {
    client_id: input.client_id,
    start_page: input.start_page,
    end_page: input.end_page,
    revision: input.revision,
  };
}
const same = (a: PdfPageIntent, b: PdfPageIntent) =>
  a.client_id === b.client_id &&
  a.start_page === b.start_page &&
  a.end_page === b.end_page &&
  a.revision === b.revision;
export class PdfPageIntents {
  private key: string;
  constructor(
    userId: string,
    jobId: string,
    private storage: Store,
  ) {
    this.key = `lc-pdf-pages:${userId}:${jobId}`;
  }
  read(): PdfPageIntent | null {
    try {
      const raw = this.storage.getItem(this.key);
      if (raw === null) return null;
      if (raw.length > 2048) throw new Error();
      return parsePdfPageIntent(JSON.parse(raw));
    } catch {
      throw new PdfPageStorageError(
        "ページ選択の受付記録を安全に読み取れません。記録を消さず、保存領域を確認してください。",
      );
    }
  }
  write(value: PdfPageIntent) {
    const valid = parsePdfPageIntent(value);
    const previous = this.read();
    if (previous && !same(previous, valid))
      throw new PdfPageStorageError(
        "前のページ選択の受付が未確認です。同じ依頼を確認してください。",
      );
    try {
      this.storage.setItem(this.key, JSON.stringify(valid));
      const saved = this.read();
      if (!saved || !same(saved, valid)) throw new Error();
    } catch {
      throw new PdfPageStorageError(
        "ページ選択の依頼を端末に記録できません。送信していません。",
      );
    }
  }
  clear(value: PdfPageIntent) {
    const previous = this.read();
    if (!previous) return;
    if (!same(previous, value))
      throw new PdfPageStorageError(
        "別の受付記録が残っています。記録を消さず再確認してください。",
      );
    this.storage.removeItem(this.key);
    if (this.storage.getItem(this.key) !== null)
      throw new PdfPageStorageError(
        "受付済みですが端末の記録を削除できません。",
      );
  }
}
type Post = (
  jobId: string,
  value: PdfPageIntent,
  signal: AbortSignal,
) => Promise<PdfImportJob>;
export class PdfPageRequests {
  busy = false;
  pending: PdfPageIntent | null = null;
  private disposed = false;
  private request: AbortController | null = null;
  constructor(
    private jobId: string,
    private records: PdfPageIntents,
    private post: Post = api.selectPdfPages,
  ) {}
  restore() {
    return (this.pending = this.records.read());
  }
  async submit(value: PdfPageIntent) {
    if (this.busy || this.disposed) return;
    value = parsePdfPageIntent(value);
    this.records.write(value);
    this.pending = parsePdfPageIntent(value);
    this.busy = true;
    const controller = new AbortController();
    this.request = controller;
    try {
      const job = await this.post(this.jobId, this.pending, controller.signal);
      if (this.disposed || controller.signal.aborted) return;
      if (
        job.id !== this.jobId ||
        !Number.isSafeInteger(job.selection_revision) ||
        job.selection_revision < value.revision ||
        !Number.isSafeInteger(job.page_count) ||
        !job.page_count ||
        job.page_count < 1 ||
        job.page_count > 200 ||
        !Number.isSafeInteger(job.start_page) ||
        !Number.isSafeInteger(job.end_page) ||
        !job.start_page ||
        !job.end_page ||
        job.start_page > job.end_page ||
        job.end_page > job.page_count ||
        job.end_page - job.start_page >= 50 ||
        (job.selection_revision <= value.revision + 1 &&
          (job.start_page !== value.start_page ||
            job.end_page !== value.end_page))
      )
        throw new Error(
          "ページ選択の受付結果が一致しません。同じ依頼を確認してください。",
        );
      let cleanupFailed = false;
      try {
        this.records.clear(value);
        this.pending = null;
      } catch {
        cleanupFailed = true;
      }
      return { job, pending: this.pending, cleanupFailed };
    } catch (error) {
      // A definitive CAS conflict did not accept this payload. Recover the
      // current server draft before the user explicitly chooses another range.
      if (error instanceof ApiError && error.status === 409) {
        try {
          this.records.clear(value);
          this.pending = null;
        } catch {
          throw new PdfPageStorageError(
            "受付拒否を確認しましたが端末の記録を削除できません。記録を消さず保存領域を確認してください。",
          );
        }
      }
      throw error;
    } finally {
      this.busy = false;
      this.request = null;
    }
  }
  dispose() {
    this.disposed = true;
    this.request?.abort();
  }
}
