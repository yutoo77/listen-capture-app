import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureController } from "./capture";
import type { PendingMemo } from "./types";

class FakeTrack extends EventTarget {
  label = "USB Razer microphone";
  readyState = "live";
  stop = vi.fn();
}
class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(type: string) {
    return type === "audio/webm";
  }
  state = "inactive";
  mimeType = "audio/webm";
  constructor() {
    super();
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const event = new Event("dataavailable");
    Object.assign(event, {
      data: new Blob(["audio-bytes"], { type: this.mimeType }),
    });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event("stop"));
  }
}
function data(recorder: FakeRecorder, bytes: string) {
  const event = new Event("dataavailable");
  Object.assign(event, {
    data: new Blob([bytes], { type: recorder.mimeType }),
  });
  recorder.dispatchEvent(event);
}
function delayStop(recorder: FakeRecorder) {
  vi.spyOn(recorder, "stop").mockImplementation(() => {
    recorder.state = "inactive";
  });
}
const anchor = {
  userId: "alice",
  documentId: "doc",
  documentTitle: "資料",
  audioVersion: "audio-version",
};
let track: FakeTrack;
let getUserMedia: ReturnType<typeof vi.fn>;
let audio: HTMLAudioElement;
let complete: ReturnType<typeof vi.fn<(memo: PendingMemo) => Promise<boolean>>>;
let status: ReturnType<typeof vi.fn<(message: string) => void>>;
let controller: CaptureController;
beforeEach(() => {
  vi.useFakeTimers();
  track = new FakeTrack();
  FakeRecorder.instances = [];
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("window", {
    isSecureContext: true,
    MediaRecorder: FakeRecorder,
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("document", { hidden: false });
  audio = {
    currentTime: 12.5,
    readyState: 1,
    paused: false,
    ended: false,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLAudioElement;
  complete = vi.fn().mockResolvedValue(true);
  status = vi.fn();
  controller = new CaptureController(audio, {
    complete,
    status,
    state: vi.fn(),
    elapsed: vi.fn(),
    pauseMemos: vi.fn(),
  });
});
afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("capture controller", () => {
  it("requests the selected input exactly and reports the granted track name, not a guessed name", async () => {
    const input = vi.fn();
    controller.dispose();
    controller = new CaptureController(audio, {
      complete,
      status,
      state: vi.fn(),
      elapsed: vi.fn(),
      pauseMemos: vi.fn(),
      input,
    });
    await controller.begin(anchor, "selected-device");
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "selected-device" },
      },
    });
    expect(input).toHaveBeenCalledExactlyOnceWith("USB Razer microphone");
    controller.stop();
    await vi.runAllTimersAsync();
    expect(track.stop).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).not.toHaveProperty("deviceId");
    expect(complete.mock.calls[0][0]).not.toHaveProperty("label");
  });
  it.each(["NotFoundError", "OverconstrainedError"])(
    "never falls back when the selected input fails with %s",
    async (name) => {
      getUserMedia.mockRejectedValueOnce(new DOMException("", name));
      await controller.begin(anchor, "unplugged-device");
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(controller.state).toBe("idle");
      expect(status).toHaveBeenLastCalledWith(
        expect.stringContaining("別のマイクには切り替えていません"),
      );
      expect(FakeRecorder.instances).toHaveLength(0);
      expect(complete).not.toHaveBeenCalled();
    },
  );
  it("retains browser default selection only when the user has not chosen an exact input", async () => {
    await controller.begin(anchor);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  });
  it("releases an unusable already-ended granted input without starting or saving", async () => {
    track.readyState = "ended";
    await controller.begin(anchor, "selected-device");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
  });
  it("keeps capture/save working when the optional meter cannot be initialized", async () => {
    window.AudioContext = class {
      constructor() {
        throw new Error("unavailable");
      }
    } as unknown as typeof AudioContext;
    const level = vi.fn();
    controller.dispose();
    controller = new CaptureController(audio, {
      complete,
      status,
      state: vi.fn(),
      elapsed: vi.fn(),
      pauseMemos: vi.fn(),
      level,
    });
    await controller.begin(anchor, "chosen-input");
    expect(controller.state).toBe("recording");
    expect(level).toHaveBeenCalledWith(null);
    controller.stop();
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalled();
    expect(complete.mock.calls[0][0].positionMs).toBe(12500);
  });
  it("closes the activity monitor and preserves a partial recording on microphone disconnect", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn();
    window.AudioContext = class {
      state = "running";
      close = close;
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect });
      createAnalyser = () => ({
        fftSize: 0,
        getFloatTimeDomainData: vi.fn(),
        disconnect,
      });
    } as unknown as typeof AudioContext;
    const level = vi.fn();
    controller.dispose();
    controller = new CaptureController(audio, {
      complete,
      status,
      state: vi.fn(),
      elapsed: vi.fn(),
      pauseMemos: vi.fn(),
      level,
    });
    await controller.begin(anchor, "chosen-input");
    track.dispatchEvent(new Event("ended"));
    await vi.runAllTimersAsync();
    expect(close).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(level).toHaveBeenLastCalledWith(null);
    expect(complete).toHaveBeenCalledOnce();
    expect(await complete.mock.calls[0][0].blob.text()).toBe("audio-bytes");
    expect(audio.play).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
  });
  it("freezes source position before the asynchronous microphone permission request", async () => {
    let grant!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const started = controller.begin(anchor);
    expect(controller.state).toBe("starting");
    expect(audio.pause).toHaveBeenCalled();
    audio.currentTime = 90;
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await started;
    controller.stop();
    await vi.runAllTimersAsync();
    expect(complete.mock.calls[0][0].positionMs).toBe(12500);
    expect(complete.mock.calls[0][0].audioVersion).toBe("audio-version");
  });
  it("stops the mic and saves exactly once when stop is pressed twice", async () => {
    await controller.begin(anchor);
    controller.stop();
    controller.stop();
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(controller.state).toBe("idle");
  });
  it.each(["", "early-"])(
    "preserves %j and final data arriving after the ending watchdog without uploading early",
    async (early) => {
      const clientId = "85f02277-0cdd-4fb2-a589-03d76753a864";
      const randomUUID = vi.fn().mockReturnValue(clientId);
      vi.stubGlobal("crypto", { randomUUID });
      const frozenAnchor = { ...anchor };
      await controller.begin(frozenAnchor);
      const recorder = FakeRecorder.instances[0];
      delayStop(recorder);
      if (early) data(recorder, early);
      await vi.advanceTimersByTimeAsync(1250);
      controller.stop();
      frozenAnchor.userId = "bob";
      frozenAnchor.audioVersion = "other-version";
      audio.currentTime = 90;
      await vi.advanceTimersByTimeAsync(4500);
      expect(complete).not.toHaveBeenCalled();
      expect(controller.state).toBe("finishing");
      expect(track.stop).toHaveBeenCalledOnce();
      expect(status.mock.lastCall?.[0]).toContain("終了処理が遅れています");
      expect(await controller.play()).toBe(false);
      await controller.begin(anchor);
      expect(FakeRecorder.instances).toHaveLength(1);
      data(recorder, "final");
      recorder.dispatchEvent(new Event("stop"));
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toHaveBeenCalledOnce();
      const saved = complete.mock.calls[0][0];
      expect(saved).toMatchObject({
        ...anchor,
        clientId,
        positionMs: 12500,
        durationMs: 1250,
      });
      expect(await saved.blob.text()).toBe(`${early}final`);
      expect(randomUUID).toHaveBeenCalledOnce();
      expect(audio.play).not.toHaveBeenCalled();
      expect(controller.state).toBe("idle");
      data(recorder, "too-late");
      recorder.dispatchEvent(new Event("stop"));
      expect(complete).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("waits for a missing stop event until the user explicitly discards the recording", async () => {
    await controller.begin(anchor);
    const recorder = FakeRecorder.instances[0];
    delayStop(recorder);
    data(recorder, "unfinished");
    controller.stop();
    await vi.advanceTimersByTimeAsync(30000);
    expect(controller.state).toBe("finishing");
    expect(complete).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(controller.discard()).toBe(true);
    expect(controller.state).toBe("idle");
    expect(status.mock.lastCall?.[0]).toContain("サーバーには保存していません");
    expect(status.mock.lastCall?.[0]).toContain("手動で再開");
    expect(controller.discard()).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not auto-resume when finishing is interrupted before the encoder returns", async () => {
    await controller.begin(anchor);
    const recorder = FakeRecorder.instances[0];
    delayStop(recorder);
    controller.stop();
    controller.interrupt();
    data(recorder, "final");
    recorder.dispatchEvent(new Event("stop"));
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
  });
  it("ignores discarded session events after a new microphone session starts", async () => {
    const audioSession = { type: "playback" };
    Object.assign(navigator, { audioSession });
    await controller.begin(anchor);
    const oldRecorder = FakeRecorder.instances[0];
    delayStop(oldRecorder);
    data(oldRecorder, "discarded-voice");
    controller.stop();
    expect(controller.discard()).toBe(true);
    expect(track.stop).toHaveBeenCalledOnce();
    const nextTrack = new FakeTrack();
    getUserMedia.mockResolvedValueOnce({
      getTracks: () => [nextTrack],
      getAudioTracks: () => [nextTrack],
    });
    await controller.begin({ ...anchor, audioVersion: "new-version" });
    status.mockClear();
    data(oldRecorder, "discarded-late-voice");
    oldRecorder.dispatchEvent(new Event("stop"));
    oldRecorder.dispatchEvent(new Event("error"));
    track.dispatchEvent(new Event("ended"));
    expect(controller.state).toBe("recording");
    expect(nextTrack.stop).not.toHaveBeenCalled();
    expect(audioSession.type).toBe("play-and-record");
    expect(status).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    controller.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].audioVersion).toBe("new-version");
    expect(await complete.mock.calls[0][0].blob.text()).toBe("audio-bytes");
    expect(nextTrack.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("permits discard only while finishing, never during microphone preparation, recording or saving", async () => {
    expect(controller.discard()).toBe(false);
    let grant!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(
      () => new Promise((resolve) => (grant = resolve)),
    );
    const started = controller.begin(anchor);
    expect(controller.state).toBe("starting");
    expect(controller.discard()).toBe(false);
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await started;
    expect(controller.discard()).toBe(false);
    let acknowledge!: (saved: boolean) => void;
    complete.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (acknowledge = resolve)),
    );
    controller.stop();
    expect(controller.state).toBe("saving");
    expect(controller.discard()).toBe(false);
    acknowledge(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state).toBe("idle");
    expect(complete).toHaveBeenCalledOnce();
  });
  it("releases the microphone on disposal while still accepting the final delayed recording", async () => {
    await controller.begin(anchor);
    const recorder = FakeRecorder.instances[0];
    delayStop(recorder);
    data(recorder, "early-");
    controller.stop();
    controller.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(controller.discard()).toBe(false);
    data(recorder, "final");
    recorder.dispatchEvent(new Event("stop"));
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledOnce();
    expect(await complete.mock.calls[0][0].blob.text()).toBe("early-final");
    expect(audio.play).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not resume a source that was already paused", async () => {
    Object.defineProperty(audio, "paused", { value: true });
    await controller.begin(anchor);
    controller.stop();
    await vi.runAllTimersAsync();
    expect(audio.play).not.toHaveBeenCalled();
  });
  it("does not auto-resume after a save failure or interruption", async () => {
    complete.mockResolvedValue(false);
    await controller.begin(anchor);
    controller.stop();
    await vi.runAllTimersAsync();
    expect(audio.play).not.toHaveBeenCalled();
    complete.mockResolvedValue(true);
    await controller.begin(anchor);
    controller.interrupt();
    await vi.runAllTimersAsync();
    expect(audio.play).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("releases a late permission result after cancellation without starting a recorder", async () => {
    let grant!: (stream: unknown) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const started = controller.begin(anchor);
    controller.cancel();
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await started;
    expect(track.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
  });
  it("handles denied permission and allows another attempt", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    await controller.begin(anchor);
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining("マイクを許可"),
    );
    expect(controller.state).toBe("idle");
    await controller.begin(anchor);
    expect(controller.state).toBe("recording");
    controller.stop();
    await vi.runAllTimersAsync();
  });
  it("ignores a cancelled permission rejection after another recording starts", async () => {
    let rejectPermission!: (error: unknown) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPermission = reject;
        }),
    );
    const audioSession = { type: "playback" };
    Object.assign(navigator, { audioSession });
    const old = controller.begin(anchor);
    controller.cancel();
    await controller.begin(anchor);
    expect(audioSession.type).toBe("play-and-record");
    rejectPermission(new DOMException("late denial", "NotAllowedError"));
    await old;
    expect(controller.state).toBe("recording");
    expect(audioSession.type).toBe("play-and-record");
    expect(status.mock.lastCall?.[0]).toContain("録音中です");
    controller.stop();
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("rejects playback actions while recording", async () => {
    await controller.begin(anchor);
    expect(await controller.play()).toBe(false);
    expect(audio.play).not.toHaveBeenCalled();
    controller.stop();
    await vi.runAllTimersAsync();
  });
  it("does not pause a newer playback when an older play succeeds late", async () => {
    let finishOldPlay!: () => void;
    vi.mocked(audio.play).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishOldPlay = resolve)),
    );
    const oldPlay = controller.play();
    controller.invalidatePlayback();
    expect(await controller.play()).toBe(true);
    vi.mocked(audio.pause).mockClear();
    finishOldPlay();
    expect(await oldPlay).toBe(false);
    expect(audio.pause).not.toHaveBeenCalled();
  });
  it("keeps playback stopped when an invalidated play succeeds late", async () => {
    let finishOldPlay!: () => void;
    vi.mocked(audio.play).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishOldPlay = resolve)),
    );
    const oldPlay = controller.play();
    controller.invalidatePlayback();
    vi.mocked(audio.pause).mockClear();
    finishOldPlay();
    expect(await oldPlay).toBe(false);
    expect(audio.pause).toHaveBeenCalledOnce();
  });
  it("keeps recording and saving exclusive against a late playback success", async () => {
    for (const saving of [false, true]) {
      let finishOldPlay!: () => void;
      let finishSave!: (saved: boolean) => void;
      vi.mocked(audio.play).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishOldPlay = resolve)),
      );
      const oldPlay = controller.play();
      await controller.begin(anchor);
      if (saving) {
        complete.mockImplementationOnce(
          () => new Promise<boolean>((resolve) => (finishSave = resolve)),
        );
        controller.stop();
        expect(controller.state).toBe("saving");
      }
      vi.mocked(audio.pause).mockClear();
      finishOldPlay();
      expect(await oldPlay).toBe(false);
      expect(audio.pause).toHaveBeenCalledOnce();
      expect(controller.state).toBe(saving ? "saving" : "recording");
      if (saving) finishSave(false);
      else controller.stop(true);
      await vi.runAllTimersAsync();
    }
  });
  it("ignores an old playback rejection after a newer playback succeeds", async () => {
    let rejectOldPlay!: (error: Error) => void;
    vi.mocked(audio.play).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectOldPlay = reject)),
    );
    const oldPlay = controller.play();
    controller.invalidatePlayback();
    expect(await controller.play()).toBe(true);
    vi.mocked(audio.pause).mockClear();
    status.mockClear();
    rejectOldPlay(new DOMException("old request blocked", "NotAllowedError"));
    expect(await oldPlay).toBe(false);
    expect(audio.pause).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
  it("ignores obsolete play rejections during a stop, recording and saving", async () => {
    for (const phase of ["stopped", "recording", "saving"]) {
      let rejectOldPlay!: (error: Error) => void;
      let finishSave!: (saved: boolean) => void;
      vi.mocked(audio.play).mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (rejectOldPlay = reject)),
      );
      const oldPlay = controller.play();
      if (phase === "stopped") controller.invalidatePlayback();
      else {
        await controller.begin(anchor);
        if (phase === "saving") {
          complete.mockImplementationOnce(
            () => new Promise<boolean>((resolve) => (finishSave = resolve)),
          );
          controller.stop();
        }
      }
      const state = controller.state;
      vi.mocked(audio.pause).mockClear();
      status.mockClear();
      rejectOldPlay(new DOMException("old request blocked", "NotAllowedError"));
      expect(await oldPlay).toBe(false);
      expect(controller.state).toBe(state);
      expect(audio.pause).not.toHaveBeenCalled();
      expect(status).not.toHaveBeenCalled();
      if (phase === "saving") finishSave(false);
      else if (phase === "recording") controller.stop(true);
      await vi.runAllTimersAsync();
    }
  });
  it("keeps playback stopped when a newer play rejects before an older success", async () => {
    let finishOldPlay!: () => void;
    vi.mocked(audio.play)
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishOldPlay = resolve)),
      )
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    const oldPlay = controller.play();
    expect(await controller.play()).toBe(false);
    vi.mocked(audio.pause).mockClear();
    finishOldPlay();
    expect(await oldPlay).toBe(false);
    expect(audio.pause).toHaveBeenCalledOnce();
  });
  it("falls back to manual play after autoplay denial while retaining the saved memo", async () => {
    vi.mocked(audio.play).mockRejectedValueOnce(
      new DOMException("autoplay blocked", "NotAllowedError"),
    );
    await controller.begin(anchor);
    controller.stop();
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining("再生ボタンをタップ"),
    );
    expect(controller.state).toBe("idle");
  });
  it("stops and preserves a partial memo when the microphone track ends", async () => {
    await controller.begin(anchor);
    track.dispatchEvent(new Event("ended"));
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledOnce();
    expect(audio.play).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
  it("caps recording at 60 seconds and avoids automatic playback after that interruption", async () => {
    await controller.begin(anchor);
    await vi.advanceTimersByTimeAsync(60001);
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].durationMs).toBeLessThanOrEqual(60000);
    expect(audio.play).not.toHaveBeenCalled();
  });
  it("ignores stale microphone events from a previous completed recording", async () => {
    await controller.begin(anchor);
    controller.stop();
    await vi.runAllTimersAsync();
    const nextTrack = new FakeTrack();
    getUserMedia.mockResolvedValueOnce({
      getTracks: () => [nextTrack],
      getAudioTracks: () => [nextTrack],
    });
    await controller.begin(anchor);
    expect(controller.state).toBe("recording");
    track.dispatchEvent(new Event("mute"));
    expect(controller.state).toBe("recording");
    expect(complete).toHaveBeenCalledTimes(1);
    controller.stop();
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
