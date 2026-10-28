import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NarrationPanel from "./NarrationPanel";
import {
  NarrationIntents,
  NarrationCancellation,
  NarrationRequests,
  NarrationStorageError,
  narrationFailure,
  parseNarrationConfig,
  parseNarrationIntent,
  parseNarrationJob,
  parseVoicevoxVoice,
  retryNarrationIntent,
  segmentAt,
} from "./narration";
import type { AudioSegment, NarrationIntent, NarrationJob } from "./narration";
import type { Document } from "./types";

const version = "22222222-2222-4222-8222-222222222222";
const otherVersion = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const key = "55555555-5555-4555-8555-555555555555";
const otherKey = "66666666-6666-4666-8666-666666666666";
const scope = {
  userId: "alice",
  documentId: "11111111-1111-4111-8111-111111111111",
  versionId: version,
};
const intent: NarrationIntent = {
  key,
  operation: "start",
  provider: "polly",
  acknowledge: false,
};
const job = (changes: Partial<NarrationJob> = {}): NarrationJob => ({
  id: jobId,
  document_version: version,
  provider: "polly",
  state: "queued",
  audio_version: null,
  error_code: null,
  character_count: 5000,
  completed_segments: 0,
  total_segments: 5,
  retry_characters: 5000,
  has_unknown: false,
  updated_at: "2026-10-18T10:00:00Z",
  ...changes,
});

describe("immutable VOICEVOX narration requests", () => {
  const voice = { speaker_id: 14, pitch_scale: 0.03 };
  const selected: NarrationIntent = { ...intent, provider: "voicevox", voice };
  const result = () => job({ provider: "voicevox", voice: { ...voice } });
  it("freezes voice and pitch through response loss, reload and the actual HTTP body", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(result()), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      const local = storage();
      const first = new NarrationRequests(
        scope,
        new NarrationIntents("alice", version, local),
      );
      await expect(first.submit(selected)).rejects.toThrow();
      const restored = new NarrationRequests(
        scope,
        new NarrationIntents("alice", version, local),
      );
      expect(restored.restore()).toEqual(selected);
      const external = restored.pending!;
      external.voice!.speaker_id = 3;
      expect(restored.pending!.voice).toEqual(voice);
      await restored.submit(restored.pending!);
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
        document_version: version,
        client_id: key,
        provider: "voicevox",
        voice,
      });
      expect(fetcher.mock.calls[1][1].body).toEqual(
        fetcher.mock.calls[0][1].body,
      );
      expect(restored.pending).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("does not replace an unknown result with a changed speaker or pitch", () => {
    const local = new NarrationIntents("alice", version, storage());
    local.write(selected);
    for (const change of [
      { speaker_id: 3, pitch_scale: 0.03 },
      { speaker_id: 14, pitch_scale: -0.03 },
    ]) {
      expect(() => local.write({ ...selected, voice: change })).toThrow(
        NarrationStorageError,
      );
      expect(local.read()).toEqual(selected);
    }
  });
  it("keeps the durable request when the server returns a different voice", async () => {
    const local = new NarrationIntents("alice", version, storage());
    const requests = new NarrationRequests(scope, local, async () => result());
    await expect(
      requests.submit({ ...selected, voice: { ...voice, speaker_id: 3 } }),
    ).rejects.toThrow("別の資料");
    expect(requests.pending?.voice?.speaker_id).toBe(3);
    expect(local.read()?.voice?.speaker_id).toBe(3);
  });
  it("rejects malformed or out-of-range profiles before sending or storing", () => {
    for (const value of [
      null,
      {},
      { speaker_id: true, pitch_scale: 0 },
      { speaker_id: 100001, pitch_scale: 0 },
      { speaker_id: 14, pitch_scale: NaN },
      { speaker_id: 14, pitch_scale: 0.001 },
      { ...voice, endpoint: "https://example.invalid" },
    ])
      expect(() => parseVoicevoxVoice(value)).toThrow(NarrationStorageError);
    expect(() => parseNarrationIntent({ ...intent, voice })).toThrow(
      NarrationStorageError,
    );
    expect(() => parseNarrationJob({ ...result(), voice: null })).toThrow(
      "音声設定",
    );
  });
  it("retries only the frozen voice of the failed job", () => {
    expect(
      retryNarrationIntent(
        { ...result(), state: "failed", has_unknown: true },
        true,
      ).voice,
    ).toEqual(voice);
  });
  it("validates advertised voice identity, limits and credit without accepting remote endpoints", () => {
    const provider = {
      id: "voicevox",
      enabled: true,
      label: "VOICEVOX",
      voice: "VOICEVOX",
      billable: false,
      voices: [
        {
          id: 14,
          name: "話者",
          style: "ノーマル",
          credit: "VOICEVOX:話者",
          speaker_uuid: "synthetic",
          speaker_version: "1.0",
        },
      ],
      defaults: voice,
      pitch_min: -0.15,
      pitch_max: 0.15,
      pitch_step: 0.01,
    };
    const settings = {
      max_characters: 20000,
      max_duration_ms: 3600000,
      daily_character_limit: 20000,
      providers: [provider],
    };
    expect(parseNarrationConfig(settings).providers[0].defaults).toEqual(voice);
    for (const change of [
      { voices: [] },
      { defaults: { ...voice, speaker_id: 999 } },
      { billable: true },
      { voices: [{ ...provider.voices[0], credit: "" }] },
    ])
      expect(() =>
        parseNarrationConfig({
          ...settings,
          providers: [{ ...provider, ...change }],
        }),
      ).toThrow("VOICEVOX");
  });
});
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => {
      data.set(name, value);
    },
    removeItem: (name: string) => {
      data.delete(name);
    },
  };
}

