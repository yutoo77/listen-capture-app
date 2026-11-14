import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  PdfPageIntents,
  PdfPageRequests,
  PdfPageStorageError,
  parsePdfPageIntent,
} from "./pdfPages";
import type { PdfPageIntent } from "./pdfPages";
import type { PdfImportJob } from "./types";

const jobId = "11111111-1111-4111-8111-111111111111";
const key = "22222222-2222-4222-8222-222222222222";
const secondKey = "33333333-3333-4333-8333-333333333333";
const intent: PdfPageIntent = {
  client_id: key,
  start_page: 51,
  end_page: 60,
  revision: 0,
};
const job = (changes: Partial<PdfImportJob> = {}): PdfImportJob => ({
  id: jobId,
  state: "queued",
  error_code: null,
  extracted_text: "",
  page_count: 100,
  start_page: 51,
  end_page: 60,
  selection_revision: 1,
  source_size_bytes: 1234,
  source_available: true,
  confirmed_document: null,
  created_at: "2026-10-18T10:00:00Z",
  ...changes,
});
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("durable PDF page selection", () => {
  it("records before POST and replays an accepted-but-lost response with the same UUID, range and base revision after reload", async () => {
    const local = storage();
    const post = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(new PdfPageIntents("alice", jobId, local).read()).toEqual(
          intent,
        );
        throw new Error("response lost after selection committed");
      })
      .mockResolvedValueOnce(job());
    const requests = new PdfPageRequests(
      jobId,
      new PdfPageIntents("alice", jobId, local),
      post,
    );
    await expect(requests.submit(intent)).rejects.toThrow("response lost");
    const reload = new PdfPageRequests(
      jobId,
      new PdfPageIntents("alice", jobId, local),
      post,
    );
    expect(reload.restore()).toEqual(intent);
    expect(post).toHaveBeenCalledTimes(1);
    const receipt = await reload.submit(reload.pending!);
    expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
    expect(receipt?.pending).toBeNull();
    expect(local.data.size).toBe(0);
  });
  it("sends the canonical persisted payload through the actual HTTP adapter", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(job()), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const requests = new PdfPageRequests(
        jobId,
        new PdfPageIntents("alice", jobId, storage()),
      );
      await requests.submit(intent);
      expect(fetcher.mock.calls[0][0]).toBe(`/api/pdf-imports/${jobId}/pages/`);
      expect(fetcher.mock.calls[0][1].method).toBe("POST");
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(intent);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("never overwrites a pending selection with another range/key or sends a rapid duplicate", async () => {
    const local = storage();
    let finish!: (value: PdfImportJob) => void;
    const post = vi.fn(
      () =>
        new Promise<PdfImportJob>((resolve) => {
          finish = resolve;
        }),
    );
    const requests = new PdfPageRequests(
      jobId,
      new PdfPageIntents("alice", jobId, local),
      post,
    );
    const sending = requests.submit(intent);
    await expect(
      requests.submit({ ...intent, client_id: secondKey }),
    ).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledOnce();
    finish(job());
    await sending;
    new PdfPageIntents("alice", jobId, local).write(intent);
    await expect(
      requests.submit({ ...intent, client_id: secondKey }),
    ).rejects.toBeInstanceOf(PdfPageStorageError);
    await expect(
      requests.submit({ ...intent, end_page: 61 }),
    ).rejects.toBeInstanceOf(PdfPageStorageError);
    expect(post).toHaveBeenCalledOnce();
  });
  it("keeps account/source scopes separate and ignores an old unmounted response", async () => {
    const local = storage();
    let finish!: (value: PdfImportJob) => void;
    let signal!: AbortSignal;
    const requests = new PdfPageRequests(
      jobId,
      new PdfPageIntents("alice", jobId, local),
      (_id, _value, pendingSignal) => {
        signal = pendingSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const pending = requests.submit(intent);
    requests.dispose();
    expect(signal.aborted).toBe(true);
    expect(new PdfPageIntents("bob", jobId, local).read()).toBeNull();
    expect(
      new PdfPageIntents("alice", "another-source", local).read(),
    ).toBeNull();
    finish(job());
    await expect(pending).resolves.toBeUndefined();
    expect(new PdfPageIntents("alice", jobId, local).read()).toEqual(intent);
  });
  it("fails closed before POST when storage is denied or a write is silently discarded", async () => {
    for (const broken of [
      {
        ...storage(),
        getItem: () => {
          throw new Error("denied");
        },
      },
      { ...storage(), setItem: () => {} },
    ]) {
      const post = vi.fn();
      const requests = new PdfPageRequests(
        jobId,
        new PdfPageIntents("alice", jobId, broken),
        post,
      );
      await expect(requests.submit(intent)).rejects.toBeInstanceOf(
        PdfPageStorageError,
      );
      expect(post).not.toHaveBeenCalled();
    }
  });
  it("retains malformed or mismatching receipts and never clears another pending record", async () => {
    for (const response of [
      job({ id: "another-source" }),
      job({ selection_revision: -1 }),
      job({ start_page: 1, end_page: 10 }),
    ]) {
      const local = storage();
      const records = new PdfPageIntents("alice", jobId, local);
      const requests = new PdfPageRequests(
        jobId,
        records,
        vi.fn().mockResolvedValue(response),
      );
      await expect(requests.submit(intent)).rejects.toThrow("一致");
      expect(records.read()).toEqual(intent);
    }
    const local = storage();
    const records = new PdfPageIntents("alice", jobId, local);
    records.write(intent);
    expect(() => records.clear({ ...intent, client_id: secondKey })).toThrow();
    expect(records.read()).toEqual(intent);
    for (const raw of [
      "{broken",
      "null",
      "[]",
      JSON.stringify({ ...intent, revision: -1 }),
      JSON.stringify({ ...intent, end_page: 200 }),
      JSON.stringify({ ...intent, unexpected: true }),
      "x".repeat(2049),
    ]) {
      local.data.set(`lc-pdf-pages:alice:${jobId}`, raw);
      expect(() => records.read()).toThrow(PdfPageStorageError);
      expect(local.data.get(`lc-pdf-pages:alice:${jobId}`)).toBe(raw);
    }
    expect(() =>
      parsePdfPageIntent({ ...intent, client_id: "not-uuid" }),
    ).toThrow();
  });
  it("retains acknowledged records on cleanup failure and accepts newer selection state on replay without rolling it back", async () => {
    const local = storage();
    const broken = {
      ...local,
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const first = new PdfPageRequests(
      jobId,
      new PdfPageIntents("alice", jobId, broken),
      vi.fn().mockResolvedValue(job()),
    );
    const accepted = await first.submit(intent);
    expect(accepted?.cleanupFailed).toBe(true);
    expect(accepted?.pending).toEqual(intent);
    const post = vi
      .fn()
      .mockResolvedValue(
        job({ selection_revision: 3, start_page: 10, end_page: 20 }),
      );
    const restored = new PdfPageRequests(
      jobId,
      new PdfPageIntents("alice", jobId, local),
      post,
    );
    const receipt = await restored.submit(restored.restore()!);
    expect(receipt?.job.selection_revision).toBe(3);
    expect(receipt?.job.start_page).toBe(10);
    expect(post.mock.calls[0][1]).toEqual(intent);
    expect(restored.pending).toBeNull();
  });
  it("clears only a definitive CAS refusal, while a throttle or transport failure remains unknown", async () => {
    for (const status of [409, 429, 503]) {
      const local = storage();
      const records = new PdfPageIntents("alice", jobId, local);
      const requests = new PdfPageRequests(
        jobId,
        records,
        vi.fn().mockRejectedValue(new ApiError(status, "synthetic refusal")),
      );
      await expect(requests.submit(intent)).rejects.toBeInstanceOf(ApiError);
      expect(records.read()).toEqual(status === 409 ? null : intent);
      expect(requests.pending).toEqual(status === 409 ? null : intent);
    }
  });
});
