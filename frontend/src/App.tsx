import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, ApiError, login, session } from "./api";
import { CaptureController, recordingSupported } from "./capture";
import type { CaptureState } from "./capture";
import { assertOutboxOwner, outbox } from "./outbox";
import { canApplyGeneration, GenerationIntents } from "./generation";
import GenerationPanel from "./GenerationPanel";
import NarrationPanel from "./NarrationPanel";
import { narrationApi, segmentAt } from "./narration";
import type { NarrationMap } from "./narration";
import VersionContext from "./VersionContext";
import ImportDocument from "./ImportDocument";
import DocumentEditor from "./DocumentEditor";
import MicrophoneInput from "./MicrophoneInput";
import HelpPanel from "./HelpPanel";
import { Icon } from "./Icons";
import { useMemoDrafts } from "./useMemoDrafts";
import { LogicalPlayer, loadPlaylist } from "./player";
import type { PlayerEvent } from "./player";
import { ProgressTracker } from "./progress";
import { MemoCard, PendingCard, RecentMemo } from "./MemoCards";
import { dateLabel, formatTime } from "./presentation";
import type { ProgressState } from "./progress";
import type {
  Document,
  Memo,
  PendingMemo,
  Session,
  TtsSettings,
  User,
} from "./types";

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "操作を完了できませんでした。";
}

function mergeSnapshot<T extends { id: string }>(
  snapshot: T[],
  current: T[],
  deleted: Set<string>,
): T[] {
  const present = new Set(current.map((item) => item.id));
  return [
    ...current,
    ...snapshot.filter(
      (item) => !present.has(item.id) && !deleted.has(item.id),
    ),
  ];
}

export default function App() {
  const [account, setAccount] = useState<Session | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void session()
      .then(setAccount)
      .catch((error) => setError(message(error)));
  }, []);
  return (
    <div className="app-shell">
      <header className="brand-header">
        <span className="wordmark">
          <span className="brand-mark" aria-hidden="true">
            ∿
          </span>
          Listen <span className="brand-slash">/</span> Capture
        </span>
      </header>
      {!account ? (
        <main className="login-screen">
          <h1 className="visually-hidden">Listen / Capture</h1>
          <p role={error ? "alert" : "status"}>
            {error || "読み込んでいます…"}
          </p>
          {error && (
            <button onClick={() => location.reload()}>もう一度開く</button>
          )}
        </main>
      ) : account.user ? (
        <Workspace
          key={account.user.id}
          user={account.user}
          ttsAvailable={account.ttsAvailable}
          tts={account.tts}
          onLogout={() => setAccount({ ...account, user: null })}
        />
      ) : (
        <Login onLogin={setAccount} />
      )}
      <footer>Listen / Capture</footer>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (account: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await session();
      onLogin(
        await login(String(data.get("username")), String(data.get("password"))),
      );
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <h1>ログイン</h1>
      <form
        className="login-card panel"
        onSubmit={(event) => void submit(event)}
      >
        <label htmlFor="username">ユーザー名</label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          maxLength={150}
          disabled={busy}
        />
        <label htmlFor="password">パスワード</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
        />
        {error && (
          <p className="notice warning" role="alert">
            {error}
          </p>
        )}
        <button className="primary full" disabled={busy}>
          {busy ? "確認しています…" : "ログイン"}
        </button>
      </form>
    </main>
  );
}

// A collapsed revision option must not restore/apply a completed generation
// behind the original memo's player. Opening it is an explicit user action.
function RevisedAudioOptions({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="source-text"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>修正後の本文の音声を用意する</summary>
      {open && children}
    </details>
  );
}

function VoiceSettings({
  children,
  disabled,
  onOpen,
}: {
  children: ReactNode;
  disabled: boolean;
  onOpen: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    return () => element.close();
  }, []);
  function close() {
    dialog.current?.close();
    trigger.current?.focus();
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="soft voice-settings-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={() => {
          if (disabled) return;
          onOpen();
          setMounted(true);
          dialog.current?.showModal();
        }}
      >
        <Icon name="volume" size={16} /> 声・高さ
      </button>
      <dialog
        ref={dialog}
        className="voice-dialog panel"
        aria-labelledby="voice-settings-heading"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }}
      >
        <div className="section-title">
          <h2 id="voice-settings-heading">声・高さ</h2>
          <button
            type="button"
            className="text-button"
            aria-label="声・高さを閉じる"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        {/* Keep request state and queued-job polling after the first explicit open.
          Closing hides the modal; it does not discard an uncertain UUID/profile. */}
        {mounted && children}
      </dialog>
    </>
  );
}

