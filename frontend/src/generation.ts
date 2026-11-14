import type { GenerationJob } from "./types";

export const characterCount = (text: string): number => Array.from(text).length;
export class GenerationIntents {
  private memory = new Map<string, string>();
  private storage?: Pick<Storage, "getItem" | "setItem">;
  constructor(
    private userId: string,
    storage?: Pick<Storage, "getItem" | "setItem">,
  ) {
    try {
      this.storage = storage ?? window.sessionStorage;
    } catch {
      /* Memory still preserves an in-tab unknown outcome. */
    }
  }
  private key(version: string): string {
    return `listen-capture-tts-intent-v1:${this.userId}:${version}`;
  }
  get(version: string): string | undefined {
    const cached = this.memory.get(version);
    if (cached) return cached;
    try {
      const saved = this.storage?.getItem(this.key(version));
      if (
        saved &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          saved,
        )
      ) {
        this.memory.set(version, saved);
        return saved;
      }
    } catch {
      /* Storage can be denied or evicted. */
    }
    return undefined;
  }
  has(version: string): boolean {
    return this.get(version) !== undefined;
  }
  set(version: string, clientId: string): void {
    this.memory.set(version, clientId);
    try {
      this.storage?.setItem(this.key(version), clientId);
    } catch {
      /* Keep the in-memory intention. */
    }
  }
}
export const isGenerationActive = (job?: GenerationJob | null): boolean =>
  job?.state === "queued" || job?.state === "running";
export function restoreGenerationJob(
  job: GenerationJob | null,
  pendingClientId?: string,
): GenerationJob | null {
  // A previous failure is not proof that a newer uncertain intention failed.
  // Re-send that intention's key first, so its durable server receipt decides.
  return pendingClientId &&
    job?.state === "failed" &&
    job.client_id !== pendingClientId
    ? null
    : job;
}
export function generationFailure(code: string | null): string {
  const messages: Record<string, string> = {
    parent_deleted: "元の資料が削除されています。",
    storage_failed: "生成した音声を保存できませんでした。",
    provider_rejected:
      "読み上げサービスが依頼を受け付けませんでした。本文の長さと設定を確認してください。",
    provider_unavailable: "読み上げサービスに接続できませんでした。",
    execution_unknown:
      "処理結果を確認できません。課金が発生した可能性があります。自動で再試行しません。",
    audio_invalid: "生成した音声の形式を確認できませんでした。",
    audio_encoding_failed:
      "音声の圧縮を完了できませんでした。生成済み区間は残っています。設定を確認して再試行してください。",
    audio_too_long:
      "音声の長さが上限に達しました。本文を短く分けてください。全文を読めたとは確認できません。",
    capacity_exceeded:
      "生成処理が混み合っています。時間をおいて確認してください。",
    tts_disabled:
      "読み上げサービスが無効になっています。管理者に設定を確認してください。",
    internal_error: "音声生成を完了できませんでした。",
  };
  return messages[code ?? ""] ?? "音声生成を完了できませんでした。";
}
export function canApplyGeneration(
  expectedDocument: string,
  expectedVersion: string,
  currentDocument: string | undefined,
  currentVersion: string | undefined,
  captureState: string | undefined,
  tab: string,
): boolean {
  return (
    expectedDocument === currentDocument &&
    expectedVersion === currentVersion &&
    captureState === "idle" &&
    tab === "listen"
  );
}

type PollCallbacks = {
  read: (id: string, signal: AbortSignal) => Promise<GenerationJob>;
  receive: (job: GenerationJob, signal: AbortSignal) => void | Promise<void>;
  failed: (error: unknown) => void;
  expired: () => void;
  visible: () => boolean;
};
// Poll only the currently selected job. Leaving the page or the 3 minute budget
// aborts the current read; neither a poll failure nor expiry retries generation.
export class GenerationPoller {
  private epoch = 0;
  private id?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  constructor(private callbacks: PollCallbacks) {}
  start(id: string): void {
    this.stop();
    this.id = id;
    const epoch = this.epoch;
    this.deadline = setTimeout(() => {
      if (epoch !== this.epoch) return;
      this.stop();
      this.callbacks.expired();
    }, 180_000);
    void this.poll(epoch);
  }
  visibilityChanged(): void {
    if (!this.id) return;
    if (!this.callbacks.visible()) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.request?.abort();
      this.request = undefined;
    } else if (!this.request && !this.timer) void this.poll(this.epoch);
  }
  private async poll(epoch: number): Promise<void> {
    if (!this.id || epoch !== this.epoch || !this.callbacks.visible()) return;
    const request = new AbortController();
    this.request = request;
    try {
      const job = await this.callbacks.read(this.id, request.signal);
      if (epoch !== this.epoch || request.signal.aborted) return;
      await this.callbacks.receive(job, request.signal);
      if (epoch !== this.epoch || request.signal.aborted) return;
      if (!isGenerationActive(job)) {
        this.stop();
        return;
      }
    } catch (error) {
      if (epoch !== this.epoch || request.signal.aborted) return;
      this.stop();
      this.callbacks.failed(error);
      return;
    } finally {
      if (this.request === request) this.request = undefined;
    }
    if (epoch === this.epoch && this.callbacks.visible()) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.poll(epoch);
      }, 1500);
    }
  }
  stop(): void {
    this.epoch++;
    this.id = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
  }
}
