import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { Icon } from "./Icons";
import type { Document } from "./types";

export default function DocumentEditor({
  document,
  userId,
  verifyAccount,
  onSaved,
  onLatest,
  onClose,
}: {
  document: Document;
  userId: string;
  verifyAccount: () => Promise<boolean>;
  onSaved: (document: Document) => void;
  onLatest: (document: Document) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState(document);
  const [title, setTitle] = useState(document.title);
  const [text, setText] = useState(document.current_version.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<Document | null>(null);
  const alive = useRef(true);
  const dirty = title !== base.title || text !== base.current_version.text;
  useEffect(() => {
    alive.current = true;
    const element = dialog.current!;
    const previous = window.document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      alive.current = false;
      element.close();
      previous?.focus();
    };
  }, []);
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
  function close() {
    if (busy || (dirty && !window.confirm("修正中の本文を破棄しますか？")))
      return;
    onClose();
  }
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!(await verifyAccount()) || !alive.current) {
        setError(
          "元のアカウントでログインし直してください。修正内容はこの画面に残しています。",
        );
        return;
      }
      let saved: Document;
      try {
        saved = await api.updateDocument(
          base.id,
          title,
          text,
          base.current_version.id,
          userId,
          base.updated_at,
        );
      } catch (failure) {
        // A lost ACK must not create another version. Compare a fresh owned
        // snapshot; never silently rebase an unsent edit onto someone else's.
        if (
          !(failure instanceof ApiError) ||
          ![0, 409].includes(failure.status)
        )
          throw failure;
        const current = await api.document(base.id);
        if (
          current.title === title.trim() &&
          current.current_version.text === text
        )
          saved = current;
        else {
          if (alive.current) setLatest(current);
          throw new Error(
            failure.status === 409
              ? "別の画面で資料が更新されています。修正内容を残しました。"
              : "保存結果を確認できません。修正内容を残しました。",
            { cause: failure },
          );
        }
      }
      if (alive.current) onSaved(saved);
    } catch (failure) {
      if (alive.current)
        setError(
          failure instanceof Error ? failure.message : "保存できませんでした。",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="document-editor panel"
      aria-labelledby="edit-heading"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="section-title">
          <h2 id="edit-heading">資料を修正</h2>
          <button
            type="button"
            className="text-button"
            aria-label="修正を閉じる"
            disabled={busy}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <label htmlFor="edit-title">タイトル</label>
        <input
          id="edit-title"
          value={title}
          maxLength={160}
          required
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label htmlFor="edit-text">本文</label>
        <textarea
          id="edit-text"
          rows={12}
          value={text}
          maxLength={20000}
          required
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="muted">
          録音と音声は、修正前の本文に紐づいたまま残ります。
        </p>
        {error && (
          <p className="notice warning" role="alert">
            {error}
          </p>
        )}
        {latest && (
          <button
            type="button"
            className="soft"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "修正中の内容を破棄して、保存済みの最新本文を読み込みますか？",
                )
              ) {
                setBase(latest);
                setTitle(latest.title);
                setText(latest.current_version.text);
                onLatest(latest);
                setLatest(null);
                setError("");
              }
            }}
          >
            最新本文を読み込む
          </button>
        )}
        <div className="editor-actions">
          <button
            type="button"
            className="soft"
            disabled={busy}
            onClick={close}
          >
            キャンセル
          </button>
          <button
            className="primary"
            disabled={busy || !dirty || !title.trim() || !text.trim()}
          >
            <Icon name="check" />
            {busy ? "保存中…" : "修正を保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
