import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";
import {
  PdfPageIntents,
  PdfPageRequests,
  PdfPageStorageError,
} from "./pdfPages";
import type { PdfPageIntent } from "./pdfPages";
import type { Document, PdfImportJob } from "./types";

const failure = (code: string | null) =>
  ({
    page_limit: "原本は200ページまでです。必要な章に分けてください。",
    page_selection_required:
      "取り込むページを選んでください。連続する50ページまで抽出できます。",
    invalid_page_range:
      "原本の範囲内で、連続する50ページ以内を選んでください。",
    text_limit: "抽出した本文は20,000文字までです。資料を分けてください。",
    processing_timeout:
      "制限時間内に抽出できませんでした。資料を分けるか、テキストを貼り付けてください。",
    resource_limit:
      "PDFが複雑すぎるため安全に処理できませんでした。資料を分けるか、テキストを貼り付けてください。",
    active_content:
      "スクリプトや埋め込みファイルを含むPDFは取り込めません。通常のPDFとして書き出し直してください。",
    sandbox_unavailable:
      "PDFの検証環境を利用できません。時間をおくか、テキストを貼り付けてください。",
    invalid_pdf:
      "PDFを読み取れません。ファイルを確認するか、テキストを貼り付けてください。",
    encrypted_pdf: "パスワード付きPDFは取り込めません。",
    no_text:
      "抽出できるテキストがありません。画像だけのPDFやOCRには対応していません。",
    too_many_pages:
      "ページ数が上限を超えています。必要なページだけに分けてください。",
    text_too_long: "抽出した本文が長すぎます。資料を分けてください。",
    extraction_timeout:
      "制限時間内に抽出できませんでした。資料を分けるか、テキストを貼り付けてください。",
    execution_unknown:
      "抽出処理が中断されました。元のPDFを取り込み直してください。",
  })[code ?? ""] ??
  "PDFの抽出を完了できませんでした。テキストの貼り付けも利用できます。";