describe("durable narration requests", () => {
  it("sends the persisted UUID/provider/version or unknown acknowledgement through the actual HTTP adapter", async () => {
    const fetcher = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(job()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const local = storage();
      const requests = new NarrationRequests(
        scope,
        new NarrationIntents("alice", version, local),
      );
      await requests.submit(intent);
      expect(fetcher.mock.calls[0][0]).toBe(
        `/api/documents/${scope.documentId}/narration/`,
      );
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
        client_id: key,
        provider: "polly",
        document_version: version,
      });
      await requests.submit({
        ...intent,
        key: otherKey,
        operation: "retry",
        jobId,
        acknowledge: true,
      });
      expect(fetcher.mock.calls[1][0]).toBe(`/api/narrations/${jobId}/retry/`);
      expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
        client_id: otherKey,
        acknowledge_unknown: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("persists before POST and reuses the exact request after a committed-but-lost response and reload", async () => {
    const local = storage();
    const post = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(new NarrationIntents("alice", version, local).read()).toEqual(
          intent,
        );
        throw new Error("response lost after commit");
      })
      .mockResolvedValueOnce(job());
    const first = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      post,
    );
    await expect(first.submit(intent)).rejects.toThrow("response lost");
    const reloaded = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      post,
    );
    expect(reloaded.restore()).toEqual(intent);
    const receipt = await reloaded.submit(reloaded.pending!);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
    expect(receipt?.job.id).toBe(jobId);
    expect(receipt?.pending).toBeNull();
    expect(local.data.size).toBe(0);
  });
  it("refuses a different key or provider while an earlier result is unknown", async () => {
    const local = storage();
    const records = new NarrationIntents("alice", version, local);
    records.write(intent);
    const post = vi.fn();
    const requests = new NarrationRequests(scope, records, post);
    await expect(
      requests.submit({ ...intent, key: otherKey }),
    ).rejects.toBeInstanceOf(NarrationStorageError);
    await expect(
      requests.submit({ ...intent, provider: "windows" }),
    ).rejects.toBeInstanceOf(NarrationStorageError);
    expect(post).not.toHaveBeenCalled();
    expect(records.read()).toEqual(intent);
  });
  it("prevents a rapid second click before React renders disabled controls", async () => {
    const local = storage();
    let finish!: (value: NarrationJob) => void;
    const post = vi.fn(
      () =>
        new Promise<NarrationJob>((resolve) => {
          finish = resolve;
        }),
    );
    const requests = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      post,
    );
    const first = requests.submit(intent);
    expect(requests.busy).toBe(true);
    await expect(
      requests.submit({ ...intent, key: otherKey }),
    ).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledOnce();
    finish(job());
    await first;
    expect(requests.busy).toBe(false);
  });
  it("ignores late old-account/version responses, aborts transport and retains only that scope's receipt", async () => {
    const local = storage();
    let finish!: (value: NarrationJob) => void;
    let signal!: AbortSignal;
    const old = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      (_scope, _value, activeSignal) => {
        signal = activeSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const first = old.submit(intent);
    old.dispose();
    expect(signal.aborted).toBe(true);
    const other = new NarrationRequests(
      { ...scope, userId: "bob", versionId: otherVersion },
      new NarrationIntents("bob", otherVersion, local),
      vi.fn(),
    );
    expect(other.restore()).toBeNull();
    finish(job());
    await expect(first).resolves.toBeUndefined();
    expect(new NarrationIntents("alice", version, local).read()).toEqual(
      intent,
    );
    expect(other.pending).toBeNull();
    await expect(old.submit(intent)).resolves.toBeUndefined();
  });
  it("does not clear a durable key on wrong version/provider/job or malformed successful response", async () => {
    for (const response of [
      job({ document_version: otherVersion }),
      job({ provider: "windows" }),
      { ...job(), completed_segments: 7 },
      null,
    ]) {
      const local = storage();
      const records = new NarrationIntents("alice", version, local);
      const requests = new NarrationRequests(
        scope,
        records,
        vi.fn().mockResolvedValue(response),
      );
      await expect(requests.submit(intent)).rejects.toThrow();
      expect(records.read()).toEqual(intent);
    }
    const local = storage();
    const retry: NarrationIntent = {
      ...intent,
      operation: "retry",
      jobId,
      acknowledge: true,
    };
    const requests = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      vi.fn().mockResolvedValue(job({ id: otherKey })),
    );
    await expect(requests.submit(retry)).rejects.toThrow("別の資料");
  });
  it("keeps a successful receipt recoverable when local cleanup fails", async () => {
    const local = storage();
    local.removeItem = () => {
      throw new Error("denied");
    };
    const post = vi.fn().mockResolvedValue(job());
    const requests = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      post,
    );
    const result = await requests.submit(intent);
    expect(result?.cleanupFailed).toBe(true);
    expect(result?.pending).toEqual(intent);
    await expect(
      requests.submit({ ...intent, key: otherKey }),
    ).rejects.toBeInstanceOf(NarrationStorageError);
    await requests.submit(intent);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].key).toBe(key);
  });
  it("never clears a pending record whose payload changed while the original POST was in flight", async () => {
    const local = storage();
    let finish!: (value: NarrationJob) => void;
    const requests = new NarrationRequests(
      scope,
      new NarrationIntents("alice", version, local),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const submitted = requests.submit(intent);
    const altered = { ...intent, provider: "windows" };
    local.setItem(
      `lc-narration-intent-v1:alice:${version}`,
      JSON.stringify(altered),
    );
    finish(job());
    expect((await submitted)?.cleanupFailed).toBe(true);
    expect(new NarrationIntents("alice", version, local).read()).toEqual(
      altered,
    );
  });
  it("fails closed before POST for read denial, write denial or a storage implementation that drops writes", async () => {
    for (const fault of ["read", "write", "drop"] as const) {
      const local = storage();
      if (fault === "read")
        local.getItem = () => {
          throw new Error("denied");
        };
      else if (fault === "write")
        local.setItem = () => {
          throw new Error("quota");
        };
      else local.setItem = () => undefined;
      const post = vi.fn();
      const requests = new NarrationRequests(
        scope,
        new NarrationIntents("alice", version, local),
        post,
      );
      await expect(requests.submit(intent)).rejects.toBeInstanceOf(
        NarrationStorageError,
      );
      expect(post).not.toHaveBeenCalled();
    }
  });
  it("requires explicit acknowledgement for unknown segments and preserves that exact retry after loss", async () => {
    const unknown = job({ state: "failed", has_unknown: true });
    expect(() => retryNarrationIntent(unknown, false)).toThrow("確認");
    expect(() => retryNarrationIntent(job(), true)).toThrow();
    const retry = retryNarrationIntent(unknown, true);
    expect(retry).toMatchObject({
      operation: "retry",
      jobId,
      acknowledge: true,
      provider: "polly",
    });
    const local = storage();
    const records = new NarrationIntents("alice", version, local);
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(job());
    const requests = new NarrationRequests(scope, records, post);
    await expect(requests.submit(retry)).rejects.toThrow("lost");
    await expect(
      requests.submit({ ...retry, acknowledge: false }),
    ).rejects.toBeInstanceOf(NarrationStorageError);
    await requests.submit(
      new NarrationIntents("alice", version, local).read()!,
    );
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
  });
});

