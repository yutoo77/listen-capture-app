import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listMicrophones,
  microphoneFailure,
  monitorMicrophone,
  requestMicrophonePermission,
} from "./microphone";

let amplitude = 0;
let state = "running";
const connect = vi.fn();
const disconnectSource = vi.fn();
const disconnectAnalyser = vi.fn();
const close = vi.fn().mockResolvedValue(undefined);
const resume = vi.fn().mockResolvedValue(undefined);
class FakeContext {
  get state() {
    return state;
  }
  createMediaStreamSource = vi.fn(() => ({
    connect,
    disconnect: disconnectSource,
  }));
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(amplitude),
    disconnect: disconnectAnalyser,
  }));
  close = close;
  resume = resume;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state = "running";
  amplitude = 0;
  vi.stubGlobal("window", { AudioContext: FakeContext });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("microphone selection and permission", () => {
  it("enumerates only inputs without opening a microphone or changing its default", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "default", label: "Default" },
          {
            kind: "audioinput",
            deviceId: "airpods",
            label: "AirPods microphone",
          },
          { kind: "audioinput", deviceId: "usb", label: "USB microphone" },
          { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
        ]),
      },
    });
    expect(await listMicrophones()).toEqual([
      { deviceId: "airpods", label: "AirPods microphone" },
      { deviceId: "usb", label: "USB microphone" },
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("releases every track even when a permission grant arrives after the caller leaves", async () => {
    let grant!: (stream: unknown) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const permission = requestMicrophonePermission("airpods");
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    grant({ getTracks: () => tracks });
    await permission;
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "airpods" },
      },
    });
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
  });
  it("distinguishes a removed selected input from permission rejection without raw errors", () => {
    expect(
      microphoneFailure(
        new DOMException("private detail", "OverconstrainedError"),
      ),
    ).toContain("別のマイクには切り替えていません");
    expect(
      microphoneFailure(new DOMException("private detail", "NotAllowedError")),
    ).toContain("サイト設定でマイクを許可");
    expect(microphoneFailure(new Error("private detail"))).not.toContain(
      "private detail",
    );
  });
});
describe("optional microphone activity meter", () => {
  it("shows the input signal, never connects speakers, and stops measuring on release", async () => {
    const level = vi.fn();
    const stream = { getTracks: vi.fn() } as unknown as MediaStream;
    const stop = monitorMicrophone(stream, level);
    amplitude = 0.1;
    await vi.advanceTimersByTimeAsync(100);
    expect(level).toHaveBeenLastCalledWith(expect.closeTo(0.5));
    amplitude = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(level).toHaveBeenLastCalledWith(0);
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0][0]).toHaveProperty("getFloatTimeDomainData");
    expect(stream.getTracks).not.toHaveBeenCalled();
    stop();
    stop();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectAnalyser).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(level).toHaveBeenLastCalledWith(null);
    const calls = level.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(level).toHaveBeenCalledTimes(calls);
  });
  it("shows unavailable rather than false silence when Web Audio is suspended or absent", async () => {
    const level = vi.fn();
    state = "suspended";
    const stop = monitorMicrophone({} as MediaStream, level);
    expect(resume).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(level).toHaveBeenLastCalledWith(null);
    stop();
    vi.stubGlobal("window", {});
    expect(() => monitorMicrophone({} as MediaStream, level)()).not.toThrow();
    expect(level).toHaveBeenLastCalledWith(null);
  });
});