function Workspace({
  user,
  ttsAvailable,
  tts,
  onLogout,
}: {
  user: User;
  ttsAvailable: boolean;
  tts?: TtsSettings;
  onLogout: () => void;
}) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [recentMemo, setRecentMemo] = useState<Memo | null>(null);
  // Drafts belong to this signed-in workspace, not a card that disappears on
  // navigation. Keep a ref for beforeunload and compare the submitted value on
  // ACK so an older PATCH cannot discard a newer edit.
  const [status, setStatus] = useState("");
  const draftNotes = useMemoDrafts(user.id, memos, setStatus);
  const { drafts: memoDrafts, draftsRef: memoDraftsRef } = draftNotes;
  const [savingMemos, setSavingMemos] = useState(new Set<string>());
  const savingMemosRef = useRef(new Set<string>());
  const [memoDocument, setMemoDocument] = useState("");
  const [selected, setSelected] = useState<Document | null>(null);
  const [audioId, setAudioId] = useState("");
  const [tab, setTab] = useState<"listen" | "memos" | "help">("listen");
  const previousTab = useRef(tab);
  useEffect(() => {
    if (previousTab.current === tab) return;
    previousTab.current = tab;
    document
      .getElementById(
        tab === "memos"
          ? "memos-heading"
          : tab === "help"
            ? "help-heading"
            : "player-heading",
      )
      ?.focus({ preventScroll: true });
  }, [tab]);
  const [showCreate, setShowCreate] = useState(false);
  const [importDirty, setImportDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [microphoneId, setMicrophoneId] = useState("");
  const [microphoneLabel, setMicrophoneLabel] = useState("");
  const [microphoneLevel, setMicrophoneLevel] = useState<number | null>(null);
  const [microphoneChecking, setMicrophoneChecking] = useState(false);
  const [microphoneAvailable, setMicrophoneAvailable] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [libraryErrors, setLibraryErrors] = useState<string[]>([]);
  const libraryRequest = useRef(0);
  const libraryRevision = useRef({ documents: 0, memos: 0 });
  const deletedDocuments = useRef(new Set<string>());
  const deletedMemos = useRef(new Set<string>());
  const [mutating, setMutating] = useState(false);
  const [pending, setPending] = useState<PendingMemo[]>([]);
  const [durable, setDurable] = useState(new Set<string>());
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(() => {
    try {
      const stored = Number(
        localStorage.getItem(`lc-playback-rate:${user.id}`),
      );
      return [0.75, 1, 1.25, 1.5, 2].includes(stored) ? stored : 1;
    } catch {
      return 1;
    }
  });
  const [mapping, setMapping] = useState<NarrationMap | null>(null);
  const [mappingError, setMappingError] = useState("");
  const [mappingAttempt, setMappingAttempt] = useState(0);
  const [sourceFocus, setSourceFocus] = useState(0);
  const [progressState, setProgressState] = useState<ProgressState>("loading");
  const progressTracker = useRef<ProgressTracker | null>(null);
  const progressTrackers = useRef(new Set<ProgressTracker>());
  const deletedAudioIds = useRef(new Set<string>());
  const [progressRecovery, setProgressRecovery] = useState<
    { id: string; title: string; tracker: ProgressTracker }[]
  >([]);
  const seekIntent = useRef<number | undefined>(undefined);
  const selectedAudioId = useRef("");
  const [outboxReady, setOutboxReady] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const uploadRequest = useRef<AbortController | null>(null);
  const generationIntents = useRef(new GenerationIntents(user.id));
  const mainAudio = useRef<LogicalPlayer | null>(null);
  const mediaA = useRef<HTMLAudioElement>(null);
  const mediaB = useRef<HTMLAudioElement>(null);
  const [playerState, setPlayerState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [playerError, setPlayerError] = useState("");
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const playerEvents = useRef<(event: PlayerEvent) => void>(() => {});
  useEffect(() => {
    const player = new LogicalPlayer(
      [mediaA.current!, mediaB.current!],
      (event) => playerEvents.current(event),
    );
    mainAudio.current = player;
    return () => {
      player.dispose();
      mainAudio.current = null;
    };
  }, []);
  const memoElements = useRef(new Map<string, HTMLAudioElement>());
  const playerPanel = useRef<HTMLElement>(null);
  const activeMemo = useRef<HTMLAudioElement | null>(null);
  const controller = useRef<CaptureController | null>(null);
  const pendingMap = useRef(new Map<string, PendingMemo>());
  const durableRef = useRef(new Set<string>());
  const pendingSeek = useRef<number | null>(null);
  const alive = useRef(true);
  const workspaceSession = useRef(new AbortController());
  const documentRequest = useRef(0);
  const selectedLive = useRef({
    documentId: selected?.id,
    versionId: selected?.current_version.id,
    tab,
  });
  selectedLive.current = {
    documentId: selected?.id,
    versionId: selected?.current_version.id,
    tab,
  };
  const busy = captureState !== "idle";
  const controlsLocked = busy || mutating || microphoneChecking;
  const resourcesLocked = controlsLocked || needsLogin;
  const activeMemoDocument = memos.some(
    (memo) => memo.document.id === memoDocument,
  )
    ? memoDocument
    : "";
  const audio = selected?.audio_versions.find((item) => item.id === audioId);
  playerEvents.current = (event) => {
    if (event.audioId !== selectedAudioId.current || !alive.current) return;
    const player = mainAudio.current!;
    if (event.type === "loading") setPlayerState("loading");
    if (event.type === "loadedmetadata") {
      setPlayerState("ready");
      setPlayerError("");
      if (pendingSeek.current !== null) {
        const target = pendingSeek.current;
        pendingSeek.current = null;
        player.currentTime = target / 1000;
      }
      updatePlayback();
    }
    if (event.type === "timeupdate" || event.type === "seeked")
      updatePlayback();
    if (event.type === "seeked" && progressTracker.current?.ready)
      progressTracker.current.observe(player.currentTime * 1000, true);
    if (event.type === "play") {
      if (
        controller.current?.state !== "idle" ||
        !progressTracker.current?.ready
      ) {
        player.pause();
        return;
      }
      pauseMemos();
      setPlaying(true);
    }
    if (event.type === "pause") {
      setPlaying(false);
      queueProgress();
    }
    if (event.type === "ended") {
      setPlaying(false);
      updatePlayback();
      progressTracker.current?.observe(player.duration * 1000, true);
    }
    if (event.type === "error") {
      setPlayerState("error");
      setPlayerError("音声の区間を読み込めません。位置は保持しています。");
    }
    if (event.type === "blocked") {
      setPlaying(false);
      setStatus("区間の続きは、再生ボタンを押して再開してください。");
    }
    if (event.type === "transition")
      window.dispatchEvent(
        new CustomEvent("lc-playback-transition", { detail: event }),
      );
  };
  useEffect(() => {
    const player = mainAudio.current!;
    const controller = new AbortController();
    player.setPlaylist(null);
    setPlayerError("");
    setPlayerState("loading");
    if (!audio) return () => controller.abort();
    if (audio.delivery !== "playlist" && audio.media_url) {
      player.setPlaylist({
        audio_version: audio.id,
        document_version: audio.document_version,
        delivery: "single",
        duration_ms: audio.duration_ms,
        segments: [
          {
            index: 0,
            start_ms: 0,
            end_ms: audio.duration_ms,
            duration_ms: audio.duration_ms,
            media_url: audio.media_url,
            content_type: "audio/mpeg",
            size_bytes: 1,
          },
        ],
      });
    } else
      void loadPlaylist(audio.id, audio.document_version, controller.signal)
        .then((manifest) => {
          if (
            !controller.signal.aborted &&
            selectedAudioId.current === audio.id
          )
            player.setPlaylist(manifest);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setPlayerState("error");
            setPlayerError(
              "音声の構成を読み込めません。ログイン状態と接続を確認してください。",
            );
          }
        });
    return () => controller.abort();
  }, [audioId, manifestAttempt]);
  const activeMapping = mapping?.audio_version === audioId ? mapping : null;
  const activeSegment = activeMapping
    ? segmentAt(position, activeMapping.segments)
    : undefined;
  useEffect(() => {
    if (!audioId) return;
    const controller = new AbortController();
    setMappingError("");
    void narrationApi
      .mapping(audioId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && value.audio_version === audioId)
          setMapping(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setMappingError("音声の区間を読み込めません。");
      });
    return () => controller.abort();
  }, [audioId, mappingAttempt]);
  useEffect(() => {
    if (mainAudio.current) mainAudio.current.playbackRate = rate;
  }, [rate, audioId]);
  const currentAudio =
    audio && audio.document_version === selected?.current_version.id;
  const progressReady =
    progressTracker.current?.audioId === audioId &&
    progressTracker.current.ready;
  function queueProgress() {
    const element = mainAudio.current;
    if (element && element.readyState >= 1)
      progressTracker.current?.observe(
        Math.min(
          Math.round(element.currentTime * 1000),
          audio?.duration_ms ?? Infinity,
        ),
        true,
      );
  }
  async function restoreProgress(tracker: ProgressTracker) {
    const saved = await tracker.load();
    if (
      !saved ||
      progressTracker.current !== tracker ||
      !alive.current ||
      selectedAudioId.current !== tracker.audioId
    )
      return;
    const target = seekIntent.current ?? saved.position_ms;
    const element = mainAudio.current!;
    if (element.readyState >= 1) {
      element.currentTime = Math.min(
        target / 1000,
        element.duration || Infinity,
      );
      pendingSeek.current = null;
      setPosition(Math.round(element.currentTime * 1000));
    } else pendingSeek.current = target;
  }
  useEffect(() => {
    if (!audioId) return;
    const tracker = new ProgressTracker(audioId, api, (state) => {
      if (alive.current && progressTracker.current === tracker) {
        setProgressState(state);
        if (state === "conflict") mainAudio.current?.pause();
      }
    });
    progressTracker.current = tracker;
    progressTrackers.current.add(tracker);
    void restoreProgress(tracker);
    const flush = () => {
      if (
        tracker.ready &&
        tracker.state !== "error" &&
        tracker.state !== "conflict"
      ) {
        tracker.observe(
          Math.min(
            mainAudio.current!.currentTime * 1000,
            audio?.duration_ms ?? Infinity,
          ),
          true,
        );
      }
    };
    const hide = () => {
      if (document.hidden) flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hide);
    return () => {
      // choose() explicitly queues the old position before changing source.
      const saved =
        tracker.state !== "error" ? tracker.flush() : Promise.resolve();
      void saved.then(() => {
        if (
          alive.current &&
          tracker.state === "error" &&
          tracker.hasPendingWrite &&
          !deletedAudioIds.current.has(audioId)
        )
          setProgressRecovery((items) => [
            ...items.filter((item) => item.id !== audioId),
            { id: audioId, title: selected?.title ?? "前の資料", tracker },
          ]);
        else progressTrackers.current.delete(tracker);
      });
      tracker.dispose();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [audioId]);
  function pauseMemos() {
    memoElements.current.forEach((element) => element.pause());
    activeMemo.current = null;
  }
  function playMemo(element: HTMLAudioElement) {
    if (controller.current?.state !== "idle") {
      element.pause();
      return;
    }
    mainAudio.current?.pause();
    memoElements.current.forEach((other) => {
      if (other !== element) other.pause();
    });
    activeMemo.current = element;
  }
  function registerMemo(key: string, element: HTMLAudioElement | null) {
    const previous = memoElements.current.get(key);
    if (previous !== element && activeMemo.current === previous)
      activeMemo.current = null;
    if (element) memoElements.current.set(key, element);
    else memoElements.current.delete(key);
  }
  function updatePending() {
    if (alive.current) {
      setPending([...pendingMap.current.values()]);
      setDurable(new Set(durableRef.current));
    }
  }
  async function sendPending(memo: PendingMemo): Promise<boolean> {
    if (!alive.current) return false;
    assertOutboxOwner(memo, user.id);
    if (uploadRequest.current) return false;
    // Reserve the single-flight slot before awaiting the account check. Both
    // an initial recording and an explicit retry must pass this same boundary.
    const controller = new AbortController();
    uploadRequest.current = controller;
    setUploading(memo.clientId);
    let uploadStarted = false;
    try {
      if (!(await confirmOriginalAccount(controller.signal))) return false;
      if (!alive.current || controller.signal.aborted) return false;
      // The session can still change after this check. Backend parent-owner
      // authorization remains the final boundary; this is not an atomic lock.
      uploadStarted = true;
      const saved = await api.upload(memo, controller.signal);
      // A server acknowledgment, not a successful local write, unlocks review.
      if (alive.current) {
        setRecentMemo(saved);
        libraryRevision.current.memos++;
        setMemos((items) =>
          items.some((item) => item.id === saved.id)
            ? items.map((item) => (item.id === saved.id ? saved : item))
            : [saved, ...items],
        );
      }
    } catch (error) {
      if (alive.current && error instanceof ApiError && error.status === 403)
        setNeedsLogin(true);
      if (alive.current)
        setStatus(
          `${!uploadStarted ? "アカウントを確認できなかったため、録音は送信していません。" : controller.signal.aborted ? "送信を中止しました。サーバー側の保存状態は未確認です。同じ録音を再送して確認できます。" : message(error)} 録音は${durableRef.current.has(memo.clientId) ? "端末内に保存済みです。再送してください。" : "このタブ内だけに残っています。ダウンロードして保管してください。"}`,
        );
      return false;
    } finally {
      if (uploadRequest.current === controller) uploadRequest.current = null;
      if (alive.current) setUploading(null);
    }
    // Once the API confirms, this is saved even if local cleanup fails.
    pendingMap.current.delete(memo.clientId);
    durableRef.current.delete(memo.clientId);
    updatePending();
    let cleanupFailed = false;
    try {
      await outbox.remove(user.id, memo.clientId);
    } catch {
      cleanupFailed = true;
    }
    if (alive.current)
      setStatus(
        cleanupFailed
          ? "サーバーに保存済みです。端末側の再送記録を削除できませんでした。再送しても二重保存されません。"
          : "録音をサーバーに保存しました。",
      );
    return true;
  }
  async function complete(memo: PendingMemo): Promise<boolean> {
    pendingMap.current.set(memo.clientId, memo);
    updatePending();
    try {
      await outbox.put(memo);
      durableRef.current.add(memo.clientId);
      updatePending();
    } catch {
      if (alive.current)
        setStatus(
          "端末への一時保存ができません。このタブを閉じずに、サーバーへの保存をお待ちください。",
        );
    }
    return sendPending(memo);
  }
  const callbacks = useRef({ complete, pauseMemos });
  callbacks.current = { complete, pauseMemos };
  async function refreshLibrary() {
    const request = ++libraryRequest.current;
    const revision = { ...libraryRevision.current };
    setLoading(true);
    const [docs, items] = await Promise.allSettled([
      api.documents(user.id),
      api.memos(user.id),
    ]);
    if (!alive.current || request !== libraryRequest.current) return;
    for (const result of [docs, items]) {
      if (
        result.status === "rejected" &&
        result.reason instanceof ApiError &&
        (result.reason.status === 403 ||
          (result.reason.data as { code?: string } | null)?.code ===
            "workspace_changed")
      )
        setNeedsLogin(true);
    }
    if (docs.status === "fulfilled") {
      setDocuments((current) =>
        revision.documents === libraryRevision.current.documents
          ? docs.value.filter((doc) => !deletedDocuments.current.has(doc.id))
          : mergeSnapshot(docs.value, current, deletedDocuments.current),
      );
    }
    if (items.status === "fulfilled") {
      setMemos((current) =>
        revision.memos === libraryRevision.current.memos
          ? items.value.filter(
              (memo) =>
                !deletedMemos.current.has(memo.id) &&
                !deletedDocuments.current.has(memo.document.id),
            )
          : mergeSnapshot(
              items.value.filter(
                (memo) => !deletedDocuments.current.has(memo.document.id),
              ),
              current,
              deletedMemos.current,
            ),
      );
    }
    setLibraryErrors([
      ...(docs.status === "rejected" ? ["資料一覧"] : []),
      ...(items.status === "rejected" ? ["声のメモ一覧"] : []),
    ]);
    setLoading(false);
  }
  useEffect(() => {
    alive.current = true;
    // Each setup owns a fresh lifetime, including StrictMode's second setup.
    const sessionLifetime = new AbortController();
    workspaceSession.current = sessionLifetime;
    const player = mainAudio.current!;
    controller.current = new CaptureController(player, {
      state: setCaptureState,
      status: setStatus,
      elapsed: setElapsed,
      pauseMemos: () => callbacks.current.pauseMemos(),
      complete: (memo) => callbacks.current.complete(memo),
      input: setMicrophoneLabel,
      level: setMicrophoneLevel,
    });
    const interrupt = () => {
      if (document.hidden) controller.current?.interrupt();
    };
    const pagehide = () => controller.current?.interrupt();
    const leaving = (event: BeforeUnloadEvent) => {
      if (
        controller.current?.state !== "idle" ||
        pendingMap.current.size ||
        memoDraftsRef.current.size ||
        savingMemosRef.current.size ||
        [...progressTrackers.current].some(
          (tracker) => tracker.state === "error" && tracker.hasPendingWrite,
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", interrupt);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("beforeunload", leaving);
    void refreshLibrary();
    void outbox
      .list(user.id)
      .then((items) => {
        for (const item of items) {
          pendingMap.current.set(item.clientId, item);
          durableRef.current.add(item.clientId);
        }
        updatePending();
      })
      .catch(() =>
        setStatus(
          "端末内の一時保存が使えません。保存失敗時は録音をダウンロードし、このタブを閉じないでください。",
        ),
      )
      .finally(() => {
        if (alive.current) setOutboxReady(true);
      });
    return () => {
      alive.current = false;
      sessionLifetime.abort();
      libraryRequest.current++;
      uploadRequest.current?.abort();
      controller.current?.dispose();
      pauseMemos();
      document.removeEventListener("visibilitychange", interrupt);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("beforeunload", leaving);
    };
  }, [user.id]);
  useEffect(() => {
    const platform = navigator.mediaSession;
    if (!platform) return;
    const target = () => activeMemo.current ?? mainAudio.current;
    const seek = (value: number, relative: boolean) => {
      if (
        controller.current?.state !== "idle" ||
        !Number.isFinite(value) ||
        (!activeMemo.current && !progressTracker.current?.ready)
      )
        return;
      const element = target();
      if (!element || element.readyState < 1) return;
      element.currentTime = Math.max(
        0,
        Math.min(
          Number.isFinite(element.duration) ? element.duration : Infinity,
          (relative ? element.currentTime : 0) + value,
        ),
      );
    };
    const handlers: Partial<
      Record<MediaSessionAction, MediaSessionActionHandler>
    > = {
      play: () => {
        if (
          controller.current?.state !== "idle" ||
          (!activeMemo.current && !progressTracker.current?.ready)
        )
          return;
        if (activeMemo.current)
          void activeMemo.current
            .play()
            .catch(() => setStatus("録音の再生ボタンをタップしてください。"));
        else void controller.current.play();
      },
      pause: () => target()?.pause(),
      seekbackward: (details) => seek(-(details.seekOffset || 10), true),
      seekforward: (details) => seek(details.seekOffset || 10, true),
      seekto: (details) => seek(details.seekTime ?? 0, false),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        platform.setActionHandler(action as MediaSessionAction, handler);
      } catch {
        /* platform optional */
      }
    }
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          platform.setActionHandler(action as MediaSessionAction, null);
        } catch {
          /* platform optional */
        }
      }
    };
  }, []);
  useEffect(() => {
    if (!("mediaSession" in navigator) || !selected) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: selected.title,
        artist: "Listen / Capture",
      });
    } catch {
      /* optional */
    }
  }, [selected]);
  useEffect(() => {
    if (
      selected &&
      tab === "listen" &&
      window.matchMedia("(max-width:760px)").matches
    ) {
      playerPanel.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion:reduce)").matches
          ? "auto"
          : "smooth",
      });
    }
  }, [selected?.id, audioId, tab]);
  function choose(
    document: Document,
    sourceAudioId?: string,
    offset?: number,
    imported = false,
  ) {
    if ((!imported && controlsLocked) || controller.current?.state !== "idle")
      return;
    const nextAudioId =
      sourceAudioId ??
      document.audio_versions.find(
        (item) => item.document_version === document.current_version.id,
      )?.id ??
      "";
    const reuseLoadedAudio = Boolean(
      nextAudioId &&
      nextAudioId === audioId &&
      mainAudio.current &&
      mainAudio.current.readyState >= 1,
    );
    queueProgress();
    controller.current?.invalidatePlayback();
    pauseMemos();
    setPlaying(false);
    setPosition(0);
    setDuration(
      reuseLoadedAudio && Number.isFinite(mainAudio.current!.duration)
        ? Math.round(mainAudio.current!.duration * 1000)
        : 0,
    );
    seekIntent.current = offset;
    selectedAudioId.current = nextAudioId;
    pendingSeek.current = offset ?? null;
    setSelected(document);
    setAudioId(nextAudioId);
    setTab("listen");
    setShowCreate(false);
    setStatus(
      offset !== undefined
        ? "元の位置を開きました。再生ボタンで続きから聴けます。"
        : "",
    );
    if (reuseLoadedAudio) {
      const target =
        offset ?? Math.round(mainAudio.current!.currentTime * 1000);
      mainAudio.current!.currentTime = target / 1000;
      pendingSeek.current = null;
      setPosition(target);
      progressTracker.current?.observe(target, true);
    }
  }
  function applyGenerated(
    document: Document,
    job: { document_version: string; audio_version: string | null },
  ) {
    const current = selectedLive.current;
    if (
      !alive.current ||
      !canApplyGeneration(
        document.id,
        job.document_version,
        current.documentId,
        current.versionId,
        controller.current?.state,
        current.tab,
      )
    )
      return;
    const generated = document.audio_versions.find(
      (item) =>
        item.id === job.audio_version &&
        item.document_version === job.document_version,
    );
    if (!generated || document.current_version.id !== job.document_version) {
      setStatus("生成済み音声を確認できません。資料を選び直してください。");
      return;
    }
    // The server may legitimately reuse a succeeded job for the same profile.
    // That AudioVersion is already loaded: do not zero a clock whose audioId
    // will not change (and therefore will not receive a new metadata event).
    if (selectedAudioId.current === generated.id) {
      libraryRevision.current.documents++;
      setDocuments((items) =>
        items.map((item) => (item.id === document.id ? document : item)),
      );
      setSelected(document);
      setStatus(
        generated.kind === "fixture"
          ? "テスト用無音音声を用意しました。本文の合成音声ではありません。"
          : "音声を用意しました。『再生』を押すと聴けます。",
      );
      return;
    }
    queueProgress();
    controller.current?.invalidatePlayback();
    pauseMemos();
    pendingSeek.current = null;
    seekIntent.current = undefined;
    selectedAudioId.current = generated.id;
    libraryRevision.current.documents++;
    setDocuments((items) =>
      items.map((item) => (item.id === document.id ? document : item)),
    );
    setSelected(document);
    setAudioId(generated.id);
    setPosition(0);
    setDuration(0);
    setPlaying(false);
    setStatus(
      generated.kind === "fixture"
        ? "テスト用無音音声を用意しました。本文の合成音声ではありません。"
        : "音声を用意しました。『再生』を押すと聴けます。",
    );
  }
  async function demo() {
    if (resourcesLocked) return;
    setMutating(true);
    try {
      if (!(await confirmOriginalAccount())) return;
      const doc = await api.demo(user.id);
      if (!alive.current) return;
      libraryRevision.current.documents++;
      setDocuments((items) => [
        doc,
        ...items.filter((item) => item.id !== doc.id),
      ]);
      setMutating(false);
      choose(doc);
    } catch (error) {
      reportWorkspaceError(error);
    } finally {
      setMutating(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resourcesLocked) return;
    const data = new FormData(event.currentTarget);
    setMutating(true);
    try {
      if (!(await confirmOriginalAccount())) return;
      const doc = await api.createDocument(
        String(data.get("title")),
        String(data.get("text")),
        user.id,
      );
      if (!alive.current) return;
      libraryRevision.current.documents++;
      setDocuments((items) => [doc, ...items]);
      setMutating(false);
      choose(doc);
      setStatus("資料を保存しました。この資料の音声はまだ生成されていません。");
    } catch (error) {
      reportWorkspaceError(error);
    } finally {
      setMutating(false);
    }
  }
  async function logout() {
    if (controlsLocked) return;
    if (savingMemosRef.current.size) {
      setStatus(
        "補足の保存結果を確認中です。完了してからログアウトしてください。",
      );
      return;
    }
    if (
      (memoDraftsRef.current.size || importDirty) &&
      !window.confirm(
        importDirty
          ? "未保存の資料入力があります。補足の下書きも含めて破棄し、ログアウトしますか？"
          : "未保存の補足があります。ログアウトすると失われます。破棄してログアウトしますか？",
      )
    )
      return;
    if (
      [...pendingMap.current.keys()].some((id) => !durableRef.current.has(id))
    ) {
      setStatus(
        "このタブ内だけに残っている録音があります。ログアウトの前に再送するか、ダウンロードしてください。",
      );
      return;
    }
    if (
      pendingMap.current.size &&
      !window.confirm(
        "端末内に未送信の録音があります。同じアカウントで再ログインすると再送できます。ログアウトしますか？",
      )
    )
      return;
    setMutating(true);
    queueProgress();
    controller.current?.invalidatePlayback();
    pauseMemos();
    try {
      await Promise.all(
        [...progressTrackers.current].map((tracker) => tracker.flush()),
      );
      if (
        [...progressTrackers.current].some(
          (tracker) => tracker.state === "error" && tracker.hasPendingWrite,
        ) &&
        !window.confirm(
          "再生位置を保存できませんでした。前回保存した位置からの再開になります。ログアウトしますか？",
        )
      )
        return;
      await api.logout();
      try {
        await draftNotes.clear();
      } catch {
        window.alert(
          "ログアウトしましたが、端末の補足下書きを削除できませんでした。共有端末では、このサイトの保存データを消去してください。",
        );
      }
      onLogout();
    } catch (error) {
      setStatus(message(error));
    } finally {
      setMutating(false);
    }
  }
  async function returnToMemo(memo: Memo) {
    if (controlsLocked || controller.current?.state !== "idle") return;
    const operation = ++documentRequest.current;
    setMutating(true);
    try {
      const doc = await api.document(memo.document.id);
      if (
        !alive.current ||
        operation !== documentRequest.current ||
        controller.current?.state !== "idle"
      )
        return;
      choose(doc, memo.audio_version, memo.position_ms);
      setSourceFocus((n) => n + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus(message(error));
    } finally {
      setMutating(false);
    }
  }
  async function discardPending(memo: PendingMemo) {
    if (controlsLocked) return;
    assertOutboxOwner(memo, user.id);
    if (
      !window.confirm(
        "この端末の録音を破棄しますか？サーバー側の保存状態は未確認です。必要なら先にダウンロードしてください。",
      )
    )
      return;
    setMutating(true);
    try {
      if (durableRef.current.has(memo.clientId))
        await outbox.remove(user.id, memo.clientId);
      pendingMap.current.delete(memo.clientId);
      durableRef.current.delete(memo.clientId);
      updatePending();
      setStatus("この端末の未送信録音を破棄しました。");
    } catch {
      setStatus(
        "端末内の録音を削除できませんでした。録音は再送欄に残しています。",
      );
    } finally {
      setMutating(false);
    }
  }
  async function retry(memo: PendingMemo) {
    if (controlsLocked) return;
    setMutating(true);
    try {
      assertOutboxOwner(memo, user.id);
      if (!durableRef.current.has(memo.clientId)) {
        try {
          await outbox.put(memo);
          durableRef.current.add(memo.clientId);
          updatePending();
        } catch {
          /* in-memory rescue remains */
        }
      }
      await sendPending(memo);
    } catch (error) {
      setStatus(`${message(error)} 録音は再送欄に残しています。`);
    } finally {
      setMutating(false);
    }
  }
  async function confirmOriginalAccount(
    signal = workspaceSession.current.signal,
  ) {
    if (!alive.current || signal.aborted) return false;
    const account = await session(signal);
    if (!alive.current || signal.aborted) return false;
    const matches = account.user?.id === user.id;
    setNeedsLogin(!matches);
    if (!matches)
      setStatus(
        "元のアカウントでログインし直してください。録音と未保存の補足はこの画面に残しています。",
      );
    return matches;
  }
  function reportWorkspaceError(error: unknown) {
    if (!alive.current) return;
    if (
      error instanceof ApiError &&
      (error.status === 403 ||
        (error.data as { code?: string } | null)?.code === "workspace_changed")
    )
      setNeedsLogin(true);
    setStatus(message(error));
  }
  async function saveMemoText(memo: Memo) {
    if (controlsLocked || savingMemosRef.current.has(memo.id)) return;
    const submittedText = memoDraftsRef.current.get(memo.id) ?? memo.text;
    savingMemosRef.current.add(memo.id);
    setSavingMemos(new Set(savingMemosRef.current));
    try {
      if (!(await confirmOriginalAccount())) return;
      const next = await api.updateMemo(memo.id, submittedText);
      if (!alive.current) return;
      libraryRevision.current.memos++;
      setMemos((items) =>
        items.map((item) => (item.id === next.id ? next : item)),
      );
      const cleaned = await draftNotes.acknowledge(next.id, submittedText);
      if (!alive.current) return;
      setStatus(
        !cleaned
          ? "送信した補足はサーバーに保存済みです。端末の下書き記録を整理できませんでした。新しい編集があれば、この画面に残しています。"
          : memoDraftsRef.current.has(next.id)
            ? "送信した補足を保存しました。新しい編集は未保存です。"
            : "文章メモを保存しました。",
      );
    } catch (error) {
      if (alive.current && error instanceof ApiError && error.status === 403)
        setNeedsLogin(true);
      if (alive.current)
        setStatus(
          error instanceof ApiError && error.status === 0
            ? "補足の保存結果を確認できませんでした。補足はこの画面内に残しています。「文章を保存」で再送してください。"
            : `${message(error)} 補足はこの画面内に残っています。`,
        );
    } finally {
      savingMemosRef.current.delete(memo.id);
      if (alive.current) setSavingMemos(new Set(savingMemosRef.current));
    }
  }
  function updatePlayback() {
    const element = mainAudio.current!;
    if (element.readyState >= 1 && pendingSeek.current === null)
      progressTracker.current?.observe(
        Math.min(
          Math.round(element.currentTime * 1000),
          audio?.duration_ms ?? Infinity,
        ),
      );
    setPosition(Math.round(element.currentTime * 1000));
    setDuration(
      Number.isFinite(element.duration)
        ? Math.round(element.duration * 1000)
        : (audio?.duration_ms ?? 0),
    );
    if (
      navigator.mediaSession &&
      !activeMemo.current &&
      Number.isFinite(element.duration) &&
      element.duration > 0
    ) {
      try {
        navigator.mediaSession.setPositionState({
          duration: element.duration,
          playbackRate: element.playbackRate,
          position: Math.min(element.currentTime, element.duration),
        });
      } catch {
        /* optional */
      }
    }
  }
  async function removeDocument() {
    if (!selected || resourcesLocked) return;
    if (
      [...pendingMap.current.values()].some(
        (memo) => memo.documentId === selected.id,
      )
    ) {
      setStatus("この資料に未送信の録音があります。先に再送してください。");
      return;
    }
    if (!window.confirm("資料と、この資料に紐づく録音をすべて削除しますか？"))
      return;
    setMutating(true);
    try {
      await api.deleteDocument(selected.id);
      deletedDocuments.current.add(selected.id);
      libraryRevision.current.documents++;
      libraryRevision.current.memos++;
      const removed = new Set(selected.audio_versions.map((item) => item.id));
      removed.forEach((id) => deletedAudioIds.current.add(id));
      for (const tracker of progressTrackers.current) {
        if (removed.has(tracker.audioId)) {
          tracker.retire();
          progressTrackers.current.delete(tracker);
        }
      }
      setProgressRecovery((items) =>
        items.filter((item) => !removed.has(item.id)),
      );
      controller.current?.invalidatePlayback();
      pauseMemos();
      setDocuments((items) => items.filter((item) => item.id !== selected.id));
      setMemos((items) =>
        items.filter((item) => item.document.id !== selected.id),
      );
      for (const memo of memos) {
        if (memo.document.id === selected.id) void draftNotes.drop(memo.id);
      }
      if (memoDocument === selected.id) setMemoDocument("");
      setSelected(null);
      selectedAudioId.current = "";
      setAudioId("");
      setStatus("資料を削除しました。");
    } catch (error) {
      setStatus(message(error));
    } finally {
      setMutating(false);
    }
  }
  return (
    <main>
      {editing && selected && (
        <DocumentEditor
          document={selected}
          userId={user.id}
          verifyAccount={confirmOriginalAccount}
          onClose={() => setEditing(false)}
          onLatest={(latest) => {
            libraryRevision.current.documents++;
            setDocuments((items) =>
              items.map((item) => (item.id === latest.id ? latest : item)),
            );
            setSelected(latest);
          }}
          onSaved={(saved) => {
            libraryRevision.current.documents++;
            setDocuments((items) =>
              items.map((item) => (item.id === saved.id ? saved : item)),
            );
            setSelected(saved);
            setMemos((items) =>
              items.map((memo) =>
                memo.document.id === saved.id
                  ? {
                      ...memo,
                      document: { ...memo.document, title: saved.title },
                    }
                  : memo,
              ),
            );
            setEditing(false);
            setStatus(
              saved.current_version.id !== selected.current_version.id
                ? "本文を保存しました。これまでの音声と録音は修正前の本文に対応します。"
                : "タイトルを保存しました。",
            );
          }}
        />
      )}
      <audio ref={mediaA} preload="metadata" />
      <audio ref={mediaB} preload="none" />
      <div className="account-row">
        <span>{user.username} さんのライブラリ</span>
        <button
          className="text-button"
          onClick={() => void logout()}
          disabled={controlsLocked}
        >
          <Icon name="logout" size={16} /> ログアウト
        </button>
      </div>
      <h1
        className={
          tab === "listen" && selected ? "visually-hidden" : "workspace-title"
        }
      >
        {tab === "memos"
          ? "声のメモ"
          : tab === "help"
            ? "使い方"
            : "ライブラリ"}
      </h1>
      {!showCreate && (
        <nav className="tabs" aria-label="メインナビゲーション">
          <button
            className={tab === "listen" ? "active" : ""}
            aria-current={tab === "listen" ? "page" : undefined}
            disabled={controlsLocked}
            onClick={() => {
              pauseMemos();
              setTab("listen");
            }}
          >
            <Icon name="headphones" /> 聴く
          </button>
          <button
            className={tab === "memos" ? "active" : ""}
            aria-current={tab === "memos" ? "page" : undefined}
            disabled={controlsLocked}
            onClick={() => {
              controller.current?.invalidatePlayback();
              pauseMemos();
              setTab("memos");
            }}
          >
            <Icon name="note" /> 声のメモ <span>{memos.length}</span>
          </button>
          <button
            className={tab === "help" ? "active" : ""}
            aria-current={tab === "help" ? "page" : undefined}
            disabled={controlsLocked}
            onClick={() => {
              queueProgress();
              controller.current?.invalidatePlayback();
              pauseMemos();
              setTab("help");
            }}
          >
            <Icon name="help" /> 使い方
          </button>
        </nav>
      )}
      <p
        className={status ? "notice" : "visually-hidden"}
        role="status"
        aria-live="polite"
        data-testid="status"
      >
        {status}
      </p>
      {libraryErrors.length > 0 && (
        <div className="notice warning" role="alert">
          {libraryErrors.join("・")}
          を読み込めませんでした。接続とログイン状態を確認してください。保存済みの録音は削除されません。
          <button
            className="text-button"
            disabled={controlsLocked || loading}
            onClick={() => void refreshLibrary()}
          >
            一覧を再読込
          </button>
        </div>
      )}
      {progressRecovery.map((item) => (
        <div
          className="notice warning"
          key={item.id}
          role="alert"
          data-testid="progress-recovery"
        >
          「{item.title}
          」の再生位置を保存できませんでした。このタブを閉じると未保存の位置は失われます。
          <button
            className="text-button"
            disabled={controlsLocked}
            onClick={async () => {
              await item.tracker.retry();
              if (
                item.tracker.state === "saved" ||
                item.tracker.state === "conflict"
              ) {
                progressTrackers.current.delete(item.tracker);
                setProgressRecovery((items) =>
                  items.filter((value) => value.id !== item.id),
                );
                setStatus(
                  item.tracker.state === "conflict"
                    ? "別の画面の保存位置を優先しました。資料を開き直すと確認できます。"
                    : "前の資料の再生位置を保存しました。",
                );
              }
            }}
          >
            再生位置を再送
          </button>
        </div>
      ))}
      {uploading && (
        <div
          className="notice upload-notice"
          role="status"
          data-testid="upload-status"
        >
          <p>
            録音をサーバーへ送信中です。低速な接続では時間がかかります。最大3分で確認を打ち切り、録音を残します。
          </p>
          <button
            className="soft"
            data-testid="upload-cancel"
            onClick={() => uploadRequest.current?.abort()}
          >
            送信を中断
          </button>
        </div>
      )}
      {needsLogin && (
        <aside className="notice warning" role="alert">
          <h2>元のアカウントでログインし直してください</h2>
          <p>
            このタブを残したまま、別タブでログインしてください。別のアカウントでログイン中なら、そちらでログアウトしてから切り替えます。戻って、録音は「保存を再試行」、補足は「文章を保存」を押してください。
          </p>
          <a
            href="/"
            target="_blank"
            rel="noopener"
            className="soft button-link"
          >
            別タブでログイン
          </a>
          <button
            className="soft"
            disabled={controlsLocked}
            onClick={() =>
              void confirmOriginalAccount()
                .then((valid) => {
                  if (valid)
                    setStatus(
                      "元のアカウントを確認しました。操作を再開できます。",
                    );
                })
                .catch((error) => setStatus(message(error)))
            }
          >
            ログイン状態を再確認
          </button>
        </aside>
      )}
      {pending.length > 0 && (
        <section className="recovery panel" aria-labelledby="pending-heading">
          <h2 id="pending-heading">サーバー保存を確認できていない録音</h2>
          <p>
            端末の保存領域は消去されることがあります。再送するか、録音をダウンロードしてください。
          </p>
          {pending.map((memo) => (
            <PendingCard
              key={memo.clientId}
              memo={memo}
              durable={durable.has(memo.clientId)}
              disabled={controlsLocked}
              onRetry={() => void retry(memo)}
              onDiscard={() => void discardPending(memo)}
              register={(element) =>
                registerMemo(`pending:${memo.clientId}`, element)
              }
              onPlay={playMemo}
              onStatus={setStatus}
            />
          ))}
        </section>
      )}
      {showCreate ? (
        <ImportDocument
          userId={user.id}
          disabled={resourcesLocked}
          onBusyChange={setMutating}
          onDirtyChange={setImportDirty}
          onSubmit={create}
          onClose={() => setShowCreate(false)}
          onImported={(doc) => {
            libraryRevision.current.documents++;
            setDocuments((items) => [
              doc,
              ...items.filter((item) => item.id !== doc.id),
            ]);
            setMutating(false);
            choose(doc, undefined, undefined, true);
            setStatus("確認した本文を保存しました。");
          }}
        />
      ) : tab === "help" ? (
        <HelpPanel />
      ) : tab === "listen" ? (
        <div className="listen-layout">
          <section
            className="library panel"
            aria-labelledby="library-heading"
            aria-busy={loading}
          >
            <div className="section-title">
              <h2 id="library-heading">あなたの資料</h2>
              <button
                className="text-button"
                aria-label="＋ 資料を追加"
                disabled={resourcesLocked}
                onClick={() => {
                  queueProgress();
                  controller.current?.invalidatePlayback();
                  pauseMemos();
                  setShowCreate(true);
                }}
              >
                <Icon name="plus" size={16} /> 資料を追加
              </button>
            </div>
            {loading && documents.length === 0 ? (
              <p className="empty" data-testid="library-loading">
                資料を読み込んでいます…
              </p>
            ) : documents.length === 0 ? (
              <p className="empty">
                {libraryErrors.includes("資料一覧") ? (
                  "資料一覧はまだ確認できていません。上の案内から再読込できます。"
                ) : (
                  <>
                    まだ資料がありません。
                    <br />
                    まずはデモで、聴く・残すを試せます。
                  </>
                )}
              </p>
            ) : (
              <ul className="document-list">
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <button
                      className={
                        selected?.id === doc.id
                          ? "document-choice selected"
                          : "document-choice"
                      }
                      disabled={controlsLocked}
                      aria-current={
                        selected?.id === doc.id ? "true" : undefined
                      }
                      onClick={() => choose(doc)}
                    >
                      <span className="document-icon" aria-hidden="true">
                        <Icon name="book" />
                      </span>
                      <span>
                        <strong>{doc.title}</strong>
                        <small>
                          {doc.audio_versions.some(
                            (audio) =>
                              audio.document_version === doc.current_version.id,
                          )
                            ? "音声あり"
                            : "テキストのみ"}{" "}
                          · {dateLabel(doc.updated_at)}
                        </small>
                      </span>
                      <span className="chevron" aria-hidden="true">
                        <Icon name="chevronRight" size={16} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              className="demo-button"
              disabled={resourcesLocked}
              onClick={() => void demo()}
            >
              <Icon name="play" size={16} /> デモ音声で試す
              <small>確認音・2分（読み上げではありません）</small>
            </button>
          </section>
          <section
            ref={playerPanel}
            className="player panel"
            aria-labelledby="player-heading"
          >
            <div className="player-heading">
              <h2 id="player-heading" tabIndex={-1}>
                {selected?.title ?? "資料を選択"}
              </h2>
              {selected && (
                <div className="player-actions">
                  {currentAudio && audio && (
                    <VoiceSettings
                      key={`${user.id}:${selected.id}:${selected.current_version.id}`}
                      disabled={resourcesLocked}
                      onOpen={() => {
                        queueProgress();
                        controller.current?.invalidatePlayback();
                        pauseMemos();
                      }}
                    >
                      <NarrationPanel
                        document={selected}
                        userId={user.id}
                        disabled={resourcesLocked}
                        allowNewVoice
                        activeAudioId={audio.id}
                        onReady={applyGenerated}
                        legacy={null}
                      />
                    </VoiceSettings>
                  )}
                  <button
                    className="text-button"
                    disabled={resourcesLocked}
                    onClick={() => {
                      queueProgress();
                      controller.current?.invalidatePlayback();
                      pauseMemos();
                      setEditing(true);
                    }}
                  >
                    <Icon name="edit" size={16} /> 修正
                  </button>
                </div>
              )}
            </div>
            {!selected ? (
              <div className="player-empty">
                <Icon name="headphones" size={36} />
              </div>
            ) : !audio ? (
              <div className="no-audio">
                <NarrationPanel
                  key={selected.current_version.id}
                  document={selected}
                  userId={user.id}
                  disabled={resourcesLocked}
                  onReady={applyGenerated}
                  legacy={
                    <GenerationPanel
                      document={selected}
                      settings={tts}
                      available={ttsAvailable}
                      disabled={resourcesLocked}
                      intents={generationIntents.current}
                      onReady={applyGenerated}
                    />
                  }
                />
              </div>
            ) : (
              <>
                <p className="source-note">
                  {audio.kind === "demo"
                    ? "再生・録音を試す確認音（本文の読み上げではありません）"
                    : audio.kind === "fixture"
                      ? audio.delivery === "playlist"
                        ? "テスト用の人工音声（本文の合成ではありません）"
                        : "テスト用無音音声（本文の合成ではありません）"
                      : audio.kind === "windows"
                        ? "このPCの日本語音声（開発用）"
                        : audio.kind === "voicevox"
                          ? String(
                              audio.synthesis_profile?.credit ?? "VOICEVOX",
                            )
                          : "資料から生成した音声"}
                  {!currentAudio && " · 過去の資料バージョン"}
                </p>
                {!currentAudio && (
                  <RevisedAudioOptions
                    key={`${audio.id}:${selected.current_version.id}`}
                  >
                    <NarrationPanel
                      key={selected.current_version.id}
                      document={selected}
                      userId={user.id}
                      disabled={resourcesLocked}
                      onReady={applyGenerated}
                      legacy={
                        <GenerationPanel
                          document={selected}
                          settings={tts}
                          available={ttsAvailable}
                          disabled={resourcesLocked}
                          intents={generationIntents.current}
                          onReady={applyGenerated}
                        />
                      }
                    />
                  </RevisedAudioOptions>
                )}
                {playerState === "loading" && (
                  <p role="status">音声の区間を読み込んでいます…</p>
                )}
                {playerError && (
                  <p role="alert" className="notice warning">
                    {playerError}
                    <button
                      className="text-button"
                      disabled={controlsLocked}
                      onClick={() => {
                        if (mainAudio.current?.hasError)
                          mainAudio.current.retry();
                        else setManifestAttempt((value) => value + 1);
                        setPlayerError("");
                        setPlayerState("loading");
                      }}
                    >
                      音声を再読込
                    </button>
                  </p>
                )}
                <div className="playback-position">
                  <input
                    className="seek"
                    aria-label="再生位置"
                    type="range"
                    min={0}
                    max={duration || audio.duration_ms || 1}
                    step={100}
                    value={Math.min(
                      position,
                      duration || audio.duration_ms || 1,
                    )}
                    disabled={
                      controlsLocked ||
                      !duration ||
                      !progressReady ||
                      playerState !== "ready"
                    }
                    onChange={(event) => {
                      if (!controlsLocked && mainAudio.current) {
                        pauseMemos();
                        mainAudio.current.currentTime =
                          Number(event.target.value) / 1000;
                        setPosition(Number(event.target.value));
                      }
                    }}
                  />
                  <div className="time-row">
                    <span>{formatTime(position)}</span>
                    <span>{formatTime(duration || audio.duration_ms)}</span>
                  </div>
                </div>
                <div className="play-controls">
                  <button
                    className="soft"
                    disabled={
                      controlsLocked ||
                      !duration ||
                      !progressReady ||
                      playerState !== "ready"
                    }
                    onClick={() => {
                      pauseMemos();
                      const element = mainAudio.current!;
                      element.currentTime = Math.max(
                        0,
                        element.currentTime - 10,
                      );
                      updatePlayback();
                    }}
                    aria-label="10秒戻る"
                  >
                    <Icon name="back" size={18} /> 10秒
                  </button>
                  <button
                    className="primary play-button"
                    data-testid="play-toggle"
                    disabled={
                      controlsLocked ||
                      !duration ||
                      !progressReady ||
                      (playerState !== "ready" &&
                        mainAudio.current?.paused !== false)
                    }
                    onClick={() => {
                      if (mainAudio.current?.paused)
                        void controller.current?.play();
                      else mainAudio.current?.pause();
                    }}
                  >
                    <Icon
                      name={
                        playing || mainAudio.current?.paused === false
                          ? "pause"
                          : "play"
                      }
                    />
                    {playing || mainAudio.current?.paused === false
                      ? "一時停止"
                      : "再生"}
                  </button>
                </div>
                <div className="record-area">
                  {recordingSupported() && (
                    <MicrophoneInput
                      selectedId={microphoneId}
                      onSelect={(id) => {
                        setMicrophoneId(id);
                        setMicrophoneLabel("");
                      }}
                      disabled={busy || mutating || needsLogin}
                      onChecking={setMicrophoneChecking}
                      onAvailable={setMicrophoneAvailable}
                      onUnavailable={() => controller.current?.interrupt()}
                      onPrepare={() => {
                        controller.current?.invalidatePlayback();
                        pauseMemos();
                      }}
                      actualLabel={microphoneLabel}
                      recording={captureState === "recording"}
                      level={microphoneLevel}
                    />
                  )}
                  <button
                    className={`record-button ${captureState === "recording" ? "recording" : ""}`}
                    data-testid="record-toggle"
                    disabled={
                      captureState !== "recording" &&
                      (mutating ||
                        microphoneChecking ||
                        !microphoneAvailable ||
                        needsLogin ||
                        captureState !== "idle" ||
                        !outboxReady ||
                        playerState !== "ready" ||
                        !duration ||
                        !progressReady ||
                        !recordingSupported() ||
                        pending.length >= 3)
                    }
                    aria-pressed={captureState === "recording"}
                    onClick={() => {
                      if (captureState === "recording")
                        controller.current?.stop();
                      else if (captureState === "idle" && selected)
                        void controller.current?.begin(
                          {
                            userId: user.id,
                            documentId: selected.id,
                            documentTitle: selected.title,
                            audioVersion: audio.id,
                          },
                          microphoneId,
                        );
                    }}
                  >
                    <Icon
                      name={captureState === "recording" ? "stop" : "mic"}
                    />
                    {captureState === "recording"
                      ? "録音を終了"
                      : captureState === "starting"
                        ? "マイクを準備中…"
                        : captureState === "finishing"
                          ? "録音を終了しています…"
                          : captureState === "saving"
                            ? "保存しています…"
                            : "メモする"}
                  </button>
                  {captureState === "recording" && (
                    <p className="record-clock" role="timer">
                      録音中 {formatTime(elapsed)} / 1:00
                    </p>
                  )}
                  {captureState === "starting" && (
                    <button
                      className="text-button full"
                      onClick={() => controller.current?.cancel()}
                    >
                      準備をキャンセル
                    </button>
                  )}
                  {captureState === "finishing" && (
                    <button
                      className="text-button danger full"
                      data-testid="record-discard"
                      onClick={() => {
                        if (controller.current?.state !== "finishing") return;
                        if (
                          !window.confirm(
                            "終了を待っている録音を破棄しますか？この録音はまだ保存されていません。破棄すると復元できません。",
                          )
                        )
                          return;
                        if (!controller.current.discard())
                          setStatus(
                            "録音の処理が進んだため破棄しませんでした。保存結果の表示をお待ちください。",
                          );
                      }}
                    >
                      録音を破棄
                    </button>
                  )}
                  <p className="record-hint">
                    {!recordingSupported()
                      ? "録音にはHTTPSと、マイクに対応したSafari / ブラウザが必要です。"
                      : pending.length >= 3
                        ? "未送信の録音を再送してから、新しいメモを録音してください。"
                        : "最長1分"}
                  </p>
                </div>
                {recentMemo?.audio_version === audio.id && (
                  <RecentMemo
                    memo={recentMemo}
                    disabled={controlsLocked}
                    sourcePaused={!playing}
                    register={(element) => registerMemo("recent", element)}
                    onPlay={playMemo}
                    onResume={() => void controller.current?.play()}
                    onOpen={() => {
                      queueProgress();
                      controller.current?.invalidatePlayback();
                      pauseMemos();
                      setMemoDocument(recentMemo.document.id);
                      setTab("memos");
                    }}
                    onStatus={setStatus}
                  />
                )}
                <div
                  className="progress-status"
                  role="status"
                  data-testid="progress-status"
                >
                  {progressState === "loading"
                    ? "前回の再生位置を確認中…"
                    : progressState === "saving"
                      ? "再生位置を保存中…"
                      : progressState === "saved"
                        ? "再生位置を保存済み"
                        : progressState === "conflict"
                          ? "別の画面で再生位置が更新されました。保存を停止しています。"
                          : "再生位置を保存・確認できませんでした。"}
                  {(progressState === "error" ||
                    progressState === "conflict") && (
                    <button
                      className="text-button"
                      disabled={controlsLocked}
                      onClick={() => {
                        const tracker = progressTracker.current;
                        if (!tracker) return;
                        if (progressState === "conflict" || !tracker.ready) {
                          mainAudio.current?.pause();
                          seekIntent.current = undefined;
                          void restoreProgress(tracker);
                        } else void tracker.retry();
                      }}
                    >
                      {progressState === "conflict"
                        ? "保存済みの位置を開く"
                        : "再試行"}
                    </button>
                  )}
                </div>
                <div className="listening-options">
                  <label>
                    再生速度
                    <select
                      aria-label="再生速度"
                      value={rate}
                      disabled={controlsLocked}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setRate(next);
                        try {
                          localStorage.setItem(
                            `lc-playback-rate:${user.id}`,
                            String(next),
                          );
                        } catch {
                          setStatus(
                            "再生速度はこの画面に適用しました。端末には保存できませんでした。",
                          );
                        }
                      }}
                    >
                      {[0.75, 1, 1.25, 1.5, 2].map((value) => (
                        <option key={value} value={value}>
                          {value}倍
                        </option>
                      ))}
                    </select>
                  </label>
                  {activeMapping && activeMapping.segments.length > 0 && (
                    <label>
                      音声の区間
                      <select
                        aria-label="音声の区間"
                        value={activeSegment?.index ?? 0}
                        disabled={controlsLocked || !progressReady || !duration}
                        onChange={(event) => {
                          const segment = activeMapping.segments.find(
                            (item) => item.index === Number(event.target.value),
                          );
                          if (!segment || !mainAudio.current || controlsLocked)
                            return;
                          pauseMemos();
                          mainAudio.current.currentTime =
                            segment.start_ms / 1000;
                          setPosition(segment.start_ms);
                          progressTracker.current?.observe(
                            segment.start_ms,
                            true,
                          );
                        }}
                      >
                        {activeMapping.segments.map((item) => (
                          <option key={item.index} value={item.index}>
                            区間{item.index + 1} · {formatTime(item.start_ms)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {mappingError && (
                  <p className="notice warning" role="alert">
                    {mappingError}
                    <button
                      className="text-button"
                      disabled={controlsLocked}
                      onClick={() => setMappingAttempt((n) => n + 1)}
                    >
                      区間を再読込
                    </button>
                  </p>
                )}
              </>
            )}
            {selected && (
              <VersionContext
                document={selected}
                audio={audio}
                segment={activeSegment}
                focusRequest={sourceFocus}
                onReturnPlayer={() => {
                  playerPanel.current?.scrollIntoView({ block: "start" });
                  document
                    .getElementById("player-heading")
                    ?.focus({ preventScroll: true });
                }}
                disabled={resourcesLocked}
                onDelete={() => void removeDocument()}
                onSourceDeleted={() => {
                  libraryRevision.current.documents++;
                  const update = (item: Document) =>
                    item.id === selected.id && item.source_pdf
                      ? {
                          ...item,
                          source_pdf: {
                            ...item.source_pdf,
                            source_available: false,
                            source_url: null,
                            source_size_bytes: 0,
                          },
                        }
                      : item;
                  setSelected((current) =>
                    current ? update(current) : current,
                  );
                  setDocuments((items) => items.map(update));
                  if (selectedLive.current.documentId === selected.id)
                    setStatus(
                      "PDF原本を削除しました。本文と録音は残っています。",
                    );
                }}
              />
            )}
          </section>
        </div>
      ) : (
        <section className="memo-section" aria-labelledby="memos-heading">
          <div className="section-title">
            <div>
              <h2 id="memos-heading" tabIndex={-1}>
                録音したメモ
              </h2>
            </div>
            <span className="count">{memos.length}件</span>
          </div>
          {memos.length > 0 && (
            <div className="memo-toolbar">
              <label htmlFor="memo-document">資料で絞り込む</label>
              <select
                id="memo-document"
                value={activeMemoDocument}
                disabled={controlsLocked}
                onChange={(event) => setMemoDocument(event.target.value)}
              >
                <option value="">すべての資料</option>
                {[
                  ...new Map(
                    memos.map((memo) => [memo.document.id, memo.document]),
                  ).values(),
                ].map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.title}
                  </option>
                ))}
              </select>
              <p role="status">
                {
                  memos.filter(
                    (memo) =>
                      !activeMemoDocument ||
                      memo.document.id === activeMemoDocument,
                  ).length
                }
                件を表示 · 新しい録音から
              </p>
            </div>
          )}
          {memos.length === 0 ? (
            <div className="panel empty">
              {loading ? (
                "録音を読み込んでいます…"
              ) : libraryErrors.includes("声のメモ一覧") ? (
                "録音一覧はまだ確認できていません。上の案内から再読込できます。"
              ) : (
                <>
                  まだ音声メモがありません。
                  <br />
                  聴いている途中に「メモする」を押してみてください。
                </>
              )}
            </div>
          ) : (
            <div className="memo-grid">
              {memos
                .filter(
                  (memo) =>
                    !activeMemoDocument ||
                    memo.document.id === activeMemoDocument,
                )
                .map((memo) => (
                  <MemoCard
                    key={memo.id}
                    memo={memo}
                    text={memoDrafts.get(memo.id) ?? memo.text}
                    dirty={memoDrafts.has(memo.id)}
                    saving={savingMemos.has(memo.id)}
                    disabled={resourcesLocked}
                    draftState={draftNotes.states.get(memo.id)}
                    draftConflict={draftNotes.conflicts.has(memo.id)}
                    onReturn={() => void returnToMemo(memo)}
                    register={(element) => registerMemo(memo.id, element)}
                    onPlay={playMemo}
                    onTextChange={(text) => draftNotes.change(memo, text)}
                    onSave={() => void saveMemoText(memo)}
                    onDelete={() => {
                      deletedMemos.current.add(memo.id);
                      libraryRevision.current.memos++;
                      void draftNotes.drop(memo.id);
                      setMemos((items) =>
                        items.filter((item) => item.id !== memo.id),
                      );
                      setRecentMemo((saved) =>
                        saved?.id === memo.id ? null : saved,
                      );
                    }}
                    onStatus={setStatus}
                  />
                ))}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
