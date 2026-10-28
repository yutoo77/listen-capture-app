import { request } from "./api";

// Every consumer, including recording and progress, uses this logical clock.
export interface AudioPort {
  currentTime: number;
  readonly duration: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly ended: boolean;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
}
export type MediaPart = {
  index: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  media_url: string;
  content_type: string;
  size_bytes: number;
};
export type Playlist = {
  audio_version: string;
  document_version: string;
  delivery: "single" | "playlist";
  duration_ms: number;
  segments: MediaPart[];
};
export type PlayerEvent = {
  type:
    | "loadedmetadata"
    | "timeupdate"
    | "seeked"
    | "play"
    | "pause"
    | "ended"
    | "error"
    | "loading"
    | "transition"
    | "blocked";
  audioId: string;
  index: number;
  gap_ms?: number;
};
type Slot = {
  element: HTMLAudioElement;
  index: number | null;
  epoch: number;
  offset: number | null;
  url: string;
};
export function partAt(parts: MediaPart[], milliseconds: number): number {
  return parts.findIndex(
    (part, index) =>
      milliseconds >= part.start_ms &&
      (milliseconds < part.end_ms ||
        (index === parts.length - 1 && milliseconds === part.end_ms)),
  );
}
export function parsePlaylist(
  value: unknown,
  audioId: string,
  versionId: string,
): Playlist {
  const data = value as Playlist;
  if (
    !data ||
    data.audio_version !== audioId ||
    data.document_version !== versionId ||
    !["single", "playlist"].includes(data.delivery) ||
    !Number.isSafeInteger(data.duration_ms) ||
    data.duration_ms <= 0 ||
    data.duration_ms > 3_600_000 ||
    !Array.isArray(data.segments) ||
    data.segments.length < 1 ||
    data.segments.length > 200
  )
    throw new Error("音声の構成を確認できません。");
  let cursor = 0;
  for (const [index, part] of data.segments.entries()) {
    if (
      part.index !== index ||
      !Number.isSafeInteger(part.start_ms) ||
      part.start_ms !== cursor ||
      !Number.isSafeInteger(part.end_ms) ||
      part.end_ms <= cursor ||
      part.duration_ms !== part.end_ms - cursor ||
      typeof part.media_url !== "string" ||
      !part.media_url.startsWith(
        `/api/audio/${encodeURIComponent(audioId)}/`,
      ) ||
      part.media_url.includes("?") ||
      part.media_url.includes("#") ||
      part.media_url.includes("..") ||
      !Number.isSafeInteger(part.size_bytes) ||
      (data.delivery === "playlist"
        ? part.size_bytes <= 0
        : part.size_bytes < 0)
    )
      throw new Error("音声の区間を確認できません。");
    cursor = part.end_ms;
  }
  if (
    cursor !== data.duration_ms ||
    (data.delivery === "single" && data.segments.length !== 1)
  )
    throw new Error("音声の長さが一致しません。");
  return data;
}
export async function loadPlaylist(
  audioId: string,
  versionId: string,
  signal: AbortSignal,
): Promise<Playlist> {
  return parsePlaylist(
    await request<unknown>(`audio/${encodeURIComponent(audioId)}/playlist/`, {
      signal,
    }),
    audioId,
    versionId,
  );
}

