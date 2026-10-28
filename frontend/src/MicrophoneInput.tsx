import { useEffect, useRef, useState } from "react";
import {
  listMicrophones,
  microphoneFailure,
  requestMicrophonePermission,
} from "./microphone";
import type { MicrophoneInput as Input } from "./microphone";

export default function MicrophoneInput({
  selectedId,
  onSelect,
  disabled,
  onChecking,
  onAvailable,
  onUnavailable,
  onPrepare,
  actualLabel,
  recording,
  level,
}: {
  selectedId: string;
  onSelect: (deviceId: string) => void;
  disabled: boolean;
  onChecking: (checking: boolean) => void;
  onAvailable: (available: boolean) => void;
  onUnavailable?: () => void;
  onPrepare: () => void;
  actualLabel: string;
  recording: boolean;
  level: number | null;
}) {
  const [inputs, setInputs] = useState<Input[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const request = useRef(0);
  const enumeration = useRef(0);
  const lastSeenSelection = useRef("");
  const hasNames = inputs.some((input) => input.label);
  const missing = Boolean(
    selectedId && !inputs.some((input) => input.deviceId === selectedId),
  );
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  refreshRef.current = async () => {
    const revision = ++enumeration.current;
    try {
      const devices = await listMicrophones();
      if (!alive.current || revision !== enumeration.current) return;
      setInputs(devices);
      setError("");
    } catch {
      if (alive.current && revision === enumeration.current)
        setError(
          "マイクの一覧を取得できません。接続とサイトのマイク権限を確認してください。",
        );
    }
  };
  useEffect(() => {
    alive.current = true;
    const refresh = () => void refreshRef.current();
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      alive.current = false;
      request.current++;
      enumeration.current++;
      onChecking(false);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [onChecking]);
  useEffect(() => {
    onAvailable(!missing);
    if (!missing) lastSeenSelection.current = selectedId;
    else if (selectedId && lastSeenSelection.current === selectedId) {
      // Only a previously listed choice disappearing is a disconnect. An
      // initial empty/permission-limited list is not evidence of unplugging.
      lastSeenSelection.current = "";
      onUnavailable?.();
    }
  }, [missing, selectedId, onAvailable, onUnavailable]);
  // A normal capture may grant permission for the first time. Reading the list
  // does not open another stream, including on devicechange.
  useEffect(() => {
    if (actualLabel) void refreshRef.current();
  }, [actualLabel]);

  async function allow() {
    const revision = ++request.current;
    setChecking(true);
    onChecking(true);
    setError("");
    onPrepare();
    try {
      await requestMicrophonePermission(selectedId);
      // Permission is only for discovering names. Do not keep a preview mic
      // open, and release even if this request was cancelled or unmounted.
      if (!alive.current || revision !== request.current) return;
      await refreshRef.current();
    } catch (failure) {
      if (alive.current && revision === request.current)
        setError(microphoneFailure(failure));
    } finally {
      if (alive.current && revision === request.current) {
        setChecking(false);
        onChecking(false);
      }
    }
  }

  return (
    <div className="microphone-input">
      <label htmlFor="microphone-input">入力マイク</label>
      <div className="microphone-controls">
        <select
          id="microphone-input"
          value={selectedId}
          disabled={disabled || checking}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">ブラウザの既定</option>
          {inputs
            .filter((input) => input.deviceId)
            .map((input, index) => (
              <option key={input.deviceId} value={input.deviceId}>
                {input.label || `マイク ${index + 1}（許可後に名前を表示）`}
              </option>
            ))}
          {missing && (
            <option value={selectedId}>選択したマイク（未接続）</option>
          )}
        </select>
        <button
          type="button"
          className="text-button"
          disabled={disabled && !checking}
          onClick={() => {
            if (checking) {
              request.current++;
              setChecking(false);
              onChecking(false);
            } else if (hasNames) void refreshRef.current();
            else void allow();
          }}
        >
          {checking ? "キャンセル" : hasNames ? "更新" : "マイクを許可"}
        </button>
      </div>
      {recording && (
        <div className="microphone-feedback">
          <span className="microphone-name" title={actualLabel}>
            録音中: {actualLabel}
          </span>
          {level === null ? (
            <span>音量表示なし</span>
          ) : (
            <meter
              min={0}
              max={1}
              value={level}
              aria-label="マイク入力レベル"
            />
          )}
        </div>
      )}
      {(error || missing) && (
        <p className="microphone-error" role="alert">
          {error ||
            "選んだマイクが見つかりません。接続を確認するか、別の入力を選んでください。"}
        </p>
      )}
    </div>
  );
}