describe("narration input and status boundaries", () => {
  it("recognizes cancellation without presenting it as a synthesis failure", () => {
    const cancelled = job({
      state: "failed",
      error_code: "user_cancelled",
      completed_segments: 2,
      retry_characters: 3000,
      cancel_requested_at: "2026-10-22T08:00:00Z",
    });
    expect(narrationFailure(parseNarrationJob(cancelled))).toBe(
      "中断しました。",
    );
    expect(retryNarrationIntent(cancelled, false)).toMatchObject({
      operation: "retry",
      jobId,
      provider: "polly",
    });
    for (const value of [true, {}, "not-a-date", "x".repeat(65)])
      expect(() =>
        parseNarrationJob({ ...cancelled, cancel_requested_at: value }),
      ).toThrow();
  });
  it("distinguishes unknown local synthesis from possibly billable Polly outcomes", () => {
    const failure = job({
      state: "failed",
      error_code: "execution_unknown",
      has_unknown: true,
    });
    expect(narrationFailure(failure)).toContain("課金");
    expect(narrationFailure({ ...failure, provider: "windows" })).not.toContain(
      "課金",
    );
    expect(narrationFailure({ ...failure, provider: "fixture" })).toContain(
      "自動で作り直しません",
    );
  });
  it("blocks malformed pending data without silently discarding an uncertain request", () => {
    for (const raw of [
      "",
      "broken{",
      "null",
      "[]",
      "12",
      JSON.stringify({ ...intent, key: "-".repeat(36) }),
      JSON.stringify({ ...intent, operation: "retry" }),
      JSON.stringify({ ...intent, acknowledge: true }),
      JSON.stringify({ ...intent, owner: "bob" }),
      "x".repeat(2049),
    ]) {
      const local = storage();
      local.setItem(`lc-narration-intent-v1:alice:${version}`, raw);
      const records = new NarrationIntents("alice", version, local);
      expect(() => records.read()).toThrow(NarrationStorageError);
      expect(local.data.size).toBe(1);
    }
    expect(parseNarrationIntent(intent)).toEqual(intent);
  });
  it("keeps pending intentions isolated by account and immutable version", () => {
    const local = storage();
    new NarrationIntents("alice", version, local).write(intent);
    expect(new NarrationIntents("bob", version, local).read()).toBeNull();
    expect(
      new NarrationIntents("alice", otherVersion, local).read(),
    ).toBeNull();
  });
  it("rejects malformed settings/status instead of silently enabling generation or crashing on providers", () => {
    for (const value of [
      null,
      {},
      { providers: null },
      {
        max_characters: 20001,
        max_duration_ms: 1200000,
        daily_character_limit: 20000,
        providers: [],
      },
    ])
      expect(() => parseNarrationConfig(value)).toThrow("設定");
    expect(
      parseNarrationConfig({
        max_characters: 20000,
        max_duration_ms: 1200000,
        daily_character_limit: 20000,
        providers: [
          {
            id: "polly",
            enabled: false,
            label: "Polly",
            voice: "Mizuki",
            billable: true,
          },
        ],
      }).providers[0].enabled,
    ).toBe(false);
    expect(parseNarrationJob(job())).toEqual(job());
    expect(() =>
      parseNarrationJob({ ...job(), completed_segments: -1 }),
    ).toThrow();
  });
  it("shows initialization instead of an actionable legacy generator before storage and settings are checked", () => {
    const document: Document = {
      id: scope.documentId,
      title: "資料",
      created_at: "",
      updated_at: "",
      current_version: { id: version, number: 1, text: "短文です。" },
      audio_versions: [],
    };
    const markup = renderToStaticMarkup(
      createElement(NarrationPanel, {
        document,
        userId: "alice",
        disabled: false,
        legacy: createElement("button", null, "unsafe-legacy-button"),
        onReady: vi.fn(),
      }),
    );
    expect(markup).toContain("設定と受付記録を確認しています");
    expect(markup).not.toContain("unsafe-legacy-button");
  });
  it("maps only the current coarse segment including the final boundary, without inventing a mapping in gaps", () => {
    const segments: AudioSegment[] = [
      {
        index: 0,
        start_offset: 0,
        end_offset: 5,
        start_ms: 0,
        end_ms: 1000,
        block_ids: ["a"],
      },
      {
        index: 1,
        start_offset: 5,
        end_offset: 10,
        start_ms: 1200,
        end_ms: 2000,
        block_ids: ["b"],
      },
    ];
    expect(segmentAt(999, segments)?.index).toBe(0);
    expect(segmentAt(1000, segments)).toBeUndefined();
    expect(segmentAt(1200, segments)?.index).toBe(1);
    expect(segmentAt(2000, segments)?.index).toBe(1);
    for (const position of [-1, NaN, Infinity, 2001])
      expect(segmentAt(position, segments)).toBeUndefined();
  });
});

