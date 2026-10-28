import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { dateLabel, formatTime } from "./presentation";
import { Icon } from "./Icons";
import type { Memo, PendingMemo } from "./types";

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "操作を完了できませんでした。";
}

// Card-local media is paused when its tab closes or the saved blob is removed.
// Keep registration stable across source-player time updates and other renders.
function MemoAudio({
  src,
  label,
  disabled,
  register,
  onPlay,
  onError,
}: {
  src: string;
  label: string;
  disabled: boolean;
  register: (element: HTMLAudioElement | null) => void;
  onPlay: (element: HTMLAudioElement) => void;
  onError: () => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const registration = useRef(register);
  registration.current = register;
  useEffect(() => {
    const element = audio.current!;
    registration.current(element);
    return () => {
      element.pause();
      registration.current(null);
    };
  }, [src]);
  return (
    <audio
      ref={audio}
      controls
      preload="none"
      src={src}
      aria-label={label}
      inert={disabled}
      onPlay={(event) => onPlay(event.currentTarget)}
      onError={onError}
    />
  );
}

export function PendingCard({
  memo,
  durable,
  disabled,
  onRetry,
  onDiscard,
  register,
  onPlay,
  onStatus,
}: {
  memo: PendingMemo;
  durable: boolean;
  disabled: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  register: (element: HTMLAudioElement | null) => void;
  onPlay: (element: HTMLAudioElement) => void;
  onStatus: (status: string) => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(memo.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [memo.blob]);
  const extension = memo.blob.type.includes("mp4")
    ? "m4a"
    : memo.blob.type.includes("ogg")
      ? "ogg"
      : memo.blob.type.includes("wav")
        ? "wav"
        : "webm";
  return (
    <article className="pending-card" data-testid="pending-memo">
      <div className="pending-heading">
        <strong title={memo.documentTitle}>{memo.documentTitle}</strong>
        <span
          className="memo-position"
          aria-label={`教材の位置 ${formatTime(memo.positionMs)}`}
        >
          教材 {formatTime(memo.positionMs)}
        </span>
      </div>
      <p>
        {durable
          ? "端末内に一時保存済み / サーバー保存は未確認"
          : "このタブ内のみ / 閉じると失われます"}
      </p>
      {url && (
        <MemoAudio
          register={register}
          src={url}
          label={`${memo.documentTitle}の未送信録音を試聴`}
          disabled={disabled}
          onPlay={onPlay}
          onError={() =>
            onStatus(
              "端末内の録音を再生できません。ダウンロードして保管し、再送をお試しください。",
            )
          }
        />
      )}
      <div className="button-row">
        <button className="soft" disabled={disabled} onClick={onRetry}>
          <Icon name="refresh" size={16} />
          保存を再試行
        </button>
        <a
          className="soft button-link"
          href={url}
          download={`recording-${memo.clientId}.${extension}`}
        >
          <Icon name="download" size={16} />
          録音をダウンロード
        </a>
        <button
          className="text-button danger"
          disabled={disabled}
          onClick={onDiscard}
        >
          <Icon name="trash" size={16} />
          この端末の録音を破棄
        </button>
      </div>
    </article>
  );
}

export function RecentMemo({
  memo,
  disabled,
  sourcePaused,
  register,
  onPlay,
  onOpen,
  onResume,
  onStatus,
}: {
  memo: Memo;
  disabled: boolean;
  sourcePaused: boolean;
  register: (element: HTMLAudioElement | null) => void;
  onPlay: (element: HTMLAudioElement) => void;
  onOpen: () => void;
  onResume: () => void;
  onStatus: (status: string) => void;
}) {
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    // Reveal the result of this recording, including its audition controls,
    // rather than leaving the confirmation below a short desktop viewport.
    card.current?.scrollIntoView({ block: "nearest" });
  }, [memo.id]);
  return (
    <aside
      ref={card}
      className="recent-memo"
      aria-label="直前に保存した声のメモ"
      data-testid="recent-memo"
    >
      <p>
        <Icon name="check" size={16} />
        サーバー保存済み · 録音 {formatTime(memo.duration_ms)}
      </p>
      <MemoAudio
        register={register}
        src={memo.media_url}
        label="直前に保存した録音を聴き直す"
        disabled={disabled}
        onPlay={onPlay}
        onError={() =>
          onStatus(
            "保存した録音を再生できません。ログイン状態と接続を確認してください。",
          )
        }
      />
      <div className="button-row">
        {sourcePaused && (
          <button className="soft" disabled={disabled} onClick={onResume}>
            <Icon name="play" size={16} />
            教材を再開
          </button>
        )}
        <button className="text-button" disabled={disabled} onClick={onOpen}>
          <Icon name="note" size={16} />
          メモを開く
        </button>
      </div>
    </aside>
  );
}

