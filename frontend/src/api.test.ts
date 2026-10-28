import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, login, request, session } from "./api";
import type { PendingMemo } from "./types";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
describe("same origin session API", () => {
  it("binds ownerless creation and workspace lists to the displayed account", async () => {
    fetchMock.mockImplementation(async () => json({}));
    await api.createDocument("資料", "本文", "alice");
    await api.demo("alice");
    await api.documents("alice");
    await api.memos("alice");
    await api.pdfImports("alice");
    for (const [, options] of fetchMock.mock.calls)
      expect(new Headers(options.headers).get("X-Workspace-User")).toBe(
        "alice",
      );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      title: "資料",
      text: "本文",
    });
  });
  it("sends the original immutable version when editing a document", async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await api.updateDocument(
      "a/b",
      "題名",
      "修正",
      "version-1",
      "alice",
      "2026-10-20T00:00:00Z",
    );
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/documents/a%2Fb/");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({
      title: "題名",
      text: "修正",
      expected_version: "version-1",
      expected_updated_at: "2026-10-20T00:00:00Z",
    });
    expect(new Headers(options.headers).get("X-Workspace-User")).toBe("alice");
  });
  const recording = (): PendingMemo => ({
    userId: "alice",
    clientId: "unchanged-key",
    audioVersion: "version-1",
    documentId: "doc",
    documentTitle: "資料",
    blob: new Blob(["audio-bytes"], { type: "audio/mp4" }),
    positionMs: 2000,
    durationMs: 500,
    createdAt: "",
    text: "",
  });
  it("sends CSRF on login and uses the newly rotated token for later mutations", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ user: null, csrfToken: "before", ttsAvailable: false }),
    );
    await session();
    fetchMock.mockResolvedValueOnce(
      json({
        user: { id: "alice", username: "alice" },
        csrfToken: "after",
        ttsAvailable: false,
      }),
    );
    await login("alice", "private-password");
    const loginOptions = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(loginOptions.headers).get("X-CSRFToken")).toBe("before");
    expect(loginOptions.credentials).toBe("same-origin");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.logout();
    expect(
      new Headers(fetchMock.mock.calls[2][1].headers).get("X-CSRFToken"),
    ).toBe("after");
  });
  it("treats a failed upload as a failure, not a successful empty result", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "保存できません" }, 503));
    await expect(request("memos/", { method: "POST" })).rejects.toMatchObject({
      status: 503,
      message: "保存できません",
    });
  });
  it("cancels session body reading with the caller's workspace signal", async () => {
    const caller = new AbortController();
    let bodyStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => (bodyStarted = resolve));
    let transportSignal!: AbortSignal;
    fetchMock.mockImplementationOnce(
      async (_url: string, options: RequestInit) => {
        transportSignal = options.signal!;
        return {
          ok: true,
          status: 200,
          json: () => {
            bodyStarted();
            return new Promise((_resolve, reject) =>
              transportSignal.addEventListener(
                "abort",
                () => reject(new DOMException("Disposed", "AbortError")),
                { once: true },
              ),
            );
          },
        };
      },
    );
    const result = session(caller.signal).catch((error) => error);
    await readingBody;
    expect(transportSignal.aborted).toBe(false);
    caller.abort();
    expect(await result).toMatchObject({ name: "ApiError", status: 0 });
    expect(transportSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("does not let a late cancelled session replace a newer login's CSRF token", async () => {
    const caller = new AbortController();
    let bodyStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => (bodyStarted = resolve));
    let releaseBody!: (value: unknown) => void;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => {
        bodyStarted();
        // Model an already-delivered body that settles after caller abort.
        return new Promise((resolve) => (releaseBody = resolve));
      },
    });
    const oldSession = session(caller.signal).catch((error) => error);
    await readingBody;
    caller.abort();
    fetchMock.mockResolvedValueOnce(
      json({
        user: { id: "bob", username: "bob" },
        csrfToken: "new-login-token",
        ttsAvailable: false,
      }),
    );
    await login("bob", "private-password");
    releaseBody({
      user: { id: "alice", username: "alice" },
      csrfToken: "obsolete-token",
      ttsAvailable: false,
    });
    expect(await oldSession).toMatchObject({ name: "ApiError", status: 0 });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.logout();
    expect(
      new Headers(fetchMock.mock.calls[2][1].headers).get("X-CSRFToken"),
    ).toBe("new-login-token");
  });
  it.each(["http", "network"])(
    "preserves the last valid CSRF token when a session check fails with %s",
    async (failure) => {
      fetchMock.mockResolvedValueOnce(
        json({ user: null, csrfToken: "retained-token", ttsAvailable: false }),
      );
      await session();
      if (failure === "http")
        fetchMock.mockResolvedValueOnce(json({ detail: "Expired" }, 403));
      else fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
      await expect(
        session(new AbortController().signal),
      ).rejects.toBeInstanceOf(ApiError);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await api.logout();
      expect(
        new Headers(fetchMock.mock.calls[2][1].headers).get("X-CSRFToken"),
      ).toBe("retained-token");
    },
  );
  it("reports expired CSRF/session without exposing permission details", async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: "internal detail" }, 403));
    await expect(api.documents()).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("再ログイン"),
    });
  });
  it("keeps multipart Content-Type generation in the browser and preserves idempotency UUID", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "saved" }, 201));
    await api.upload({
      userId: "alice",
      clientId: "same-uuid",
      audioVersion: "version-1",
      documentId: "doc",
      documentTitle: "資料",
      blob: new Blob(["audio"], { type: "audio/mp4" }),
      positionMs: 2000,
      durationMs: 500,
      createdAt: "",
      text: "気づき",
    });
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).has("Content-Type")).toBe(false);
    const data = options.body as FormData;
    expect(data.get("client_id")).toBe("same-uuid");
    expect(data.get("position_ms")).toBe("2000");
    expect(data.get("audio_version")).toBe("version-1");
    expect(data.has("userId")).toBe(false);
  });
  it("returns a recoverable network error when offline", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.memos()).rejects.toBeInstanceOf(ApiError);
  });
  it("times out a stalled response body even when the caller supplies its own signal", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let bodyStarted = false;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      async (_url: string, options: RequestInit) => {
        requestSignal = options.signal!;
        return {
          ok: true,
          status: 200,
          json: () => {
            bodyStarted = true;
            return new Promise((_resolve, reject) => {
              requestSignal!.addEventListener(
                "abort",
                () =>
                  reject(new DOMException("Body read aborted", "AbortError")),
                { once: true },
              );
            });
          },
        };
      },
    );
    const result = request("memos/", { signal: caller.signal }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(bodyStarted).toBe(true);
    expect(requestSignal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ name: "ApiError", status: 0 });
    expect(requestSignal!.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves an HTTP error status when its error response body stalls", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      async (_url: string, options: RequestInit) => ({
        ok: false,
        status: 503,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Body read aborted", "AbortError")),
              { once: true },
            );
          }),
      }),
    );
    const result = request("memos/", { method: "POST" }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toMatchObject({ name: "ApiError", status: 503 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors caller cancellation while reading the body and clears its own timer", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    fetchMock.mockImplementationOnce(
      async (_url: string, options: RequestInit) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Caller aborted", "AbortError")),
              { once: true },
            );
          }),
      }),
    );
    const result = request("memos/", { signal: caller.signal }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    expect(await result).toMatchObject({ name: "ApiError", status: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows a slow memo upload to complete after the normal 20 second JSON deadline", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((resolve, reject) => {
          const ready = setTimeout(
            () => resolve(json({ id: "slowly-saved" }, 201)),
            21_000,
          );
          options.signal!.addEventListener(
            "abort",
            () => {
              clearTimeout(ready);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    let settled = false;
    const result = api.upload(recording()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ id: "slowly-saved" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a memo upload including a stalled response body at 180 seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal;
    fetchMock.mockImplementationOnce(
      async (_url: string, options: RequestInit) => {
        signal = options.signal!;
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              ),
            ),
        };
      },
    );
    const result = api.upload(recording()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels an upload without mutating its UUID or blob and permits an explicit identical retry", async () => {
    const original = recording();
    const caller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          ),
        ),
    );
    const result = api.upload(original, caller.signal).catch((error) => error);
    caller.abort();
    expect(await result).toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(original.clientId).toBe("unchanged-key");
    expect(await original.blob.text()).toBe("audio-bytes");
    fetchMock.mockResolvedValueOnce(json({ id: "confirmed" }, 200));
    await api.upload(original);
    const first = fetchMock.mock.calls[0][1].body as FormData;
    const retried = fetchMock.mock.calls[1][1].body as FormData;
    expect(first.get("client_id")).toBe(retried.get("client_id"));
    expect(await (retried.get("audio") as Blob).text()).toBe("audio-bytes");
  });
  it("sends an immutable generation version and the same explicit intention key on resend", async () => {
    fetchMock.mockImplementation(async () =>
      json({ id: "job", state: "queued", client_id: "generation-key" }, 202),
    );
    await api.generateAudio("document", "version", "generation-key");
    await api.generateAudio("document", "version", "generation-key");
    expect(fetchMock.mock.calls[0][1].body).toBe(
      fetchMock.mock.calls[1][1].body,
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      document_version: "version",
      client_id: "generation-key",
    });
  });
});