export default function ImportDocument({
  userId,
  disabled,
  onSubmit,
  onImported,
  onClose,
  onBusyChange,
  onDirtyChange,
}: {
  userId: string;
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onImported: (document: Document) => void;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [method, setMethod] = useState<"text" | "pdf">("text");
  const [imports, setImports] = useState<PdfImportJob[]>([]);
  const [job, setJob] = useState<PdfImportJob | null>(null);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [poll, setPoll] = useState(0);
  const [firstPage, setFirstPage] = useState("1");
  const [lastPage, setLastPage] = useState("1");
  const [pageIntent, setPageIntent] = useState<PdfPageIntent | null>(null);
  const [pageStorageError, setPageStorageError] = useState(false);
  const [pageConflict, setPageConflict] = useState(false);
  const pageRequests = useRef<PdfPageRequests | null>(null);
  const upload = useRef<{ file: File; id: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const textDirty = Boolean(textTitle || textBody);
  const pdfTitle =
    job?.suggested_title ||
    job?.filename?.replace(/\.pdf$/i, "").slice(0, 160) ||
    "";
  const pdfDirty = Boolean(
    job &&
    !job.confirmed_document &&
    job.state === "succeeded" &&
    (text !== job.extracted_text || title !== pdfTitle),
  );
  const dirty = textDirty || pdfDirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [dirty, busy]);
  function discardPdfEdits() {
    return (
      !pdfDirty || window.confirm("修正中のPDFのタイトル・本文を破棄しますか？")
    );
  }
  function leave() {
    if (dirty && !window.confirm("未保存の資料入力を破棄して戻りますか？"))
      return;
    onClose();
  }
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const select = (value: PdfImportJob) => {
    setJob(value);
    setText(value.extracted_text || "");
    setChecked(false);
    setError("");
    if (value.suggested_title) setTitle(value.suggested_title);
    else if (value.filename)
      setTitle(value.filename.replace(/\.pdf$/i, "").slice(0, 160));
    else setTitle("");
    setFirstPage(String(value.start_page ?? 1));
    setLastPage(String(value.end_page ?? Math.min(value.page_count ?? 1, 50)));
    setPageConflict(false);
  };
  useEffect(() => {
    setPageStorageError(false);
    setPageIntent(null);
    if (!job) return;
    let current: PdfPageRequests | undefined;
    try {
      current = new PdfPageRequests(
        job.id,
        new PdfPageIntents(userId, job.id, sessionStorage),
      );
      setPageIntent(current.restore());
      pageRequests.current = current;
    } catch {
      setPageStorageError(true);
    }
    return () => {
      current?.dispose();
      if (pageRequests.current === current) pageRequests.current = null;
    };
  }, [job?.id, userId]);
  useEffect(() => {
    setFirstPage(String(job?.start_page ?? 1));
    setLastPage(String(job?.end_page ?? Math.min(job?.page_count ?? 1, 50)));
  }, [job?.id, job?.start_page, job?.end_page, job?.page_count]);
  useEffect(() => {
    alive.current = true;
    void api
      .pdfImports(userId)
      .then((items) => {
        if (alive.current) setImports(items);
      })
      .catch(() => {
        if (alive.current)
          setError("PDFの取込履歴を取得できません。開き直すと再確認できます。");
      });
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.state)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api
        .pdfImport(job.id, controller.signal)
        .then((value) => {
          if (!alive.current || controller.signal.aborted) return;
          setJob(value);
          if (value.state === "succeeded") setText(value.extracted_text);
          setPoll((n) => n + 1);
        })
        .catch(() => {
          if (!controller.signal.aborted && alive.current)
            setError(
              "抽出状況を取得できません。「状況を確認」で再接続できます。",
            );
        });
    }, 1500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job, poll]);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!upload.current || busy || disabled) return;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await api.uploadPdf(
        upload.current.file,
        upload.current.id,
        userId,
        controller.signal,
      );
      if (alive.current) select(value);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? `${e.message} 同じファイルを再送して受付結果を確認できます。`
            : "PDFを送信できませんでした。",
        );
    } finally {
      request.current = null;
      if (alive.current) setBusy(false);
    }
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !job ||
      !checked ||
      busy ||
      disabled ||
      pageIntent ||
      pageStorageError ||
      pageConflict
    )
      return;
    if (
      textDirty &&
      !window.confirm(
        "テキスト側の未保存入力を破棄して、PDFの本文を保存しますか？",
      )
    )
      return;
    setBusy(true);
    setError("");
    const key = `lc-pdf-confirm:${userId}:${job.id}`;
    let clientId: string;
    try {
      clientId = sessionStorage.getItem(key) ?? crypto.randomUUID();
      sessionStorage.setItem(key, clientId);
    } catch {
      setError(
        "保存依頼を端末に記録できません。同じタブで再試行してください。",
      );
      clientId = job.id;
    }
    try {
      const document = await api.confirmPdf(
        job.id,
        clientId,
        title,
        text,
        job.selection_revision,
      );
      if (alive.current) onImported(document);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "本文を保存できませんでした。",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function choosePages(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const current = pageRequests.current;
    if (
      !job ||
      !current ||
      current.busy ||
      busy ||
      disabled ||
      pageStorageError
    )
      return;
    if (
      !pageIntent &&
      pdfDirty &&
      !window.confirm(
        "ページを変えると、修正中のタイトル・本文を新しい抽出結果に置き換えます。続けますか？",
      )
    )
      return;
    const value = pageIntent ?? {
      client_id: crypto.randomUUID(),
      start_page: Number(firstPage),
      end_page: Number(lastPage),
      revision: job.selection_revision,
    };
    setBusy(true);
    setError("");
    try {
      const response = current.submit(value);
      setPageIntent(current.pending);
      const result = await response;
      if (!alive.current || pageRequests.current !== current || !result) return;
      select(result.job);
      setPageIntent(result.pending);
      if (result.cleanupFailed)
        setError(
          "ページ選択は受付済みですが、端末の記録を削除できません。同じ依頼を確認してください。",
        );
      else if (result.job.selection_revision > value.revision + 1)
        setError(
          "別の画面でページが更新されています。最新の抽出結果を表示しています。",
        );
    } catch (e) {
      if (!alive.current || pageRequests.current !== current) return;
      setPageIntent(current.pending);
      if (e instanceof PdfPageStorageError) setPageStorageError(true);
      if (e instanceof ApiError && e.status === 409) setPageConflict(true);
      setError(
        `${e instanceof Error ? e.message : "受付結果を確認できません。"} ${e instanceof ApiError && e.status === 409 ? "最新の取込状況を確認してください。" : "同じページ選択で受付結果を確認できます。"}`,
      );
    } finally {
      if (alive.current && pageRequests.current === current) setBusy(false);
    }
  }
  const refreshJob = async () => {
    if (!job || busy || disabled) return;
    if (!discardPdfEdits()) return;
    const id = job.id;
    setBusy(true);
    try {
      const value = await api.pdfImport(id);
      if (alive.current && pageRequests.current && id === value.id)
        select(value);
    } catch {
      if (alive.current)
        setError(
          "最新の取込状況を取得できません。時間をおいて再確認してください。",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const locked = busy || disabled;
  const selectionBlocked = Boolean(
    pageIntent || pageStorageError || pageConflict,
  );
  const pageForm =
    job?.page_count && job.source_available && !job.confirmed_document ? (
      <form onSubmit={(event) => void choosePages(event)}>
        <p className="muted">
          先頭を1と数えるPDFのページ番号です。連続する50ページまで。
        </p>
        <label htmlFor="pdf-first-page">開始ページ</label>
        <input
          id="pdf-first-page"
          type="number"
          min={1}
          max={job.page_count}
          value={pageIntent ? String(pageIntent.start_page) : firstPage}
          required
          disabled={locked || selectionBlocked}
          onChange={(event) => setFirstPage(event.target.value)}
        />
        <label htmlFor="pdf-last-page">終了ページ</label>
        <input
          id="pdf-last-page"
          type="number"
          min={Number(firstPage) || 1}
          max={Math.min(job.page_count, (Number(firstPage) || 1) + 49)}
          value={pageIntent ? String(pageIntent.end_page) : lastPage}
          required
          disabled={locked || selectionBlocked}
          onChange={(event) => setLastPage(event.target.value)}
        />
        <button className="soft" disabled={locked || selectionBlocked}>
          選んだページを抽出
        </button>
      </form>
    ) : null;
  return (
    <section className="import-screen panel" aria-labelledby="import-heading">
      <button className="text-button" onClick={leave} disabled={locked}>
        ← ライブラリへ戻る
      </button>
      <h2 id="import-heading">資料を追加</h2>
      <div className="import-methods" role="group" aria-label="登録方法">
        <button
          className={method === "text" ? "primary" : "soft"}
          disabled={locked}
          onClick={() => {
            setMethod("text");
            setError("");
          }}
        >
          テキスト
        </button>
        <button
          className={method === "pdf" ? "primary" : "soft"}
          disabled={locked}
          onClick={() => {
            setMethod("pdf");
            setError("");
          }}
        >
          PDF
        </button>
      </div>
      {error && (
        <p className="notice warning" role="alert">
          {error}
        </p>
      )}
      {method === "pdf" && pageStorageError && (
        <p role="alert">
          ページ選択の受付記録を安全に使えません。記録を消さず保存領域を確認してから開き直してください。
        </p>
      )}
      {method === "pdf" && pageIntent && !pageStorageError && (
        <div>
          <p>
            受付を確認する範囲：{pageIntent.start_page}〜{pageIntent.end_page}
            ページ
          </p>
          <button
            className="soft"
            disabled={locked}
            onClick={() => void choosePages()}
          >
            同じページ選択を確認
          </button>
        </div>
      )}
      {method === "pdf" && pageConflict && (
        <button
          className="text-button"
          disabled={locked}
          onClick={() => void refreshJob()}
        >
          最新の取込状況を確認
        </button>
      )}
      {method === "text" ? (
        <form
          onSubmit={(event) => {
            if (!discardPdfEdits()) {
              event.preventDefault();
              return;
            }
            void onSubmit(event);
          }}
        >
          <label htmlFor="document-title">タイトル</label>
          <input
            id="document-title"
            name="title"
            value={textTitle}
            onChange={(event) => setTextTitle(event.target.value)}
            required
            maxLength={160}
            disabled={locked}
          />
          <label htmlFor="document-text">資料のテキスト</label>
          <textarea
            id="document-text"
            name="text"
            value={textBody}
            onChange={(event) => setTextBody(event.target.value)}
            required
            maxLength={20000}
            rows={15}
            disabled={locked}
          />
          <p className="muted">20,000文字まで。</p>
          <button className="primary" disabled={locked}>
            資料を保存
          </button>
        </form>
      ) : (
        <>
          {!job ? (
            <>
              <form onSubmit={(e) => void send(e)}>
                <label htmlFor="pdf-file">PDFファイル</label>
                <input
                  id="pdf-file"
                  type="file"
                  accept=".pdf,application/pdf"
                  disabled={locked}
                  required
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    upload.current = file
                      ? { file, id: crypto.randomUUID() }
                      : null;
                    setError("");
                    if (file && file.size > 10 * 1024 * 1024) {
                      upload.current = null;
                      setError("PDFは10 MiBまでです。");
                    }
                  }}
                />
                <p className="muted">
                  10
                  MiB・原本200ページまで。必要な50ページ以内を選べます。テキストを選択できるPDFに対応し、OCRは行いません。
                </p>
                <button className="primary" disabled={locked}>
                  {busy ? "送信しています…" : "PDFを取り込む"}
                </button>
                {busy && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => request.current?.abort()}
                  >
                    送信を中断
                  </button>
                )}
              </form>
              {imports.length > 0 && (
                <div className="import-history">
                  <h3>取込履歴</h3>
                  {imports.map((item) => (
                    <button
                      key={item.id}
                      className="document-choice"
                      disabled={locked}
                      onClick={() => select(item)}
                    >
                      {item.suggested_title || item.filename || "取り込んだPDF"}
                      <small>
                        {item.confirmed_document
                          ? "本文保存済み"
                          : item.state === "succeeded"
                            ? "本文を確認"
                            : item.state === "failed"
                              ? item.error_code === "page_selection_required"
                                ? "ページを選択"
                                : "抽出できませんでした"
                              : "抽出中"}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <button
                className="text-button"
                disabled={locked}
                onClick={() => {
                  if (!discardPdfEdits()) return;
                  setJob(null);
                  setError("");
                }}
              >
                別のPDFを取り込む
              </button>
              {job.page_count && (
                <p className="muted">
                  原本 {job.page_count}ページ
                  {job.start_page && job.end_page
                    ? ` · 抽出 ${job.start_page}–${job.end_page}ページ`
                    : ""}
                </p>
              )}
              {pageForm &&
                (job.start_page ? (
                  <details>
                    <summary>抽出ページを変更</summary>
                    {pageForm}
                  </details>
                ) : (
                  pageForm
                ))}
              {job.source_available && (
                <p>
                  <a
                    href={`/api/pdf-imports/${encodeURIComponent(job.id)}/source/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    原本をダウンロード
                  </a>{" "}
                  <button
                    className="text-button danger"
                    disabled={locked}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          pdfDirty
                            ? "非公開のPDF原本と、未保存の修正本文を削除しますか？保存済みの本文と録音は残ります。"
                            : "非公開のPDF原本を削除しますか？保存済みの本文と録音は残ります。",
                        )
                      )
                        return;
                      setBusy(true);
                      try {
                        await api.deletePdf(job.id);
                        setJob(null);
                        setImports((items) =>
                          items.filter((item) => item.id !== job.id),
                        );
                      } catch (e) {
                        setError(
                          e instanceof Error
                            ? e.message
                            : "原本を削除できませんでした。",
                        );
                      } finally {
                        if (alive.current) setBusy(false);
                      }
                    }}
                  >
                    原本を削除
                  </button>
                </p>
              )}
              {["queued", "running"].includes(job.state) ? (
                <div role="status">
                  <p>PDFから本文を抽出しています…</p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setError("");
                      setPoll((n) => n + 1);
                    }}
                  >
                    状況を確認
                  </button>
                </div>
              ) : job.state === "failed" ? (
                <p
                  className={
                    job.error_code === "page_selection_required"
                      ? "notice"
                      : "notice warning"
                  }
                  role={
                    job.error_code === "page_selection_required"
                      ? "status"
                      : "alert"
                  }
                >
                  {failure(job.error_code)}
                </p>
              ) : job.confirmed_document ? (
                <div>
                  <p>このPDFの本文は保存済みです。</p>
                  <button
                    className="primary"
                    disabled={locked}
                    onClick={async () => {
                      if (
                        dirty &&
                        !window.confirm(
                          "未保存の資料入力を破棄して、保存済み資料を開きますか？",
                        )
                      )
                        return;
                      try {
                        onImported(await api.document(job.confirmed_document!));
                      } catch {
                        setError("保存済み資料を開けませんでした。");
                      }
                    }}
                  >
                    保存済みの資料を開く
                  </button>
                </div>
              ) : (
                <form onSubmit={(e) => void confirm(e)}>
                  <p className="notice">
                    段組み・脚注・表・数式は読み順や内容が変わることがあります。原本と照らして、読み上げる本文を確認・修正してください。
                  </p>
                  <label htmlFor="pdf-title">タイトル</label>
                  <input
                    id="pdf-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    required
                    maxLength={160}
                    disabled={locked || selectionBlocked}
                  />
                  <label htmlFor="pdf-text">読み上げる本文</label>
                  <textarea
                    id="pdf-text"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setChecked(false);
                    }}
                    rows={20}
                    maxLength={20000}
                    required
                    disabled={locked || selectionBlocked}
                  />
                  <p className="muted">
                    {[...text].length.toLocaleString()} / 20,000文字
                  </p>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setChecked(e.target.checked)}
                      required
                      disabled={locked || selectionBlocked}
                    />
                    読み順と本文を確認しました
                  </label>
                  <button
                    className="primary"
                    disabled={locked || !checked || selectionBlocked}
                  >
                    {busy ? "保存しています…" : "本文を確定して保存"}
                  </button>
                </form>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