describe("server narration cancellation", () => {
  const cancelling = () =>
    job({
      state: "running",
      cancel_requested_at: "2026-10-22T08:00:00Z",
    });
  it("repeats the same idempotent target after response loss with CSRF transport and account identity", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cancelling()), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      const cancellation = new NarrationCancellation(scope);
      await expect(cancellation.submit(job())).rejects.toThrow();
      expect(await cancellation.submit(job())).toEqual(cancelling());
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const [path, init] of fetcher.mock.calls) {
        expect(path).toBe(`/api/narrations/${jobId}/cancel/`);
        expect(init.method).toBe("POST");
        expect(init.body).toBe("{}");
        expect(init.credentials).toBe("same-origin");
        expect(init.headers.get("X-Workspace-User")).toBe("alice");
        expect(init.headers.has("X-CSRFToken")).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("blocks duplicate clicks and ignores a detached account's late response", async () => {
    let finish!: (value: NarrationJob) => void;
    let signal!: AbortSignal;
    const post = vi.fn((_id: string, _userId: string, active?: AbortSignal) => {
      signal = active!;
      return new Promise<NarrationJob>((resolve) => {
        finish = resolve;
      });
    });
    const cancellation = new NarrationCancellation(scope, post);
    const pending = cancellation.submit(job());
    expect(cancellation.busy).toBe(true);
    await expect(cancellation.submit(job())).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledOnce();
    cancellation.dispose();
    expect(signal.aborted).toBe(true);
    finish(cancelling());
    await expect(pending).resolves.toBeUndefined();
    await expect(cancellation.submit(job())).resolves.toBeUndefined();
  });
  it("does not claim cancellation for a different job, version, voice, or missing acknowledgement", async () => {
    for (const result of [
      { ...cancelling(), id: otherKey },
      { ...cancelling(), document_version: otherVersion },
      { ...cancelling(), provider: "windows" as const },
      job({ state: "running" }),
    ]) {
      const cancellation = new NarrationCancellation(
        scope,
        vi.fn().mockResolvedValue(result),
      );
      await expect(cancellation.submit(job())).rejects.toThrow("一致");
      expect(cancellation.busy).toBe(false);
    }
    const post = vi.fn();
    const cancellation = new NarrationCancellation(scope, post);
    await expect(
      cancellation.submit(job({ document_version: otherVersion })),
    ).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
  });
  it("preserves the successful result when publication won the cancellation race", async () => {
    const completed = job({ state: "succeeded", audio_version: otherKey });
    const cancellation = new NarrationCancellation(
      scope,
      vi.fn().mockResolvedValue(completed),
    );
    expect(await cancellation.submit(job())).toEqual(completed);
  });
});
