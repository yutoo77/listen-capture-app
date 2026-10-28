import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogicalPlayer, parsePlaylist, partAt } from "./player";
import type { PlayerEvent, Playlist } from "./player";
import { ProgressTracker } from "./progress";

const origin = "http://localhost:5173";
const audioId = "logical-audio";
const versionId = "immutable-text-version";

class FakeAudio extends EventTarget {
  private source = "";
  attributes = new Map<string, string>();
  currentSrc = "";
  currentTime = 0;
  duration = 300;
  readyState = 0;
  ended = false;
  paused = true;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preload = "none";
  error: MediaError | null = null;
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value ? new URL(value, origin).href : "";
  }
  load = vi.fn(() => {
    this.currentSrc = "";
    this.currentTime = 0;
    this.readyState = 0;
    this.ended = false;
    this.error = null;
    this.paused = true;
    // Native resource selection restores the media element's default rate.
    this.playbackRate = this.defaultPlaybackRate;
  });
  play = vi.fn(async () => {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("playing"));
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
    if (name === "src") this.src = value;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }
  getAttribute(name: string) {
    return name === "src"
      ? this.src || null
      : (this.attributes.get(name) ?? null);
  }
  ready() {
    this.currentSrc = this.src;
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  tick(seconds: number) {
    this.currentTime = seconds;
    this.dispatchEvent(new Event("timeupdate"));
  }
  finish(seconds = this.duration) {
    this.currentTime = seconds;
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }
  fail() {
    this.error = { code: 2 } as MediaError;
    this.dispatchEvent(new Event("error"));
  }
}

function manifest(durations = [300_000, 300_000, 300_000]): Playlist {
  let cursor = 0;
  return {
    audio_version: audioId,
    document_version: versionId,
    delivery: durations.length === 1 ? "single" : "playlist",
    duration_ms: durations.reduce((sum, duration) => sum + duration, 0),
    segments: durations.map((duration, index) => {
      const start = cursor;
      cursor += duration;
      return {
        index,
        start_ms: start,
        end_ms: cursor,
        duration_ms: duration,
        media_url: `/api/audio/${audioId}/segments/${index}/content/`,
        content_type: "audio/wav",
        size_bytes: duration * 32 + 44,
      };
    }),
  };
}

