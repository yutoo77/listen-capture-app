export type MicrophoneInput = { deviceId: string; label: string };

export function microphoneConstraints(deviceId = ""): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

export async function listMicrophones(): Promise<MicrophoneInput[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(
      (device) => device.kind === "audioinput" && device.deviceId !== "default",
    )
    .map(({ deviceId, label }) => ({ deviceId, label }));
}

export async function requestMicrophonePermission(
  deviceId = "",
): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia(
    microphoneConstraints(deviceId),
  );
  // Also releases a late permission grant whose caller has already cancelled.
  stream.getTracks().forEach((track) => track.stop());
}

export function microphoneFailure(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (["NotAllowedError", "SecurityError"].includes(name))
    return "マイクを使えません。ブラウザのサイト設定でマイクを許可し、localhost または HTTPS で開いてください。";
  if (["NotFoundError", "OverconstrainedError"].includes(name))
    return "選んだマイクが使えません。接続を確認して入力マイクを選び直してください。別のマイクには切り替えていません。";
  if (name === "NotReadableError")
    return "マイクを開けません。他の通話・録音を終了し、マイクの接続を確認してください。";
  return "録音を開始できませんでした。マイクとイヤホンの接続を確認し、もう一度お試しください。";
}

// A visual activity hint, not a calibrated loudness/silence measurement. This
// graph never connects to the speakers and never changes the recorded stream.
export function monitorMicrophone(
  stream: MediaStream,
  level: (value: number | null) => void,
): () => void {
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      source?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    try {
      analyser?.disconnect();
    } catch {
      /* Already disconnected. */
    }
    try {
      if (context) void context.close().catch(() => {});
    } catch {
      /* Already closed. */
    }
    level(null);
  };
  try {
    const Context = window.AudioContext;
    if (!Context) {
      level(null);
      return stop;
    }
    context = new Context();
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      if (context?.state !== "running") {
        level(null);
        return;
      }
      try {
        analyser!.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) /
            samples.length,
        );
        level(Number.isFinite(rms) ? Math.min(1, rms * 5) : null);
      } catch {
        stop();
      }
    }, 100);
    if (context.state === "suspended") void context.resume().catch(stop);
  } catch {
    stop(); // An optional meter must never prevent recording or release.
  }
  return stop;
}
