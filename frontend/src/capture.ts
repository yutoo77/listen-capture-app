import type { PendingMemo } from "./types";
import type { AudioPort } from "./player";
import {
  microphoneConstraints,
  microphoneFailure,
  monitorMicrophone,
} from "./microphone";

export type CaptureState =
  "idle" | "starting" | "recording" | "finishing" | "saving";
type Anchor = Pick<
  PendingMemo,
  "userId" | "audioVersion" | "documentId" | "documentTitle"
>;
type CaptureSession = {
  anchor: Anchor;
  clientId: string;
  positionMs: number;
  resume: boolean;
  chunks: Blob[];
  bytes: number;
  cancelled: boolean;
  finalized: boolean;
  stopping: boolean;
  interrupted: boolean;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  startedAt: number;
  stoppedAt?: number;
  clock?: ReturnType<typeof setInterval>;
  limit?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setTimeout>;
  stopMonitor?: () => void;
};
type Callbacks = {
  state: (state: CaptureState) => void;
  status: (message: string) => void;
  elapsed: (milliseconds: number) => void;
  pauseMemos: () => void;
  complete: (memo: PendingMemo) => Promise<boolean>;
  input?: (label: string) => void;
  level?: (value: number | null) => void;
};
export const MAX_RECORD_MS = 60_000;
export const MAX_RECORD_BYTES = 12 * 1024 * 1024;
function audioMode(type: "playback" | "play-and-record"): void {
  try {
    const platform = navigator as Navigator & {
      audioSession?: { type: string };
    };
    if (platform.audioSession) platform.audioSession.type = type;
  } catch {
    /* Optional Safari routing hint, never a prerequisite. */
  }
}
export function recordingSupported(): boolean {
  return Boolean(
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder === "function",
  );
}
export class CaptureController {
  state: CaptureState = "idle";
  private session?: CaptureSession;
  private operation = 0;
  private playbackRequested = false;
  private disposed = false;
  constructor(
    private audio: AudioPort,
    private callbacks: Callbacks,
  ) {}
  private setState(state: CaptureState): void {
    this.state = state;
    if (!this.disposed) this.callbacks.state(state);
  }
  invalidatePlayback(): void {
    this.operation++;
    this.playbackRequested = false;
    this.audio.pause();
  }
  async play(): Promise<boolean> {
    if (this.state !== "idle" || this.disposed) return false;
    const operation = ++this.operation;
    this.playbackRequested = true;
    this.callbacks.pauseMemos();
    audioMode("playback");
    try {
      await this.audio.play();
      if (
        this.state !== "idle" ||
        this.disposed ||
        operation !== this.operation
      ) {
        // A newer play may already have won. Only enforce a current stop or
        // capture intent; an obsolete success must not pause that newer play.
        if (this.state !== "idle" || this.disposed || !this.playbackRequested)
          this.audio.pause();
        return false;
      }
      return true;
    } catch {
      if (operation === this.operation && !this.disposed) {
        this.playbackRequested = false;
        this.callbacks.status(
          "再生ボタンをタップして、元の位置から再開してください。",
        );
      }
      return false;
    }
  }
  async begin(anchor: Anchor, deviceId = ""): Promise<void> {
    if (
      this.state !== "idle" ||
      this.disposed ||
      !recordingSupported() ||
      this.audio.readyState < 1
    )
      return;
    this.operation++;
    this.playbackRequested = false;
    // The anchor and offset are frozen before permission prompts or any asynchronous work.
    const session: CaptureSession = {
      anchor: { ...anchor },
      clientId: crypto.randomUUID(),
      positionMs: Math.max(0, Math.floor(this.audio.currentTime * 1000)),
      resume: !this.audio.paused && !this.audio.ended,
      chunks: [],
      bytes: 0,
      cancelled: false,
      finalized: false,
      stopping: false,
      interrupted: false,
      startedAt: 0,
    };
    this.session = session;
    this.audio.pause();
    this.callbacks.pauseMemos();
    this.setState("starting");
    this.callbacks.status(
      "マイクを準備しています。「録音中」の表示になってから話してください。",
    );
    try {
      audioMode("play-and-record");
      // Never retry a missing explicit input with the browser's default device.
      const stream = await navigator.mediaDevices.getUserMedia(
        microphoneConstraints(deviceId),
      );
      if (
        session.cancelled ||
        this.session !== session ||
        this.disposed ||
        document.hidden
      ) {
        stream.getTracks().forEach((track) => track.stop());
        if (this.session === session) this.cancel();
        return;
      }
      session.stream = stream;
      const input = stream.getAudioTracks()[0];
      if (!input || input.readyState === "ended")
        throw new DOMException("", "NotFoundError");
      const type = [
        "audio/mp4",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ].find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = (session.recorder = new MediaRecorder(
        stream,
        type ? { mimeType: type } : undefined,
      ));
      recorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (!event.data.size || session.finalized) return;
        session.chunks.push(event.data);
        session.bytes += event.data.size;
        if (session.bytes >= MAX_RECORD_BYTES && this.session === session)
          this.stop(true);
      });
      recorder.addEventListener(
        "stop",
        () => {
          void this.finish(session);
        },
        { once: true },
      );
      recorder.addEventListener("error", () => {
        if (this.session === session) this.stop(true);
      });
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          "ended",
          () => {
            if (this.session === session) this.stop(true);
          },
          { once: true },
        );
        track.addEventListener(
          "mute",
          () => {
            if (this.session === session) this.stop(true);
          },
          { once: true },
        );
      }
      recorder.start(1000);
      this.callbacks.input?.(input.label || "名前を取得できないマイク");
      if (this.callbacks.level)
        session.stopMonitor = monitorMicrophone(stream, this.callbacks.level);
      session.startedAt = performance.now();
      session.clock = setInterval(
        () => this.callbacks.elapsed(performance.now() - session.startedAt),
        250,
      );
      session.limit = setTimeout(() => {
        if (this.session === session) this.stop(true);
      }, MAX_RECORD_MS);
      this.callbacks.elapsed(0);
      this.setState("recording");
      this.callbacks.status(
        "録音中です。最大60秒。終わったら「録音を終了」を押してください。",
      );
    } catch (error) {
      this.release(session);
      if (this.session !== session) return;
      this.session = undefined;
      this.setState("idle");
      this.callbacks.status(microphoneFailure(error));
    }
  }
  cancel(): void {
    if (this.state !== "starting" || !this.session) return;
    this.session.cancelled = true;
    this.release(this.session);
    this.session = undefined;
    this.setState("idle");
    this.callbacks.status(
      "録音の準備をキャンセルしました。再生は手動で再開できます。",
    );
  }
  stop(interrupted = false): void {
    const session = this.session;
    if (
      !session ||
      session.finalized ||
      session.stopping ||
      this.state !== "recording"
    )
      return;
    session.stopping = true;
    session.stoppedAt = performance.now();
    session.interrupted = interrupted;
    if (interrupted) session.resume = false;
    clearInterval(session.clock);
    clearTimeout(session.limit);
    session.stopMonitor?.();
    this.setState("finishing");
    this.callbacks.status("録音を終了しています…");
    // A deadline is not proof that the encoder has delivered its final blob.
    // Keep accepting data until the recorder's stop event, or explicit discard.
    session.watchdog = setTimeout(() => {
      if (this.session !== session || session.finalized) return;
      session.interrupted = true;
      session.resume = false;
      this.release(session);
      if (this.session === session && !session.finalized && !this.disposed)
        this.callbacks.status(
          "録音の終了処理が遅れています。音声を受け取り次第保存します。このタブを閉じずにお待ちください。",
        );
    }, 4000);
    try {
      if (session.recorder?.state !== "inactive") session.recorder?.stop();
    } catch {
      session.interrupted = true;
      session.resume = false;
    }
  }
  discard(): boolean {
    const session = this.session;
    if (
      this.disposed ||
      this.state !== "finishing" ||
      !session ||
      session.finalized
    )
      return false;
    // The caller must confirm this irreversible choice. Saving has not started,
    // so there is no outbox/server recording to cancel or remove here.
    session.cancelled = true;
    session.finalized = true;
    session.interrupted = true;
    session.resume = false;
    this.release(session);
    session.chunks = [];
    session.bytes = 0;
    this.session = undefined;
    this.setState("idle");
    this.callbacks.status(
      "終了待ちの録音を破棄しました。サーバーには保存していません。再生は手動で再開してください。",
    );
    return true;
  }
  interrupt(): void {
    if (this.state === "starting") this.cancel();
    else if (this.state === "finishing" && this.session) {
      this.session.interrupted = true;
      this.session.resume = false;
    } else this.stop(true);
  }
  private release(session: CaptureSession): void {
    clearInterval(session.clock);
    clearTimeout(session.limit);
    clearTimeout(session.watchdog);
    session.stopMonitor?.();
    session.stream?.getTracks().forEach((track) => track.stop());
    session.stream = undefined;
    // A cancelled permission promise can reject after a new capture began.
    // Releasing that old session must not change the new microphone's route.
    if (this.session === session) audioMode("playback");
  }
  private async finish(session: CaptureSession): Promise<void> {
    if (session.finalized || session.cancelled || this.session !== session)
      return;
    session.stoppedAt ??= performance.now();
    session.finalized = true;
    this.release(session);
    const blob = new Blob(session.chunks, {
      type:
        session.recorder?.mimeType || session.chunks[0]?.type || "audio/webm",
    });
    let saved = false;
    try {
      if (!blob.size) {
        this.callbacks.status(
          "録音データを受け取れませんでした。もう一度お試しください。",
        );
        return;
      }
      this.setState("saving");
      this.callbacks.status("録音を保存しています…");
      saved = await this.callbacks.complete({
        ...session.anchor,
        clientId: session.clientId,
        positionMs: session.positionMs,
        durationMs: Math.max(
          1,
          Math.min(
            MAX_RECORD_MS,
            Math.round(session.stoppedAt - session.startedAt),
          ),
        ),
        blob,
        createdAt: new Date().toISOString(),
        text: "",
      });
    } catch {
      this.callbacks.status(
        "保存処理を完了できませんでした。端末内の録音を確認してください。",
      );
    } finally {
      if (this.session === session) {
        this.session = undefined;
        this.setState("idle");
      }
    }
    if (this.disposed) return;
    this.audio.currentTime = session.positionMs / 1000;
    if (saved && session.resume && !session.interrupted) await this.play();
    else if (saved)
      this.callbacks.status(
        session.interrupted
          ? "中断した録音をサーバーに保存しました。再生は手動で再開してください。"
          : "録音をサーバーに保存しました。",
      );
  }
  dispose(): void {
    this.disposed = true;
    this.operation++;
    this.playbackRequested = false;
    this.interrupt();
    if (this.state === "finishing" && this.session) this.release(this.session);
    this.audio.pause();
  }
}