const players: LogicalPlayer[] = [];
function setup(value = manifest(), notify?: (event: PlayerEvent) => void) {
  const a = new FakeAudio();
  const b = new FakeAudio();
  const events: (PlayerEvent & { clock: number })[] = [];
  const player = new LogicalPlayer(
    [a, b] as unknown as [HTMLAudioElement, HTMLAudioElement],
    (event) => {
      events.push({ ...event, clock: player.currentTime });
      notify?.(event);
    },
  );
  players.push(player);
  player.setPlaylist(value);
  return { a, b, player, events };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("location", { origin });
});
afterEach(() => {
  players.splice(0).forEach((player) => player.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("immutable logical audio manifest", () => {
  it("accepts a bounded hour and legacy single audio, using half-open boundaries", () => {
    const hour = manifest(Array<number>(12).fill(300_000));
    expect(parsePlaylist(hour, audioId, versionId)).toEqual(hour);
    expect(parsePlaylist(manifest([12_345]), audioId, versionId).delivery).toBe(
      "single",
    );
    expect(partAt(hour.segments, 299_999)).toBe(0);
    expect(partAt(hour.segments, 300_000)).toBe(1);
    expect(partAt(hour.segments, 3_600_000)).toBe(11);
    expect(partAt(hour.segments, -1)).toBe(-1);
    expect(partAt(hour.segments, 3_600_001)).toBe(-1);
  });
  it("refuses another version, gaps, overlaps, out-of-scope URLs and excess duration", () => {
    const invalid = [
      null,
      { ...manifest(), audio_version: "another-audio" },
      { ...manifest(), document_version: "another-version" },
      manifest(Array<number>(13).fill(300_000)),
      { ...manifest(), segments: [] },
      { ...manifest(), delivery: "single" },
      { ...manifest(), duration_ms: 900_001 },
      ...[
        { start_ms: 300_001 },
        { start_ms: 299_999 },
        { index: 9 },
        { duration_ms: 20 },
        { size_bytes: 0 },
        { media_url: "https://example.invalid/private.wav" },
        { media_url: "/api/audio/someone-else/segments/1/content/" },
        { media_url: `/api/audio/${audioId}/../private/` },
        { media_url: `/api/audio/${audioId}/content/?signature=secret` },
      ].map((change) => {
        const value = manifest();
        value.segments[1] = { ...value.segments[1], ...change };
        return value;
      }),
    ];
    for (const value of invalid)
      expect(() => parsePlaylist(value, audioId, versionId)).toThrow();
  });
  it("accepts an unknown legacy single-file size but rejects unknown playlist-asset sizes", () => {
    const legacy = manifest([12_345]);
    legacy.segments[0].size_bytes = 0;
    expect(parsePlaylist(legacy, audioId, versionId)).toEqual(legacy);
    legacy.segments[0].size_bytes = -1;
    expect(() => parsePlaylist(legacy, audioId, versionId)).toThrow();
    const playlist = manifest();
    playlist.segments[0].size_bytes = 0;
    expect(() => parsePlaylist(playlist, audioId, versionId)).toThrow();
  });
});

describe("logical player across physical audio boundaries", () => {
  it("preserves the selected speed across native load resets, delayed metadata and the next asset", async () => {
    const { player, a, b } = setup();
    a.ready();
    player.playbackRate = 1.5;
    expect([a.defaultPlaybackRate, b.defaultPlaybackRate]).toEqual([1.5, 1.5]);

    // Seeking to an asset outside the two initial slots selects a new resource.
    // load() resets its native rate, while the logical lesson remains at 1.5x.
    player.currentTime = 650;
    expect(a.load).toHaveBeenCalled();
    expect(a.playbackRate).toBe(1.5);
    expect(player.playbackRate).toBe(1.5);
    // A queued browser resource-selection step can apply an older default just
    // before metadata arrives; the newly ready asset must reassert the speed.
    a.playbackRate = 1;
    a.ready();
    expect(a.playbackRate).toBe(1.5);
    expect(player.currentTime).toBe(650);
    expect(player.paused).toBe(true);

    player.currentTime = 300;
    a.ready();
    b.ready();
    await player.play();
    a.finish();
    await settle();
    expect(player.activeElement).toBe(b);
    expect(b.playbackRate).toBe(1.5);
    expect(player.playbackRate).toBe(1.5);
    expect(player.currentTime).toBe(600);
  });
  it("seeks beyond ten minutes and exposes a global clock while the native asset uses a local clock", () => {
    const { player, a } = setup();
    a.ready();
    player.currentTime = 612.5;
    expect(player.currentTime).toBe(612.5);
    expect(player.readyState).toBe(0);
    expect(a.currentTime).toBe(0);
    a.ready();
    expect(a.currentTime).toBe(12.5);
    expect(player.currentTime).toBe(612.5);
    expect(player.duration).toBe(900);
    a.tick(13.75);
    expect(player.currentTime).toBe(613.75);
  });
  it("continues to the prefetched segment while keeping at most two sources and one stable audio identity", async () => {
    const { player, a, b, events } = setup();
    a.ready();
    b.ready();
    player.playbackRate = 1.5;
    await player.play();
    a.finish();
    await settle();
    expect(player.activeElement).toBe(b);
    expect(player.paused).toBe(false);
    expect(player.currentTime).toBe(300);
    expect(b.play).toHaveBeenCalledOnce();
    expect(a.src).toContain("/segments/2/content/");
    expect(b.src).toContain("/segments/1/content/");
    expect([a.playbackRate, b.playbackRate]).toEqual([1.5, 1.5]);
    b.tick(19.25);
    expect(player.currentTime).toBe(319.25);
    expect(events.filter((event) => event.type === "transition")).toHaveLength(
      1,
    );
    expect(events.every((event) => event.audioId === audioId)).toBe(true);
    expect(events.at(-1)?.clock).toBe(319.25);
  });
  it("uses a deterministic next segment at an exact boundary and remains manually paused", () => {
    const { player, a, b } = setup();
    a.ready();
    b.ready();
    player.currentTime = 300;
    expect(player.activeElement).toBe(b);
    expect(b.currentTime).toBe(0);
    expect(player.currentTime).toBe(300);
    expect(player.paused).toBe(true);
    expect(b.play).not.toHaveBeenCalled();
  });
  it("does not advance or autoplay after a recording pause wins against ended", async () => {
    const { player, a, b } = setup();
    a.ready();
    b.ready();
    await player.play();
    a.currentTime = 300;
    player.pause();
    const frozenRecordingPosition = player.currentTime;
    a.finish();
    await settle();
    expect(frozenRecordingPosition).toBe(300);
    expect(player.activeElement).toBe(a);
    expect(player.paused).toBe(true);
    expect(b.play).not.toHaveBeenCalled();
    player.currentTime = frozenRecordingPosition;
    await player.play();
    expect(player.activeElement).toBe(b);
    expect(player.currentTime).toBe(300);
    expect(b.play).toHaveBeenCalledOnce();
  });
  it("cancels a handover waiting for metadata without later autoplay when recording pauses it", async () => {
    const { player, a, b } = setup();
    a.ready();
    await player.play();
    a.finish();
    expect(player.currentTime).toBe(300);
    expect(player.readyState).toBe(0);
    player.pause();
    b.ready();
    await settle();
    expect(player.currentTime).toBe(300);
    expect(player.paused).toBe(true);
    expect(b.play).not.toHaveBeenCalled();
  });
  it("keeps the boundary ready for manual resume when the browser blocks automatic handover", async () => {
    const { player, a, b, events } = setup();
    a.ready();
    b.ready();
    await player.play();
    b.play.mockRejectedValueOnce(
      new DOMException("Synthetic autoplay policy", "NotAllowedError"),
    );
    a.finish();
    await settle();
    await settle();
    expect(player.currentTime).toBe(300);
    expect(player.readyState).toBe(1);
    expect(player.hasError).toBe(false);
    expect(player.paused).toBe(true);
    expect(events.some((event) => event.type === "blocked")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
    await player.play();
    expect(player.currentTime).toBe(300);
    expect(player.paused).toBe(false);
    expect(b.play).toHaveBeenCalledTimes(2);
  });
  it("ignores ended from an old slot and late metadata for the previous URL of a reused slot", async () => {
    const { player, a, b } = setup();
    a.ready();
    b.ready();
    await player.play();
    a.finish();
    await settle();
    a.dispatchEvent(new Event("ended"));
    expect(player.activeElement).toBe(b);
    player.pause();
    player.currentTime = 700;
    const active = player.activeElement as unknown as FakeAudio;
    active.readyState = 1;
    active.currentSrc = `${origin}/api/audio/${audioId}/segments/0/content/`;
    active.dispatchEvent(new Event("loadedmetadata"));
    expect(player.readyState).toBe(0);
    expect(player.currentTime).toBe(700);
    active.ready();
    expect(player.readyState).toBe(1);
    expect(active.currentTime).toBe(100);
    expect(player.currentTime).toBe(700);
  });
  it("fences a delayed play promise after switching immutable audio versions", async () => {
    const { player, a, b } = setup();
    a.ready();
    let resolve!: () => void;
    a.play.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const pending = player.play();
    await settle();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    player.setPlaylist({ ...manifest(), audio_version: "new-logical-audio" });
    resolve();
    await rejected;
    a.ready();
    b.ready();
    expect(player.paused).toBe(true);
    expect(player.currentTime).toBe(0);
    expect(b.play).not.toHaveBeenCalled();
  });
  it.each(["NotAllowedError", "NotSupportedError"])(
    "ignores a late %s from a superseded automatic handover",
    async (name) => {
      const { player, a, b, events } = setup();
      a.ready();
      b.ready();
      await player.play();
      let reject!: (reason: unknown) => void;
      b.play.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      );
      a.finish();
      await settle();
      expect(b.play).toHaveBeenCalledOnce();

      // The user has already selected another immutable audio version and
      // successfully resumed before the browser rejects the previous play().
      player.setPlaylist({ ...manifest(), audio_version: "new-logical-audio" });
      a.ready();
      b.ready();
      player.currentTime = 125;
      await player.play();
      const eventsBeforeRejection = events.length;
      reject(new DOMException("Delayed previous-resource rejection", name));
      await settle();
      await settle();
      expect(player.paused).toBe(false);
      expect(player.hasError).toBe(false);
      expect(player.currentTime).toBe(125);
      expect(events.slice(eventsBeforeRejection)).toEqual([]);
    },
  );
  it("retries a failed prefetch only when it becomes current and preserves the boundary", async () => {
    const { player, a, b, events } = setup();
    a.ready();
    b.fail();
    expect(player.hasError).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(false);
    await player.play();
    const loadsBeforeBoundary = b.load.mock.calls.length;
    a.finish();
    expect(b.load).toHaveBeenCalledTimes(loadsBeforeBoundary + 1);
    expect(player.currentTime).toBe(300);
    expect(player.readyState).toBe(0);
    b.ready();
    await settle();
    expect(player.currentTime).toBe(300);
    expect(player.paused).toBe(false);
    expect(player.hasError).toBe(false);
    expect(b.play).toHaveBeenCalledOnce();
  });
  it("keeps the newer seek playing when an earlier seek rejects on the same audio version", async () => {
    const { player, a, b, events } = setup();
    a.ready();
    b.ready();
    await player.play();
    let reject!: (reason: unknown) => void;
    b.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    player.currentTime = 325;
    await settle();
    expect(b.play).toHaveBeenCalledOnce();
    player.currentTime = 650;
    a.ready();
    await settle();
    expect(player.activeElement).toBe(a);
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(player.paused).toBe(false);
    const eventsBeforeRejection = events.length;
    reject(
      new DOMException(
        "Previous seek rejected after a new seek",
        "NotSupportedError",
      ),
    );
    await settle();
    await settle();
    expect(player.currentTime).toBe(650);
    expect(player.paused).toBe(false);
    expect(player.hasError).toBe(false);
    expect(events.slice(eventsBeforeRejection)).toEqual([]);
  });
  it("ignores a queued old native pause event after the reused element has already resumed", async () => {
    const { player, a } = setup();
    a.ready();
    await player.play();
    player.currentTime = 650;
    a.ready();
    await settle();
    expect(a.paused).toBe(false);
    expect(player.paused).toBe(false);
    // Browser event delivery can lag behind pause()/load()/play(). The event
    // must be interpreted using the element's current playback state.
    a.dispatchEvent(new Event("pause"));
    expect(player.paused).toBe(false);
    expect(player.currentTime).toBe(650);
  });
  it("retains the global failed seek and only retries the same asset without autoplay", async () => {
    const { player, a, b } = setup();
    a.ready();
    player.currentTime = 650.25;
    a.fail();
    expect(player.hasError).toBe(true);
    expect(player.currentTime).toBe(650.25);
    expect(player.paused).toBe(true);
    expect(player.readyState).toBe(0);
    const expectedSource = a.src;
    player.retry();
    expect(a.src).toBe(expectedSource);
    a.ready();
    await settle();
    expect(a.currentTime).toBe(50.25);
    expect(player.currentTime).toBe(650.25);
    expect(player.hasError).toBe(false);
    expect(a.play).not.toHaveBeenCalled();
    expect(b.play).not.toHaveBeenCalled();
    await player.play();
    expect(a.play).toHaveBeenCalledOnce();
  });
  it("never sends transient native zero clocks to progress during source loading", async () => {
    const transport = {
      progress: vi.fn().mockResolvedValue({
        audio_version: audioId,
        position_ms: 0,
        revision: 0,
        updated_at: null,
      }),
      saveProgress: vi
        .fn()
        .mockImplementation(
          async (
            _id: string,
            value: { position_ms: number; revision: number },
          ) => ({
            audio_version: audioId,
            position_ms: value.position_ms,
            revision: value.revision + 1,
            updated_at: null,
          }),
        ),
    };
    const tracker = new ProgressTracker(audioId, transport, vi.fn());
    await tracker.load();
    const { player, a, b } = setup(manifest(), (event) => {
      if (["timeupdate", "pause", "seeked"].includes(event.type))
        tracker.observe(player.currentTime * 1000, true);
    });
    a.ready();
    a.tick(150);
    await tracker.flush();
    player.currentTime = 650;
    a.tick(0);
    b.tick(0);
    a.pause();
    b.pause();
    expect(player.currentTime).toBe(650);
    a.ready();
    a.dispatchEvent(new Event("seeked"));
    await tracker.flush();
    expect(
      transport.saveProgress.mock.calls.map((call) => call[1].position_ms),
    ).toEqual([150_000, 650_000]);
    tracker.dispose();
  });
  it("turns a metadata timeout into an explicit error and cancels timers when disposed", async () => {
    const { player, a, b } = setup();
    const playing = player.play();
    const rejected = expect(playing).rejects.toThrow("タイムアウト");
    await vi.advanceTimersByTimeAsync(20_001);
    await rejected;
    expect(player.hasError).toBe(true);
    expect(player.paused).toBe(true);
    expect(a.play).not.toHaveBeenCalled();
    expect(b.play).not.toHaveBeenCalled();
    player.dispose();
    expect([a.src, b.src]).toEqual(["", ""]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
