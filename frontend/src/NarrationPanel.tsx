import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import {
  narrationApi,
  NarrationCancellation,
  NarrationIntents,
  NarrationRequests,
  NarrationStorageError,
  narrationFailure,
  retryNarrationIntent,
} from "./narration";
import type {
  NarrationConfig,
  NarrationIntent,
  NarrationJob,
  NarrationProvider,
  VoicevoxVoice,
} from "./narration";
import type { Document } from "./types";

type Props = {
  document: Document;
  userId: string;
  disabled: boolean;
  legacy: ReactNode;
  allowNewVoice?: boolean;
  activeAudioId?: string;
  onReady: (
    document: Document,
    job: { document_version: string; audio_version: string | null },
  ) => void;
};

export default function NarrationPanel(props: Props) {
  return (
    <ScopedNarrationPanel
      key={`${props.userId}:${props.document.id}:${props.document.current_version.id}`}
      {...props}
    />
  );
}

function ScopedNarrationPanel({
  document,
  userId,
  disabled,
  legacy,
  onReady,
  allowNewVoice = false,
  activeAudioId,
}: Props) {
  const [config, setConfig] = useState<NarrationConfig | null>(null);
  const [provider, setProvider] = useState<NarrationProvider>("polly");
  const [voice, setVoice] = useState<VoicevoxVoice | null>(null);
  const [job, setJob] = useState<NarrationJob | null>(null);
  const [pending, setPending] = useState<NarrationIntent | null>(null);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const [configCycle, setConfigCycle] = useState(0);
  const [paused, setPaused] = useState(false);
  const active = job?.state === "queued" || job?.state === "running";
  const alive = useRef(true);
  const requests = useRef<NarrationRequests | null>(null);
  const cancellation = useRef<NarrationCancellation | null>(null);
  const application = useRef<AbortController | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const expectedVersion = document.current_version.id;

  useEffect(() => {
    alive.current = true;
    const cancel = new NarrationCancellation({
      userId,
      documentId: document.id,
      versionId: expectedVersion,
    });
    cancellation.current = cancel;
    let current: NarrationRequests | undefined;
    try {
      current = new NarrationRequests(
        { userId, documentId: document.id, versionId: expectedVersion },
        new NarrationIntents(userId, expectedVersion, window.sessionStorage),
      );
      setPending(current.restore());
      requests.current = current;
    } catch {
      setStorageError(true);
    }
    return () => {
      alive.current = false;
      application.current?.abort();
      current?.dispose();
      cancel.dispose();
      if (cancellation.current === cancel) cancellation.current = null;
      if (requests.current === current) requests.current = null;
    };
  }, [document.id, expectedVersion, userId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      narrationApi.config(controller.signal),
      narrationApi.current(document.id, controller.signal),
    ])
      .then(([settings, current]) => {
        if (!alive.current || controller.signal.aborted) return;
        if (current && current.document_version !== expectedVersion) {
          setError("本文が更新されています。資料を開き直してください。");
          return;
        }
        setConfig(settings);
        const previous =
          allowNewVoice && current?.state === "succeeded" ? null : current;
        setJob(previous);
        const voicevox = settings.providers.find(
          (item) => item.id === "voicevox",
        );
        setVoice(previous?.voice ?? voicevox?.defaults ?? null);
        setPaused(false);
        setProvider(
          previous?.provider ??
            settings.providers.find(
              (item) => item.enabled && item.id === "voicevox",
            )?.id ??
            settings.providers.find(
              (item) => item.enabled && item.id === "windows",
            )?.id ??
            settings.providers.find((item) => item.enabled)?.id ??
            "polly",
        );
      })
      .catch(() => {
        if (!controller.signal.aborted && alive.current)
          setError(
            "音声生成の設定・状況を確認できません。設定を再確認してください。",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted && alive.current) setInitialized(true);
      });
    return () => controller.abort();
  }, [document.id, expectedVersion, configCycle, allowNewVoice]);

  useEffect(() => {
    if (pending || !job || job.state !== "succeeded" || !job.audio_version)
      return;
    const controller = new AbortController();
    void api
      .document(document.id, controller.signal)
      .then((fresh) => {
        if (
          alive.current &&
          !controller.signal.aborted &&
          fresh.current_version.id === expectedVersion &&
          job.document_version === expectedVersion
        )
          ready.current(fresh, job);
      })
      .catch(() => {
        if (!controller.signal.aborted && alive.current)
          setError("音声は生成済みです。資料を開き直して確認してください。");
      });
    return () => controller.abort();
  }, [job, pending, document.id, expectedVersion]);

  useEffect(() => {
    if (!job || !active || paused || cancelBusy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (window.document.hidden) {
        setPollCycle((value) => value + 1);
        return;
      }
      void narrationApi
        .job(job.id, controller.signal)
        .then((next) => {
          if (!alive.current || controller.signal.aborted) return;
          if (
            next.document_version !== expectedVersion ||
            next.id !== job.id ||
            next.provider !== job.provider ||
            next.voice?.speaker_id !== job.voice?.speaker_id ||
            next.voice?.pitch_scale !== job.voice?.pitch_scale
          ) {
            setError(
              "生成状況が資料と一致しません。資料を開き直してください。",
            );
            setPaused(true);
            return;
          }
          setJob(next);
          setPollCycle((value) => value + 1);
        })
        .catch(() => {
          if (!controller.signal.aborted && alive.current) {
            setError(
              "生成状況を確認できません。生成自体は再送せず、状況を再確認してください。",
            );
            setPaused(true);
          }
        });
    }, 5000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, active, paused, cancelBusy, pollCycle, expectedVersion]);

  async function cancelGeneration() {
    const current = cancellation.current;
    if (
      !current ||
      current.busy ||
      !job ||
      !active ||
      job.cancel_requested_at ||
      pending ||
      disabled ||
      busy
    )
      return;
    setCancelBusy(true);
    setError("");
    try {
      const next = await current.submit(job);
      if (!alive.current || cancellation.current !== current || !next) return;
      setJob(next);
      setPaused(false);
    } catch {
      if (alive.current && cancellation.current === current) {
        setError(
          "中断の受付を確認できません。状況を確認するか、もう一度中断してください。",
        );
        setPaused(false);
      }
    } finally {
      if (alive.current && cancellation.current === current)
        setCancelBusy(false);
    }
  }

  async function send(value: NarrationIntent) {
    const current = requests.current;
    if (
      !current ||
      current.busy ||
      disabled ||
      storageError ||
      !config ||
      !initialized
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = current.submit(value);
      setPending(current.pending);
      const result = await response;
      if (!alive.current || requests.current !== current || !result) return;
      setJob(result.job);
      setPending(result.pending);
      setPaused(false);
      setAcknowledge(false);
      if (result.cleanupFailed)
        setError(
          "受付済みです。端末の受付記録を削除できません。同じ依頼で確認できます。",
        );
    } catch (error) {
      if (!alive.current || requests.current !== current) return;
      if (error instanceof NarrationStorageError) {
        setStorageError(true);
        setError(error.message);
      } else
        setError(
          `${error instanceof Error ? error.message : "受付結果を確認できません。"} 同じ依頼を確認してください。`,
        );
    } finally {
      if (alive.current && requests.current === current) setBusy(false);
    }
  }

  async function applyReady() {
    const completed = job;
    if (
      disabled ||
      busy ||
      application.current ||
      !allowNewVoice ||
      completed?.state !== "succeeded" ||
      !completed.audio_version
    )
      return;
    const controller = new AbortController();
    application.current = controller;
    setBusy(true);
    setError("");
    try {
      const fresh = await api.document(document.id, controller.signal);
      if (
        alive.current &&
        !controller.signal.aborted &&
        fresh.current_version.id === expectedVersion &&
        completed.document_version === expectedVersion
      )
        ready.current(fresh, completed);
    } catch {
      if (alive.current && !controller.signal.aborted)
        setError(
          "生成済み音声を確認できません。接続を確認してもう一度お試しください。",
        );
    } finally {
      if (application.current === controller) {
        application.current = null;
        if (alive.current) setBusy(false);
      }
    }
  }

  const options = config?.providers.filter((item) => item.enabled) ?? [];
  const useLegacy =
    initialized &&
    config &&
    !storageError &&
    !error &&
    !job &&
    !pending &&
    !allowNewVoice &&
    (Boolean(document.audio_generation) ||
      (options.length === 0 &&
        Array.from(document.current_version.text).length <= 3000));
  if (useLegacy) return <>{legacy}</>;
  const selectedProvider = pending?.provider ?? job?.provider ?? provider;
  const voicevoxConfig = config?.providers.find(
    (item) => item.id === "voicevox",
  );
  const selectedVoice = pending?.voice ?? job?.voice ?? voice;
  const speaker = voicevoxConfig?.voices?.find(
    (item) => item.id === selectedVoice?.speaker_id,
  );
  const providerEnabled = options.some(
    (item) => item.id === (job?.provider ?? provider),
  );
  const publicationOnly = job?.state === "failed" && job.retry_characters === 0;
  return (
    <div className="narration-panel">
      {!initialized && (
        <p role="status">音声生成の設定と受付記録を確認しています…</p>
      )}
      {error && (
        <p role="alert" className="notice warning">
          {error}
        </p>
      )}
      {storageError && (
        <p role="alert">
          このブラウザで受付記録を安全に使えません。記録を削除せず、保存領域の設定を確認してから開き直してください。
        </p>
      )}
      {initialized && !config && (
        <button
          className="soft"
          disabled={disabled || busy}
          onClick={() => {
            setInitialized(false);
            setError("");
            setConfigCycle((value) => value + 1);
          }}
        >
          設定と状況を再確認
        </button>
      )}
      {config && (
        <>
          {!allowNewVoice && !job && !pending && <p>音声を作成</p>}
          {options.length > 1 && !job && !pending && (
            <>
              <label htmlFor="narration-provider">読み上げ音声</label>
              <select
                id="narration-provider"
                value={provider}
                disabled={disabled || busy || storageError}
                onChange={(event) =>
                  setProvider(event.target.value as NarrationProvider)
                }
              >
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                    {item.billable ? "（従量課金）" : ""}
                  </option>
                ))}
              </select>
            </>
          )}
          {selectedProvider === "voicevox" && (
            <div className="voice-settings">
              {!job && !pending && voice && (
                <>
                  <label htmlFor="narration-speaker">声</label>
                  <select
                    id="narration-speaker"
                    value={voice.speaker_id}
                    disabled={disabled || busy || storageError}
                    onChange={(event) =>
                      setVoice({
                        ...voice,
                        speaker_id: Number(event.target.value),
                      })
                    }
                  >
                    {voicevoxConfig?.voices?.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.style}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="narration-pitch">
                    高さ{" "}
                    <output>
                      {voice.pitch_scale > 0 ? "+" : ""}
                      {voice.pitch_scale.toFixed(2)}
                    </output>
                  </label>
                  <input
                    id="narration-pitch"
                    type="range"
                    min={voicevoxConfig?.pitch_min ?? -0.15}
                    max={voicevoxConfig?.pitch_max ?? 0.15}
                    step={voicevoxConfig?.pitch_step ?? 0.01}
                    value={voice.pitch_scale}
                    disabled={disabled || busy || storageError}
                    onChange={(event) =>
                      setVoice({
                        ...voice,
                        pitch_scale: Number(event.target.value),
                      })
                    }
                  />
                </>
              )}
              <p className="voice-credit">
                {speaker?.credit ??
                  (selectedVoice
                    ? `VOICEVOX · 話者 ${selectedVoice.speaker_id}`
                    : "VOICEVOX")}
              </p>
              {!job && !pending && (
                <a
                  className="voice-terms"
                  href="https://voicevox.hiroshiba.jp/term/"
                  target="_blank"
                  rel="noreferrer"
                >
                  音声の利用条件
                </a>
              )}
            </div>
          )}
          <p className="muted">
            {config.max_characters.toLocaleString()}文字 · 最大
            {Math.round(config.max_duration_ms / 60000)}分
          </p>
          {selectedProvider === "fixture" && (
            <p className="notice">
              {(config.fixture_segment_duration_ms ?? 3000) > 3000
                ? "テスト用の人工音声です。日本語本文を読み上げた結果ではありません。"
                : "テスト用の無音音声です。日本語本文を読み上げた結果ではありません。"}
            </p>
          )}
          {selectedProvider === "windows" && (
            <p className="notice">このPCのWindows音声（開発用）</p>
          )}
          {(job || pending) &&
            !options.some((item) => item.id === selectedProvider) && (
              <p className="notice">
                選択した読み上げサービスは現在無効です。
                {pending
                  ? "保存した依頼の受付結果は、同じ依頼で確認できます。"
                  : publicationOnly
                    ? "保存済みの音声は、このまま仕上げられます。"
                    : "管理者に設定を確認してください。"}
              </p>
            )}
          {active && (
            <>
              <p role="status" data-testid="narration-progress">
                {job.cancel_requested_at
                  ? "中断しています…"
                  : "音声を準備しています…"}{" "}
                {job.completed_segments} / {job.total_segments}区間
              </p>
              {job.cancel_requested_at ? (
                <p className="muted">
                  実行中の区間が終わるまでお待ちください。
                </p>
              ) : (
                <button
                  className="soft"
                  disabled={disabled || busy || cancelBusy || Boolean(pending)}
                  onClick={() => void cancelGeneration()}
                >
                  {cancelBusy ? "中断を依頼しています…" : "生成を中断"}
                </button>
              )}
            </>
          )}
          {pending ? (
            <button
              className="primary"
              disabled={disabled || busy || storageError}
              onClick={() => void send(pending)}
            >
              {busy ? "確認しています…" : "同じ依頼を確認"}
            </button>
          ) : active ? null : job?.state === "failed" ? (
            <>
              <p
                className={
                  job.error_code === "user_cancelled"
                    ? "notice"
                    : "notice warning"
                }
                role={job.error_code === "user_cancelled" ? "status" : "alert"}
              >
                {narrationFailure(job)}
              </p>
              <p>
                {publicationOnly ? (
                  "すべての区間は生成済みです。読み上げサービスを使わず、保存済みの区間から音声ファイルを仕上げます。"
                ) : (
                  <>
                    保存済みの{job.completed_segments}区間を再利用し、残り
                    {job.retry_characters.toLocaleString()}文字を再生成します。
                  </>
                )}
              </p>
              {job.has_unknown && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={acknowledge}
                    onChange={(event) => setAcknowledge(event.target.checked)}
                    disabled={disabled || busy || storageError}
                  />
                  {job.provider === "polly"
                    ? "未確認区間の再生成に追加料金がかかる可能性を確認しました"
                    : "未確認区間を作り直すことを確認しました"}
                </label>
              )}
              <button
                className="primary"
                disabled={
                  disabled ||
                  busy ||
                  storageError ||
                  (!publicationOnly && !providerEnabled) ||
                  (job.has_unknown && !acknowledge)
                }
                onClick={() =>
                  void send(retryNarrationIntent(job, acknowledge))
                }
              >
                {publicationOnly
                  ? "保存済み音声を仕上げる"
                  : job.error_code === "user_cancelled"
                    ? "保存済み区間から再開"
                    : "保存済み区間を使って再試行"}
              </button>
            </>
          ) : job?.state === "succeeded" ? (
            <>
              <p role="status">音声を作成しました。</p>
              {allowNewVoice &&
                activeAudioId &&
                job.audio_version !== activeAudioId && (
                  <button
                    className="primary"
                    disabled={disabled || busy}
                    onClick={() => void applyReady()}
                  >
                    この音声を使う
                  </button>
                )}
              {allowNewVoice && (
                <button
                  className="text-button"
                  disabled={disabled || busy}
                  onClick={() => setJob(null)}
                >
                  別の声で作る
                </button>
              )}
            </>
          ) : (
            <button
              className="primary"
              data-testid="narration-generate"
              disabled={
                disabled ||
                busy ||
                storageError ||
                !providerEnabled ||
                (provider === "voicevox" && !voice) ||
                Array.from(document.current_version.text).length >
                  config.max_characters
              }
              onClick={() =>
                void send({
                  key: crypto.randomUUID(),
                  operation: "start",
                  provider,
                  acknowledge: false,
                  ...(provider === "voicevox" && voice ? { voice } : {}),
                })
              }
            >
              {busy ? "確認しています…" : "音声を生成"}
            </button>
          )}
          {paused && (
            <button
              className="text-button"
              disabled={disabled || busy}
              onClick={() => {
                setPaused(false);
                setError("");
                setPollCycle((value) => value + 1);
              }}
            >
              生成状況を確認
            </button>
          )}
          {options.length === 0 && (
            <p className="muted">
              読み上げサービスは未設定です。本文は保存済みです。
            </p>
          )}
        </>
      )}
    </div>
  );
}
