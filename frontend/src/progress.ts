import { ApiError } from "./api";
import type { PlaybackProgress } from "./types";

export type ProgressState =
  "loading" | "saved" | "saving" | "error" | "conflict";
type Write = { position_ms: number; revision: number; client_id: string };
type Transport = {
  progress: (audioId: string) => Promise<PlaybackProgress>;
  saveProgress: (audioId: string, value: Write) => Promise<PlaybackProgress>;
};

// One in-flight write per audio. A failed HTTP response retains the SAME UUID,
// base revision and position, even when playback has continued in the meantime.
export class ProgressTracker {
  state: ProgressState = "loading";
  private snapshot?: PlaybackProgress;
  private pending?: Write;
  private desired?: number;
  private running = false;
  private settled?: Promise<void>;
  private forceDrain = false;
  private disposed = false;
  private retired = false;
  private lastAttempt = 0;
  get ready() {
    return !this.retired && Boolean(this.snapshot) && this.state !== "loading";
  }
  get hasPendingWrite() {
    return !this.retired && Boolean(this.pending);
  }
  constructor(
    readonly audioId: string,
    private transport: Transport,
    private changed: (state: ProgressState) => void,
  ) {}
  private set(state: ProgressState) {
    this.state = state;
    if (!this.disposed) this.changed(state);
  }
  async load(): Promise<PlaybackProgress | undefined> {
    this.snapshot = undefined;
    this.pending = undefined;
    this.desired = undefined;
    this.forceDrain = false;
    this.set("loading");
    try {
      const value = await this.transport.progress(this.audioId);
      if (this.disposed) return;
      this.snapshot = value;
      this.desired = value.position_ms;
      this.pending = undefined;
      this.set("saved");
      return value;
    } catch {
      if (!this.disposed) this.set("error");
    }
  }
  observe(position: number, force = false) {
    if (!this.ready || this.disposed || this.state === "conflict") return;
    this.desired = Math.max(0, Math.round(position));
    if (force) this.forceDrain = true;
    if (this.state === "error") return; // Explicit retry; no silent retry storm.
    if (force || Date.now() - this.lastAttempt >= 10_000) void this.flush();
  }
  flush(): Promise<void> {
    if (this.retired) return Promise.resolve();
    if (this.running) return this.settled ?? Promise.resolve();
    if (!this.snapshot || this.state === "loading" || this.state === "conflict")
      return Promise.resolve();
    if (!this.pending && this.desired === this.snapshot.position_ms) {
      this.forceDrain = false;
      return Promise.resolve();
    }
    this.settled = this.write();
    return this.settled;
  }
  private async write(): Promise<void> {
    if (!this.snapshot) return;
    this.running = true;
    this.forceDrain = Boolean(
      this.pending && this.desired !== this.pending.position_ms,
    );
    this.lastAttempt = Date.now();
    this.pending ??= {
      position_ms: this.desired ?? this.snapshot.position_ms,
      revision: this.snapshot.revision,
      client_id: crypto.randomUUID(),
    };
    this.set("saving");
    let saved = false;
    try {
      const savedSnapshot = await this.transport.saveProgress(
        this.audioId,
        this.pending,
      );
      if (this.retired) return;
      this.snapshot = savedSnapshot;
      this.pending = undefined;
      saved = true;
      this.set("saved");
    } catch (error) {
      if (this.retired) return;
      this.set(
        error instanceof ApiError && error.status === 409
          ? "conflict"
          : "error",
      );
    } finally {
      this.running = false;
    }
    // Drain a seek/pause made while a request was in flight. After disposal the
    // old audio's final update may finish, but cannot touch the next player.
    if (saved && this.forceDrain && this.desired !== this.snapshot.position_ms)
      await this.flush();
  }
  retry() {
    return this.snapshot ? this.flush() : this.load();
  }
  dispose() {
    this.disposed = true;
  }
  retire() {
    this.retired = true;
    this.disposed = true;
    this.pending = undefined;
    this.desired = undefined;
  }
}
