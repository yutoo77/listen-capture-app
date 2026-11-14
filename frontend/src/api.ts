import type {
  Document,
  GenerationJob,
  Memo,
  PendingMemo,
  PlaybackProgress,
  PdfImportJob,
  Session,
} from "./types";

let csrfToken = "";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
function errorMessage(data: unknown): string {
  if (typeof data === "string") return data.slice(0, 300);
  if (data && typeof data === "object") {
    if ("detail" in data && typeof data.detail === "string")
      return data.detail.slice(0, 300);
    const values = Object.values(data)
      .flat()
      .filter((v) => typeof v === "string");
    if (values.length) return values.join(" ").slice(0, 300);
  }
  return "リクエストを処理できませんでした。";
}
async function requestWithTimeout<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (
    init.method &&
    !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())
  )
    headers.set("X-CSRFToken", csrfToken);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/${path}`, {
      ...init,
      signal: controller.signal,
      headers,
      credentials: "same-origin",
    });
    if (!response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      throw new ApiError(
        response.status,
        response.status === 403
          ? "セッションまたは操作権限を確認できません。再ログイン後に再送してください。"
          : errorMessage(data),
        data,
      );
    }
    if (response.status === 204) return undefined as T;
    // Await the body here so the deadline also covers a stalled response body.
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      0,
      "サーバーに接続できません。録音は再送欄から確認してください。",
    );
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}
export function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestWithTimeout<T>(path, init, 20_000);
}
export async function session(signal?: AbortSignal): Promise<Session> {
  const result = await request<Session>("session/", { signal });
  // A detached workspace must not replace a newer login's CSRF token, even if
  // its cancelled transport/body reader resolves after cancellation.
  if (signal?.aborted)
    throw new ApiError(0, "セッションの確認を中止しました。");
  csrfToken = result.csrfToken;
  return result;
}
export async function login(
  username: string,
  password: string,
): Promise<Session> {
  const result = await request<Session>("login/", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  csrfToken = result.csrfToken;
  return result;
}
const workspaceHeaders = (userId?: string): HeadersInit =>
  userId ? { "X-Workspace-User": userId } : {};
export const api = {
  pdfImports: (userId?: string) =>
    request<PdfImportJob[]>("pdf-imports/", {
      headers: workspaceHeaders(userId),
    }),
  pdfImport: (id: string, signal?: AbortSignal) =>
    request<PdfImportJob>(`pdf-imports/${encodeURIComponent(id)}/`, { signal }),
  uploadPdf: (
    file: File,
    clientId: string,
    userId: string,
    signal?: AbortSignal,
  ) => {
    const data = new FormData();
    data.set("client_id", clientId);
    data.set("file", file);
    return requestWithTimeout<PdfImportJob>(
      "pdf-imports/",
      {
        method: "POST",
        body: data,
        signal,
        headers: { "X-Workspace-User": userId },
      },
      180_000,
    );
  },
  selectPdfPages: (
    id: string,
    value: {
      client_id: string;
      start_page: number;
      end_page: number;
      revision: number;
    },
    signal?: AbortSignal,
  ) =>
    request<PdfImportJob>(`pdf-imports/${encodeURIComponent(id)}/pages/`, {
      method: "POST",
      body: JSON.stringify(value),
      signal,
    }),
  confirmPdf: (
    id: string,
    clientId: string,
    title: string,
    text: string,
    selectionRevision = 0,
  ) =>
    request<Document>(`pdf-imports/${encodeURIComponent(id)}/confirm/`, {
      method: "POST",
      body: JSON.stringify({
        client_id: clientId,
        title,
        text,
        selection_revision: selectionRevision,
      }),
    }),
  deletePdf: (id: string) =>
    request<void>(`pdf-imports/${encodeURIComponent(id)}/`, {
      method: "DELETE",
    }),
  progress: (audioId: string) =>
    request<PlaybackProgress>(`audio/${encodeURIComponent(audioId)}/progress/`),
  saveProgress: (
    audioId: string,
    value: { position_ms: number; revision: number; client_id: string },
  ) =>
    request<PlaybackProgress>(
      `audio/${encodeURIComponent(audioId)}/progress/`,
      {
        method: "PUT",
        body: JSON.stringify(value),
        keepalive: true,
      },
    ),
  documents: (userId?: string) =>
    request<Document[]>("documents/", { headers: workspaceHeaders(userId) }),
  document: (id: string, signal?: AbortSignal) =>
    request<Document>(`documents/${encodeURIComponent(id)}/`, { signal }),
  createDocument: (title: string, text: string, userId?: string) =>
    request<Document>("documents/", {
      method: "POST",
      headers: workspaceHeaders(userId),
      body: JSON.stringify({ title, text }),
    }),
  updateDocument: (
    id: string,
    title: string,
    text: string,
    expectedVersion: string,
    userId: string,
    expectedUpdatedAt?: string,
  ) =>
    request<Document>(`documents/${encodeURIComponent(id)}/`, {
      method: "PATCH",
      headers: workspaceHeaders(userId),
      body: JSON.stringify({
        title,
        text,
        expected_version: expectedVersion,
        expected_updated_at: expectedUpdatedAt,
      }),
    }),
  demo: (userId?: string) =>
    request<Document>("documents/demo/", {
      method: "POST",
      headers: workspaceHeaders(userId),
    }),
  generateAudio: (
    documentId: string,
    versionId: string,
    clientId: string,
    signal?: AbortSignal,
  ) =>
    request<GenerationJob>(
      `documents/${encodeURIComponent(documentId)}/audio-generation/`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          document_version: versionId,
          client_id: clientId,
        }),
      },
    ),
  generationJob: (id: string, signal?: AbortSignal) =>
    request<GenerationJob>(`audio-generations/${encodeURIComponent(id)}/`, {
      signal,
    }),
  deleteDocument: (id: string) =>
    request<void>(`documents/${encodeURIComponent(id)}/`, { method: "DELETE" }),
  memos: (userId?: string) =>
    request<Memo[]>("memos/", { headers: workspaceHeaders(userId) }),
  updateMemo: (id: string, text: string) =>
    request<Memo>(`memos/${encodeURIComponent(id)}/`, {
      method: "PATCH",
      body: JSON.stringify({ text }),
    }),
  deleteMemo: (id: string) =>
    request<void>(`memos/${encodeURIComponent(id)}/`, { method: "DELETE" }),
  logout: () => request<void>("logout/", { method: "POST" }),
  upload: (memo: PendingMemo, signal?: AbortSignal) => {
    const data = new FormData();
    data.set("client_id", memo.clientId);
    data.set("audio_version", memo.audioVersion);
    data.set("position_ms", String(memo.positionMs));
    data.set("duration_ms", String(memo.durationMs));
    data.set("text", memo.text);
    const extension = memo.blob.type.includes("mp4")
      ? "m4a"
      : memo.blob.type.includes("ogg")
        ? "ogg"
        : "webm";
    data.set("audio", memo.blob, `recording.${extension}`);
    return requestWithTimeout<Memo>(
      "memos/",
      { method: "POST", body: data, signal },
      180_000,
    );
  },
};
