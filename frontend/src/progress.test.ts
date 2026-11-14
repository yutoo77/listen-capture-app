import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { ProgressTracker } from "./progress";
import type { PlaybackProgress } from "./types";

const snapshot = (position_ms = 0, revision = 0): PlaybackProgress => ({
  audio_version: "audio-a",
  position_ms,
  revision,
  updated_at: null,
});
function setup() {
  const transport = {
    progress: vi.fn().mockResolvedValue(snapshot(12000, 3)),
    saveProgress: vi
      .fn()
      .mockImplementation(async (_id, value) =>
        snapshot(value.position_ms, value.revision + 1),
      ),
  };
  const changed = vi.fn();
  return {
    transport,
    changed,
    tracker: new ProgressTracker("audio-a", transport, changed),
  };
}
describe("playback progress failure and concurrency handling", () => {
  it("restores server position and does not write just by opening the player", async () => {
    const { tracker, transport } = setup();
    expect(await tracker.load()).toEqual(snapshot(12000, 3));
    tracker.observe(12000, true);
    await tracker.flush();
    expect(transport.saveProgress).not.toHaveBeenCalled();
  });
  it("retains identical request on a lost response before draining a newer seek", async () => {
    const { tracker, transport } = setup();
    await tracker.load();
    transport.saveProgress.mockRejectedValueOnce(new ApiError(0, "lost"));
    tracker.observe(15000);
    await tracker.flush();
    expect(tracker.state).toBe("error");
    const original = { ...transport.saveProgress.mock.calls[0][1] };
    tracker.observe(8000, true);
    expect(transport.saveProgress).toHaveBeenCalledTimes(1);
    await tracker.retry();
    expect(transport.saveProgress.mock.calls[1][1]).toEqual(original);
    expect(transport.saveProgress.mock.calls[2][1]).toMatchObject({
      position_ms: 8000,
      revision: 4,
    });
    expect(transport.saveProgress.mock.calls[2][1].client_id).not.toBe(
      original.client_id,
    );
    expect(tracker.state).toBe("saved");
  });
  it("serializes writes when a pause or seek happens during upload", async () => {
    const { tracker, transport } = setup();
    await tracker.load();
    let resolve!: (value: PlaybackProgress) => void;
    transport.saveProgress.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    tracker.observe(16000, true);
    tracker.observe(4000, true);
    expect(transport.saveProgress).toHaveBeenCalledTimes(1);
    resolve(snapshot(16000, 4));
    await vi.waitFor(() =>
      expect(transport.saveProgress).toHaveBeenCalledTimes(2),
    );
    expect(transport.saveProgress.mock.calls[1][1]).toMatchObject({
      position_ms: 4000,
      revision: 4,
    });
  });
  it("stops stale writes on conflict until an explicit fresh read", async () => {
    const { tracker, transport } = setup();
    await tracker.load();
    transport.saveProgress.mockRejectedValueOnce(new ApiError(409, "conflict"));
    tracker.observe(4000, true);
    await tracker.flush();
    expect(tracker.state).toBe("conflict");
    tracker.observe(18000, true);
    await tracker.retry();
    expect(transport.saveProgress).toHaveBeenCalledTimes(1);
    transport.progress.mockResolvedValueOnce(snapshot(27000, 9));
    expect(await tracker.load()).toEqual(snapshot(27000, 9));
    tracker.observe(7000, true);
    await vi.waitFor(() =>
      expect(transport.saveProgress).toHaveBeenCalledTimes(2),
    );
    expect(transport.saveProgress.mock.calls[1][1]).toMatchObject({
      position_ms: 7000,
      revision: 9,
    });
  });
  it("does not write without a server revision and allows read retry", async () => {
    const { tracker, transport } = setup();
    transport.progress.mockRejectedValueOnce(new ApiError(503, "offline"));
    await tracker.load();
    tracker.observe(9000, true);
    expect(transport.saveProgress).not.toHaveBeenCalled();
    expect(tracker.ready).toBe(false);
    expect(tracker.hasPendingWrite).toBe(false);
    await tracker.retry();
    expect(tracker.ready).toBe(true);
  });
  it("ignores late load and callbacks after switching audio or account", async () => {
    const { tracker, transport, changed } = setup();
    let resolve!: (value: PlaybackProgress) => void;
    transport.progress.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const load = tracker.load();
    tracker.dispose();
    changed.mockClear();
    resolve(snapshot(3000, 2));
    expect(await load).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    tracker.observe(9000, true);
    expect(transport.saveProgress).not.toHaveBeenCalled();
  });
  it("does not drain ordinary timeupdates into continuous requests on slow connections", async () => {
    const { tracker, transport } = setup();
    await tracker.load();
    let resolve!: (value: PlaybackProgress) => void;
    transport.saveProgress.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    tracker.observe(16000);
    tracker.observe(17000);
    resolve(snapshot(16000, 4));
    await tracker.flush();
    expect(transport.saveProgress).toHaveBeenCalledTimes(1);
    tracker.observe(17500, true);
    await tracker.flush();
    expect(transport.saveProgress).toHaveBeenCalledTimes(2);
  });
  it("blocks old writes during an explicit server-position refresh", async () => {
    const { tracker, transport } = setup();
    await tracker.load();
    let resolve!: (value: PlaybackProgress) => void;
    transport.progress.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const refresh = tracker.load();
    expect(tracker.ready).toBe(false);
    tracker.observe(6000, true);
    await tracker.flush();
    expect(transport.saveProgress).not.toHaveBeenCalled();
    resolve(snapshot(27000, 9));
    await refresh;
    expect(tracker.ready).toBe(true);
  });
  it("retires confirmed-deleted audio without draining late writes or offering recovery", async () => {
    const { tracker, transport, changed } = setup();
    await tracker.load();
    let resolve!: (value: PlaybackProgress) => void;
    transport.saveProgress.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    tracker.observe(16000, true);
    tracker.observe(18000, true);
    expect(tracker.hasPendingWrite).toBe(true);
    tracker.retire();
    changed.mockClear();
    resolve(snapshot(16000, 4));
    await tracker.flush();
    expect(tracker.hasPendingWrite).toBe(false);
    expect(tracker.ready).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(transport.saveProgress).toHaveBeenCalledTimes(1);
  });
});