export function MemoCard({
  memo,
  text,
  dirty,
  saving,
  draftState = "memory",
  draftConflict = false,
  disabled,
  onReturn,
  register,
  onPlay,
  onSave,
  onTextChange,
  onDelete,
  onStatus,
}: {
  memo: Memo;
  text: string;
  dirty: boolean;
  saving: boolean;
  draftState?: "saving" | "local" | "memory";
  draftConflict?: boolean;
  disabled: boolean;
  onReturn: () => void;
  register: (element: HTMLAudioElement | null) => void;
  onPlay: (element: HTMLAudioElement) => void;
  onSave: () => void;
  onTextChange: (text: string) => void;
  onDelete: () => void;
  onStatus: (status: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!window.confirm("この音声メモを削除しますか？")) return;
    setBusy(true);
    try {
      await api.deleteMemo(memo.id);
      onDelete();
      onStatus("音声メモを削除しました。");
    } catch (error) {
      onStatus(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="memo-card panel"
      data-testid="memo-card"
      aria-labelledby={`memo-heading-${memo.id}`}
    >
      <div className="memo-meta">
        <span
          className="memo-position"
          aria-label={`教材の位置 ${formatTime(memo.position_ms)}`}
        >
          <Icon name="clock" size={15} />
          教材 {formatTime(memo.position_ms)}
        </span>
        <time dateTime={memo.created_at}>{dateLabel(memo.created_at)}</time>
      </div>
      <h3
        id={`memo-heading-${memo.id}`}
        tabIndex={-1}
        title={memo.document.title}
      >
        {memo.document.title}
      </h3>
      <p className="version-label">
        資料 v{memo.document_version.number} · 録音{" "}
        {formatTime(memo.duration_ms)}
      </p>
      <MemoAudio
        register={register}
        src={memo.media_url}
        label={`${memo.document.title}の録音を再生`}
        disabled={disabled || busy}
        onPlay={onPlay}
        onError={() =>
          onStatus(
            "録音を再生できません。ログイン状態と接続を確認してください。",
          )
        }
      />
      <label htmlFor={`memo-text-${memo.id}`} className="memo-text-label">
        メモ
      </label>
      <textarea
        id={`memo-text-${memo.id}`}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        maxLength={10000}
        rows={2}
        disabled={disabled || busy}
      />
      {dirty && (
        <p className="draft-status" role="status">
          <Icon
            name={
              draftState === "saving"
                ? "clock"
                : draftState === "local"
                  ? "check"
                  : "alert"
            }
            size={15}
          />
          {draftState === "saving"
            ? "補足を端末に保存中 · サーバー保存は未確認"
            : draftState === "local"
              ? "補足は端末内に保存済み · サーバー保存は未確認"
              : "補足はこの画面内のみ · サーバー保存は未確認"}
        </p>
      )}
      {dirty && draftConflict && (
        <p className="notice warning draft-conflict" role="alert">
          <Icon name="alert" size={16} />{" "}
          保存済みの補足が変わっています。下書きは残しています。内容を確認してから保存してください。
        </p>
      )}
      <div className="memo-actions">
        <button className="soft" disabled={disabled || busy} onClick={onReturn}>
          <Icon name="back" size={16} />
          元の位置へ戻る
        </button>
        {dirty && (
          <button
            className="soft"
            disabled={disabled || busy || saving}
            onClick={onSave}
          >
            <Icon name="save" size={16} />
            {saving ? "補足を保存中…" : "文章を保存"}
          </button>
        )}
        <button
          className="text-button danger"
          disabled={disabled || busy || saving}
          onClick={() => void remove()}
        >
          <Icon name="trash" size={16} />
          削除
        </button>
      </div>
    </article>
  );
}
