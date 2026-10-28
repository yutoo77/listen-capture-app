import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  characterCount,
  generationFailure,
  GenerationPoller,
  isGenerationActive,
  restoreGenerationJob,
} from "./generation";
import type { Document, GenerationJob, TtsSettings } from "./types";
import type { GenerationIntents } from "./generation";

export default function GenerationPanel({
  document,
  settings,
  available,
  disabled,
  intents,
  onReady,
}: {
  document: Document;
  settings?: TtsSettings;
  available: boolean;
  disabled: boolean;
  intents: GenerationIntents;
  onReady: (document: Document, job: GenerationJob) => void;
}) {
  const initialJob = restoreGenerationJob(
    document.audio_generation ?? null,
    intents.get(document.current_version.id),
  );
  const uncertainNotice =
    "前回送信した依頼の結果は未確認です。同じ依頼IDで送信を再試行し、保存済みの受付結果を確認してください。";
  const [job, setJob] = useState(initialJob);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState(
    !initialJob && document.audio_generation?.state === "failed"
      ? uncertainNotice
      : "",
  );
  const [pollPaused, setPollPaused] = useState(false);
  const [pollCycle, setPollCycle] = useState(0);
  const mounted = useRef(true);
  const post = useRef<AbortController | null>(null);
  const requestEpoch = useRef(0);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const expectedVersion = document.current_version.id;
  const count = characterCount(document.current_version.text);
  const maxCharacters = Math.min(3000, settings?.max_characters ?? 3000);
  const enabled = available && settings?.enabled === true;
  const active = isGenerationActive(job);
  const fixture = settings?.provider === "fixture";
  useEffect(() => {
    mounted.current = true;
    const restoration = new AbortController();
    const epoch = requestEpoch.current;
    // An interrupted POST may have been accepted while this view was away.
    // Read its status before offering a new intention; never generate on mount.
    if (intents.has(expectedVersion))
      void api
        .document(document.id, restoration.signal)
        .then((fresh) => {
          if (
            !mounted.current ||
            restoration.signal.aborted ||
            requestEpoch.current !== epoch ||
            fresh.current_version.id !== expectedVersion
          )
            return;
          const restored = restoreGenerationJob(
            fresh.audio_generation ?? null,
            intents.get(expectedVersion),
          );
          setJob(restored);
          if (!restored && fresh.audio_generation?.state === "failed")
            setNotice(uncertainNotice);
          if (fresh.audio_generation?.state === "succeeded")
            onReadyRef.current(fresh, fresh.audio_generation);
        })
        .catch(() => {
          if (
            mounted.current &&
            !restoration.signal.aborted &&
            requestEpoch.current === epoch
          )
            setNotice(
              "前回の依頼状況を取得できません。同じ依頼として送信を再試行できます。",
            );
        });
    return () => {
      mounted.current = false;
      restoration.abort();
      post.current?.abort();
    };
  }, [document.id, expectedVersion, intents]);
  useEffect(() => {
    if (!job || !active || pollPaused) return;
    const poller = new GenerationPoller({
      visible: () => !window.document.hidden,
      read: (id, signal) => api.generationJob(id, signal),
      receive: async (next, signal) => {
        if (!mounted.current || signal.aborted) return;
        if (next.document_version !== expectedVersion)
          throw new Error("資料バージョンが一致しません。");
        if (next.state === "succeeded") {
          const fresh = await api.document(document.id, signal);
          if (!mounted.current || signal.aborted) return;
          if (fresh.current_version.id !== expectedVersion) {
            setPollPaused(true);
            setNotice("資料の最新版が変わりました。資料を選び直してください。");
            return;
          }
          setJob(next);
          onReadyRef.current(fresh, next);
        } else setJob(next);
      },
      failed: () => {
        if (mounted.current) {
          setPollPaused(true);
          setNotice(
            "生成状況を取得できません。『状況を確認』で確認できます。生成依頼は自動で再送しません。",
          );
        }
      },
      expired: () => {
        if (mounted.current) {
          setPollPaused(true);
          setNotice(
            "自動確認をいったん止めました。処理が続いている可能性があります。『状況を確認』を押してください。",
          );
        }
      },
    });
    poller.start(job.id);
    const visibility = () => poller.visibilityChanged();
    window.document.addEventListener("visibilitychange", visibility);
    return () => {
      poller.stop();
      window.document.removeEventListener("visibilitychange", visibility);
    };
  }, [job?.id, active, pollCycle, pollPaused, document.id, expectedVersion]);
  async function generate() {
    if (disabled || submitting || active || !enabled || count > maxCharacters)
      return;
    const controller = new AbortController();
    requestEpoch.current++;
    post.current = controller;
    setSubmitting(true);
    setNotice("");
    // Preserve the key after an unknown HTTP outcome. Only a known failed job
    // plus a deliberate retry creates a new potentially billable intention.
    const clientId =
      job?.state === "failed"
        ? crypto.randomUUID()
        : (intents.get(expectedVersion) ?? crypto.randomUUID());
    intents.set(expectedVersion, clientId);
    if (job?.state === "failed") setJob(null);
    try {
      const next = await api.generateAudio(
        document.id,
        expectedVersion,
        clientId,
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      intents.set(expectedVersion, next.client_id);
      setPollPaused(false);
      setJob(next);
      if (next.state === "succeeded") {
        const fresh = await api.document(document.id, controller.signal);
        if (
          mounted.current &&
          !controller.signal.aborted &&
          fresh.current_version.id === expectedVersion
        )
          onReadyRef.current(fresh, next);
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setNotice(
          `${error instanceof Error ? error.message : "生成を依頼できませんでした。"} 依頼済みの可能性があります。再送時は同じ依頼IDで確認し、新しい生成依頼は自動で行いません。`,
        );
    } finally {
      if (post.current === controller) post.current = null;
      if (mounted.current) setSubmitting(false);
    }
  }
  return (
    <div className="generation-panel">
      <p>この資料の音声はまだありません。</p>
      {fixture ? (
        <p className="muted">
          テスト環境：生成されるのはテスト用無音音声です。日本語本文の合成音声ではなく、Amazon
          Pollyへの送信・課金も行いません。
        </p>
      ) : (
        <p className="muted">
          本文を原文のままAmazon
          Pollyへ送信し、日本語の音声を生成します。生成には利用料が発生します。
          {enabled &&
            settings &&
            ` この本文の生成費用の目安は$${((count * settings.price_per_million_usd) / 1_000_000).toFixed(6)}です。`}
        </p>
      )}
      <p className="muted">
        {count.toLocaleString()} / {maxCharacters.toLocaleString()}字
        {count > maxCharacters
          ? "。上限を超えています。短く分けて登録してください。"
          : "。要約・書き換えは行いません。"}
      </p>
      {!enabled && (
        <p className="muted" data-testid="tts-disabled">
          読み上げサービスは未設定、または課金利用が承認されていません。登録テキストの音声化は現在できません。録音操作は「デモ音声で試す」から確認できます。
        </p>
      )}
      <p className="muted" role="status" data-testid="tts-status">
        {notice ||
          (job?.state === "queued"
            ? "生成を受け付けました。順番を待っています。"
            : job?.state === "running"
              ? "音声を生成しています。完了後に再生できます。"
              : job?.state === "failed"
                ? generationFailure(job.error_code)
                : "")}
      </p>
      {job?.state === "failed" && (
        <p className="muted">
          再試行は新しい生成依頼になり、再度費用が発生する可能性があります。自動では再試行しません。
        </p>
      )}
      <button
        className="primary full"
        data-testid="tts-generate"
        disabled={
          disabled || submitting || active || !enabled || count > maxCharacters
        }
        onClick={() => void generate()}
      >
        {submitting
          ? "依頼しています…"
          : active
            ? "生成中…"
            : job?.state === "failed"
              ? "音声生成を再試行"
              : notice
                ? "同じ依頼の送信を再試行"
                : "音声を生成"}
      </button>
      {active && pollPaused && (
        <button
          className="soft full"
          data-testid="tts-check"
          disabled={disabled}
          onClick={() => {
            setNotice("");
            setPollPaused(false);
            setPollCycle((value) => value + 1);
          }}
        >
          状況を確認
        </button>
      )}
    </div>
  );
}
