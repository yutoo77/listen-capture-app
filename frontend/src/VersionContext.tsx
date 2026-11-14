import { useEffect, useRef, useState } from "react";
import type { AudioSegment } from "./narration";
import { api, request } from "./api";
import { Icon } from "./Icons";
import type { AudioVersion, Document } from "./types";

type Props = {
  document: Document;
  audio?: AudioVersion;
  disabled: boolean;
  onDelete: () => void;
  onSourceDeleted?: () => void;
  onReturnPlayer?: () => void;
  segment?: AudioSegment;
  focusRequest?: number;
};
type Version = Document["current_version"];

export default function VersionContext(props: Props) {
  const versionId =
    props.audio?.document_version ?? props.document.current_version.id;
  return <SourceVersion key={`${props.document.id}:${versionId}`} {...props} />;
}

function SourceVersion({
  document,
  audio,
  disabled,
  onDelete,
  onSourceDeleted,
  onReturnPlayer,
  segment,
  focusRequest,
}: Props) {
  const versionId = audio?.document_version ?? document.current_version.id;
  const isCurrent = versionId === document.current_version.id;
  const [version, setVersion] = useState<Version | null>(
    isCurrent ? document.current_version : null,
  );
  const [opened, setOpened] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceBusy, setSourceBusy] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (focusRequest && details.current) {
      details.current.open = true;
      setOpened(true);
    }
  }, [focusRequest]);

  useEffect(() => {
    if (!opened || (version && (!segment || version.blocks))) return;
    const controller = new AbortController();
    void request<Version>(
      `documents/${encodeURIComponent(document.id)}/versions/${encodeURIComponent(versionId)}/`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setVersion(result);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "音声に対応する本文を読み込めません。もう一度お試しください。",
          );
      });
    return () => controller.abort();
  }, [opened, document.id, versionId, attempt, version, segment]);

  return (
    <details
      ref={details}
      className="source-text"
      onToggle={(event) => setOpened(event.currentTarget.open)}
    >
      <summary>
        <Icon name="book" size={16} /> 資料の本文
        {isCurrent ? "" : "（音声の版）"}
      </summary>
      {document.source_pdf?.start_page && document.source_pdf.end_page && (
        <p className="muted" data-testid="source-page-range">
          PDF原本 {document.source_pdf.start_page}〜
          {document.source_pdf.end_page}ページ
          {!document.source_pdf.source_available && " · 原本削除済み"}
        </p>
      )}
      {document.source_pdf?.source_available && (
        <div className="source-file">
          <a
            href={document.source_pdf.source_url ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="download" size={16} />
            PDF原本をダウンロード
          </a>
          <button
            className="text-button danger"
            disabled={disabled || sourceBusy}
            onClick={async () => {
              if (
                !window.confirm(
                  "PDF原本を削除しますか？確認済みの本文と録音は残ります。",
                )
              )
                return;
              setSourceBusy(true);
              setSourceError("");
              try {
                await api.deletePdf(document.source_pdf!.id);
                onSourceDeleted?.();
              } catch {
                setSourceError(
                  "原本を削除できませんでした。もう一度お試しください。",
                );
              } finally {
                setSourceBusy(false);
              }
            }}
          >
            <Icon name="trash" size={16} />
            PDF原本を削除
          </button>
          {sourceError && <p role="alert">{sourceError}</p>}
        </div>
      )}
      {version ? (
        <>
          {!isCurrent && (
            <p className="muted">資料 v{version.number} · 音声に対応する本文</p>
          )}
          {segment && (
            <p className="muted">
              区間{segment.index + 1}
              の本文を強調 · 単語ごとの同期ではありません。
            </p>
          )}
          {segment && opened && (
            <div
              className="source-context-navigation"
              role="group"
              aria-label="本文と再生の移動"
            >
              <button
                type="button"
                className="text-button"
                disabled={
                  disabled ||
                  !version.blocks?.length ||
                  !segment.block_ids.length
                }
                onClick={() => {
                  const passage = details.current?.querySelector<HTMLElement>(
                    '[data-testid="active-source-block"]',
                  );
                  passage?.focus({ preventScroll: true });
                  passage?.scrollIntoView({
                    block: "start",
                    behavior: "instant",
                  });
                }}
              >
                <Icon name="book" size={16} />
                対応する本文へ移動
              </button>
              {onReturnPlayer && (
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled}
                  onClick={onReturnPlayer}
                >
                  <Icon name="headphones" size={16} />
                  再生プレーヤーへ戻る
                </button>
              )}
            </div>
          )}
          <p data-testid="source-context">
            {segment && version.blocks?.length
              ? version.blocks.map((block) => (
                  <span
                    key={block.id}
                    className={
                      segment.block_ids.includes(block.id)
                        ? "active-source-block"
                        : undefined
                    }
                    data-testid={
                      segment.block_ids.includes(block.id)
                        ? "active-source-block"
                        : undefined
                    }
                    tabIndex={
                      segment.block_ids.includes(block.id) ? -1 : undefined
                    }
                  >
                    {block.text}
                  </span>
                ))
              : version.text}
          </p>
          {version && error && (
            <p role="alert">
              {error}
              <button
                className="text-button"
                onClick={() => {
                  setError("");
                  setAttempt((value) => value + 1);
                }}
              >
                <Icon name="refresh" size={16} />
                本文の区間を再読込
              </button>
            </p>
          )}
        </>
      ) : error ? (
        <div>
          <p role="alert">{error}</p>
          <button
            className="text-button"
            onClick={() => {
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            <Icon name="refresh" size={16} />
            本文の読み込みを再試行
          </button>
        </div>
      ) : (
        <p role="status">音声に対応する本文を読み込んでいます…</p>
      )}
      <button
        className="text-button danger"
        disabled={disabled}
        onClick={onDelete}
      >
        <Icon name="trash" size={16} />
        資料と関連する録音を削除
      </button>
    </details>
  );
}