export class LogicalPlayer implements AudioPort {
  private manifest: Playlist | null = null;
  private slots: [Slot, Slot];
  private active = 0;
  private epoch = 0;
  private operation = 0;
  private target = 0;
  private wanted = false;
  private speed = 1;
  private failed = false;
  private disposed = false;
  private transitionStart: number | null = null;
  private pending = new Set<() => void>();
  private unbind: (() => void)[] = [];
  constructor(
    elements: [HTMLAudioElement, HTMLAudioElement],
    private notify: (event: PlayerEvent) => void,
  ) {
    this.slots = elements.map((element) => ({
      element,
      index: null,
      epoch: 0,
      offset: null,
      url: "",
    })) as [Slot, Slot];
    for (const slot of this.slots) {
      const bind = (type: string, handler: () => void) => {
        slot.element.addEventListener(type, handler);
        this.unbind.push(() => slot.element.removeEventListener(type, handler));
      };
      bind("loadedmetadata", () => this.metadata(slot));
      bind("timeupdate", () => {
        if (this.current(slot) && slot.offset === null) {
          this.target = this.readClock();
          this.emit("timeupdate");
        }
      });
      bind("seeked", () => {
        if (this.current(slot) && slot.offset === null) {
          this.target = this.readClock();
          this.emit("seeked");
        }
      });
      bind("playing", () => {
        if (!this.current(slot)) {
          slot.element.pause();
          return;
        }
        if (!this.wanted) {
          slot.element.pause();
          return;
        }
        if (this.transitionStart !== null) {
          this.emit(
            "transition",
            Math.max(0, performance.now() - this.transitionStart),
          );
          this.transitionStart = null;
        }
        this.emit("play");
      });
      bind("ended", () => this.end(slot));
      bind("pause", () => {
        if (
          this.current(slot) &&
          this.wanted &&
          slot.element.paused &&
          !slot.element.ended &&
          slot.offset === null
        )
          this.pause();
      });
      bind("error", () => {
        if (!this.current(slot)) return; // A failed prefetch is retried only if it becomes current.
        this.fail();
      });
      // Native pause during src changes must never persist a local zero clock.
    }
  }
  private get slot() {
    return this.slots[this.active];
  }
  private current(slot: Slot) {
    return (
      !this.disposed &&
      slot === this.slot &&
      slot.epoch === this.epoch &&
      slot.index !== null &&
      Boolean(this.manifest)
    );
  }
  private emit(type: PlayerEvent["type"], gap_ms?: number) {
    if (!this.manifest || this.disposed) return;
    this.notify({
      type,
      audioId: this.manifest.audio_version,
      index: this.slot.index ?? 0,
      ...(gap_ms !== undefined ? { gap_ms } : {}),
    });
  }
  private readClock() {
    const part = this.manifest?.segments[this.slot.index ?? -1];
    if (!part || this.slot.offset !== null || this.slot.element.readyState < 1)
      return this.target;
    return Math.min(
      part.end_ms / 1000,
      Math.max(
        part.start_ms / 1000,
        part.start_ms / 1000 + this.slot.element.currentTime,
      ),
    );
  }
  get currentTime() {
    return this.readClock();
  }
  set currentTime(value: number) {
    this.seek(value);
  }
  get duration() {
    return (this.manifest?.duration_ms ?? 0) / 1000;
  }
  get readyState() {
    return this.failed || this.slot.offset !== null
      ? 0
      : this.slot.element.readyState;
  }
  get paused() {
    return !this.wanted;
  }
  get ended() {
    return (
      Boolean(this.manifest) &&
      this.currentTime >= this.duration &&
      !this.wanted
    );
  }
  get playbackRate() {
    return this.speed;
  }
  set playbackRate(value: number) {
    if (!Number.isFinite(value) || value < 0.5 || value > 3) return;
    this.speed = value;
    for (const slot of this.slots) {
      slot.element.defaultPlaybackRate = value;
      slot.element.playbackRate = value;
    }
  }
  get activeElement() {
    return this.slot.element;
  }
  get hasError() {
    return this.failed;
  }
  setPlaylist(manifest: Playlist | null) {
    this.pause();
    this.epoch++;
    this.operation++;
    this.manifest = manifest;
    this.target = 0;
    this.failed = false;
    this.active = 0;
    this.transitionStart = null;
    for (const slot of this.slots) {
      slot.element.pause();
      slot.index = null;
      slot.epoch = this.epoch;
      slot.offset = null;
      slot.url = "";
      slot.element.removeAttribute("src");
      slot.element.load();
      slot.element.removeAttribute("data-testid");
    }
    if (manifest) {
      this.load(this.slot, 0, 0);
      this.prefetch();
      this.emit("loading");
    }
    this.wake();
  }
  private load(slot: Slot, index: number, offset: number | null) {
    const part = this.manifest!.segments[index];
    slot.index = index;
    slot.epoch = this.epoch;
    slot.offset = offset;
    slot.url = new URL(part.media_url, location.origin).href;
    slot.element.preload = "auto";
    slot.element.defaultPlaybackRate = this.speed;
    slot.element.src = part.media_url;
    slot.element.load();
    slot.element.playbackRate = this.speed;
    this.tag();
  }
  private tag() {
    for (const slot of this.slots) {
      if (slot === this.slot)
        slot.element.setAttribute("data-testid", "source-audio");
      else slot.element.removeAttribute("data-testid");
    }
  }
  private prefetch() {
    if (!this.manifest || this.slot.index === null) return;
    const next = this.slot.index + 1;
    const spare = this.slots[1 - this.active];
    if (next < this.manifest.segments.length) {
      if (
        spare.index !== next ||
        spare.epoch !== this.epoch ||
        spare.element.error
      )
        this.load(spare, next, null);
    } else if (spare.index !== null) {
      spare.element.pause();
      spare.index = null;
      spare.url = "";
      spare.element.removeAttribute("src");
      spare.element.load();
    }
  }
  private metadata(slot: Slot) {
    if (
      slot.epoch !== this.epoch ||
      slot.index === null ||
      slot.element.readyState < 1 ||
      (slot.element.currentSrc && slot.element.currentSrc !== slot.url)
    )
      return;
    // Native load() may restore defaultPlaybackRate asynchronously. Every
    // newly ready asset must inherit the logical lesson speed.
    slot.element.playbackRate = this.speed;
    if (slot.offset !== null) {
      const offset = slot.offset;
      slot.offset = null;
      slot.element.currentTime = offset;
    }
    if (this.current(slot)) {
      this.failed = false;
      this.emit("loadedmetadata");
      this.wake();
    }
  }
  private wake() {
    for (const resolve of this.pending) resolve();
  }
  private async waitReady(epoch: number, operation: number) {
    if (this.readyState >= 1) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        if (
          this.disposed ||
          this.epoch !== epoch ||
          this.operation !== operation ||
          this.failed ||
          this.readyState >= 1
        ) {
          clearTimeout(timer);
          this.pending.delete(done);
          if (this.failed) reject(new Error("音声の区間を読み込めません。"));
          else resolve();
        }
      };
      const timer = setTimeout(() => {
        this.pending.delete(done);
        this.fail();
        reject(new Error("音声の読込がタイムアウトしました。"));
      }, 20_000);
      this.pending.add(done);
      done();
    });
  }
  private async start(epoch: number, operation: number) {
    await this.waitReady(epoch, operation);
    if (
      this.disposed ||
      this.epoch !== epoch ||
      this.operation !== operation ||
      !this.wanted
    )
      throw new DOMException("Superseded playback", "AbortError");
    const slot = this.slot;
    try {
      await slot.element.play();
    } catch (error) {
      if (this.epoch === epoch && this.operation === operation) {
        this.wanted = false;
        this.emit("pause");
      }
      throw error;
    }
    if (
      this.disposed ||
      this.epoch !== epoch ||
      this.operation !== operation ||
      !this.wanted
    ) {
      if (slot !== this.slot || !this.wanted) slot.element.pause();
      throw new DOMException("Superseded playback", "AbortError");
    }
  }
  async play() {
    if (!this.manifest || this.failed)
      throw new Error("音声を再読込してください。");
    if (this.ended) this.seek(0);
    this.wanted = true;
    const operation = ++this.operation;
    return this.start(this.epoch, operation);
  }
  pause() {
    const wasPlaying = this.wanted;
    this.target = this.readClock();
    this.wanted = false;
    this.operation++;
    this.transitionStart = null;
    for (const slot of this.slots) slot.element.pause();
    this.wake();
    if (wasPlaying) this.emit("pause");
  }
  private seek(seconds: number) {
    if (!this.manifest || !Number.isFinite(seconds)) return;
    const resume = this.wanted;
    const epoch = this.epoch;
    this.pause();
    this.target = Math.min(this.duration, Math.max(0, seconds));
    this.failed = false;
    const index = partAt(
      this.manifest.segments,
      Math.round(this.target * 1000),
    );
    if (index < 0) return;
    const local = this.target - this.manifest.segments[index].start_ms / 1000;
    if (this.slot.index !== index) {
      const spare = this.slots[1 - this.active];
      if (
        spare.index === index &&
        spare.epoch === epoch &&
        !spare.element.error
      ) {
        this.active = 1 - this.active;
        this.tag();
        this.slot.offset = local;
        this.metadata(this.slot);
      } else this.load(this.slot, index, local);
    } else {
      this.slot.offset = local;
      this.metadata(this.slot);
    }
    this.prefetch();
    this.emit(this.readyState >= 1 ? "seeked" : "loading");
    this.emit("timeupdate");
    if (resume) {
      this.wanted = true;
      const operation = ++this.operation;
      void this.start(epoch, operation).catch((error) =>
        this.resumeFailure(error, epoch, operation),
      );
    }
  }
  private end(slot: Slot) {
    if (
      !this.current(slot) ||
      !this.wanted ||
      slot.offset !== null ||
      !slot.element.ended
    )
      return;
    const index = slot.index!;
    this.target = this.manifest!.segments[index].end_ms / 1000;
    if (index + 1 >= this.manifest!.segments.length) {
      this.wanted = false;
      this.emit("timeupdate");
      this.emit("ended");
      return;
    }
    this.transitionStart = performance.now();
    const epoch = this.epoch;
    const operation = ++this.operation;
    const spare = this.slots[1 - this.active];
    this.active = 1 - this.active;
    this.tag();
    if (
      spare.index !== index + 1 ||
      spare.epoch !== epoch ||
      spare.element.error
    )
      this.load(spare, index + 1, 0);
    else {
      spare.offset = 0;
      this.metadata(spare);
    }
    this.prefetch();
    this.emit(this.readyState >= 1 ? "timeupdate" : "loading");
    void this.start(epoch, operation).catch((error) =>
      this.resumeFailure(error, epoch, operation),
    );
  }
  private resumeFailure(error: unknown, epoch: number, operation: number) {
    // A browser may reject an old play() only after a seek, recording pause or
    // version switch has already won. It must not stop the newer operation.
    if (this.disposed || this.epoch !== epoch || this.operation !== operation)
      return;
    if (error instanceof Error && error.name === "AbortError") return;
    if (error instanceof Error && error.name === "NotAllowedError") {
      this.wanted = false;
      this.emit("blocked");
      return;
    }
    this.fail();
  }
  private fail() {
    this.target = this.readClock();
    this.pause();
    this.failed = true;
    this.emit("error");
    this.wake();
  }
  retry() {
    if (!this.manifest) return;
    const target = this.target;
    this.pause();
    this.failed = false;
    const index = partAt(this.manifest.segments, Math.round(target * 1000));
    this.load(
      this.slot,
      index,
      target - this.manifest.segments[index].start_ms / 1000,
    );
    this.prefetch();
    this.emit("loading");
  }
  dispose() {
    this.pause();
    this.disposed = true;
    this.epoch++;
    this.wake();
    for (const unbind of this.unbind) unbind();
    for (const slot of this.slots) {
      slot.element.removeAttribute("src");
      slot.element.load();
    }
  }
}
