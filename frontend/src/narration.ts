import { request } from "./api";
import { generationFailure } from "./generation";

export type NarrationProvider = "polly" | "windows" | "fixture" | "voicevox";
export type VoicevoxVoice = { speaker_id: number; pitch_scale: number };
export type VoicevoxSpeaker = {
  id: number;
  name: string;
  style: string;
  credit: string;
  speaker_uuid: string;
  speaker_version: string;
};
export type NarrationConfig = {
  fixture_segment_duration_ms?: number;
  max_characters: number;
  max_duration_ms: number;
  daily_character_limit: number;
  providers: {
    id: NarrationProvider;
    enabled: boolean;
    label: string;
    voice: string;
    billable: boolean;
    voices?: VoicevoxSpeaker[];
    defaults?: VoicevoxVoice;
    pitch_min?: number;
    pitch_max?: number;
    pitch_step?: number;
  }[];
};
export type NarrationJob = {
  id: string;
  document_version: string;
  provider: NarrationProvider;
  state: "queued" | "running" | "succeeded" | "failed";
  audio_version: string | null;
  error_code: string | null;
  character_count: number;
  completed_segments: number;
  total_segments: number;
  retry_characters: number;
  has_unknown: boolean;
  updated_at: string;
  cancel_requested_at?: string | null;
  voice?: VoicevoxVoice;
  synthesis_profile?: Record<string, unknown>;
};
export type AudioSegment = {
  index: number;
  start_offset: number;
  end_offset: number;
  start_ms: number;
  end_ms: number;
  block_ids: string[];
};
export type NarrationMap = {
  audio_version: string;
  document_version: string;
  precision: "segment" | "unavailable";
  segments: AudioSegment[];
};
export type NarrationIntent = {
  key: string;
  operation: "start" | "retry";
  provider: NarrationProvider;
  jobId?: string;
  acknowledge: boolean;
  voice?: VoicevoxVoice;
};
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type NarrationScope = {
  userId: string;
  documentId: string;
  versionId: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const providers = new Set(["polly", "windows", "fixture", "voicevox"]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
const bounded = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= maximum;

export function parseVoicevoxVoice(value: unknown): VoicevoxVoice {
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !bounded(value.speaker_id, 100000) ||
    typeof value.pitch_scale !== "number" ||
    !Number.isFinite(value.pitch_scale) ||
    value.pitch_scale < -0.15 ||
    value.pitch_scale > 0.15 ||
    Math.abs(value.pitch_scale * 100 - Math.round(value.pitch_scale * 100)) >
      0.0000001
  )
    throw new NarrationStorageError();
  return { speaker_id: value.speaker_id, pitch_scale: value.pitch_scale };
}
function sameVoice(left?: VoicevoxVoice, right?: VoicevoxVoice): boolean {
  return (
    left?.speaker_id === right?.speaker_id &&
    left?.pitch_scale === right?.pitch_scale
  );
}

export class NarrationStorageError extends Error {
  constructor() {
    super(
      "音声生成の受付記録を安全に確認できません。新しい依頼は送信せず、画面を開き直して確認してください。",
    );
    this.name = "NarrationStorageError";
  }
}

export function parseNarrationIntent(value: unknown): NarrationIntent {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "key",
          "operation",
          "provider",
          "jobId",
          "acknowledge",
          "voice",
        ].includes(key),
    ) ||
    !identifier(value.key) ||
    (value.operation !== "start" && value.operation !== "retry") ||
    typeof value.provider !== "string" ||
    !providers.has(value.provider) ||
    typeof value.acknowledge !== "boolean" ||
    (value.operation === "start" &&
      (value.jobId !== undefined || value.acknowledge)) ||
    (value.operation === "retry" && !identifier(value.jobId)) ||
    (value.provider !== "voicevox" && value.voice !== undefined)
  )
    throw new NarrationStorageError();
  return {
    key: value.key,
    operation: value.operation,
    provider: value.provider as NarrationProvider,
    acknowledge: value.acknowledge,
    ...(value.operation === "retry" ? { jobId: value.jobId as string } : {}),
    ...(value.provider === "voicevox"
      ? { voice: parseVoicevoxVoice(value.voice) }
      : {}),
  };
}
function sameIntent(left: NarrationIntent, right: NarrationIntent): boolean {
  return (
    left.key === right.key &&
    left.operation === right.operation &&
    left.provider === right.provider &&
    left.jobId === right.jobId &&
    left.acknowledge === right.acknowledge &&
    sameVoice(left.voice, right.voice)
  );
}

export class NarrationIntents {
  constructor(
    private user: string,
    private version: string,
    private storage: StorageAccess,
  ) {}
  private key() {
    return `lc-narration-intent-v1:${this.user}:${this.version}`;
  }
  read(): NarrationIntent | null {
    try {
      const raw = this.storage.getItem(this.key());
      if (raw === null) return null;
      if (typeof raw !== "string" || !raw.length || raw.length > 2048)
        throw new NarrationStorageError();
      return parseNarrationIntent(JSON.parse(raw));
    } catch {
      throw new NarrationStorageError();
    }
  }
  write(value: NarrationIntent): void {
    const valid = parseNarrationIntent(value);
    const previous = this.read();
    // An unknown request may already have spent a budget. Never replace it with
    // a fresh UUID, provider, target or changed unknown-result acknowledgement.
    if (previous && !sameIntent(previous, valid))
      throw new NarrationStorageError();
    try {
      this.storage.setItem(this.key(), JSON.stringify(valid));
      const persisted = this.read();
      if (!persisted || !sameIntent(persisted, valid))
        throw new NarrationStorageError();
    } catch {
      throw new NarrationStorageError();
    }
  }
  clear(expected: NarrationIntent): void {
    const previous = this.read();
    if (!previous || !sameIntent(previous, expected))
      throw new NarrationStorageError();
    try {
      this.storage.removeItem(this.key());
      if (this.read() !== null) throw new NarrationStorageError();
    } catch {
      throw new NarrationStorageError();
    }
  }
}

export function parseNarrationJob(value: unknown): NarrationJob {
  if (
    !object(value) ||
    !identifier(value.id) ||
    !identifier(value.document_version) ||
    typeof value.provider !== "string" ||
    !providers.has(value.provider) ||
    typeof value.state !== "string" ||
    !["queued", "running", "succeeded", "failed"].includes(value.state) ||
    (value.audio_version !== null && !identifier(value.audio_version)) ||
    (value.state === "succeeded" && !identifier(value.audio_version)) ||
    (value.error_code !== null && typeof value.error_code !== "string") ||
    !bounded(value.character_count, 20000) ||
    !bounded(value.retry_characters, 20000) ||
    !bounded(value.total_segments, 1000) ||
    !bounded(value.completed_segments, value.total_segments) ||
    typeof value.has_unknown !== "boolean" ||
    typeof value.updated_at !== "string" ||
    (value.cancel_requested_at !== undefined &&
      value.cancel_requested_at !== null &&
      (typeof value.cancel_requested_at !== "string" ||
        value.cancel_requested_at.length > 64 ||
        !Number.isFinite(Date.parse(value.cancel_requested_at))))
  )
    throw new Error(
      "音声生成の応答を確認できません。同じ依頼の記録を残しています。",
    );
  if (value.provider === "voicevox") {
    try {
      return {
        ...value,
        voice: parseVoicevoxVoice(value.voice),
      } as unknown as NarrationJob;
    } catch {
      throw new Error(
        "音声設定が依頼と一致しません。同じ依頼の記録を残しています。",
      );
    }
  }
  return value as unknown as NarrationJob;
}
export function parseNarrationConfig(value: unknown): NarrationConfig {
  if (
    !object(value) ||
    !bounded(value.max_characters, 20000) ||
    value.max_characters === 0 ||
    !bounded(value.max_duration_ms, 3600000) ||
    value.max_duration_ms === 0 ||
    !bounded(value.daily_character_limit, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(value.providers) ||
    value.providers.length > 4 ||
    value.providers.some(
      (item) =>
        !object(item) ||
        typeof item.id !== "string" ||
        !providers.has(item.id) ||
        typeof item.enabled !== "boolean" ||
        typeof item.label !== "string" ||
        typeof item.voice !== "string" ||
        typeof item.billable !== "boolean",
    ) ||
    new Set(value.providers.map((item) => item.id)).size !==
      value.providers.length
  )
    throw new Error(
      "音声生成の設定を確認できません。設定を再確認してください。",
    );
  for (const item of value.providers) {
    if (item.id !== "voicevox" || !item.enabled) continue;
    try {
      const selected = parseVoicevoxVoice(item.defaults);
      if (
        !Array.isArray(item.voices) ||
        !item.voices.length ||
        item.voices.length > 1000 ||
        item.voices.some(
          (speaker: unknown) =>
            !object(speaker) ||
            !bounded(speaker.id, 2147483647) ||
            [
              speaker.name,
              speaker.style,
              speaker.credit,
              speaker.speaker_uuid,
              speaker.speaker_version,
            ].some(
              (field) =>
                typeof field !== "string" ||
                !field.length ||
                field.length > 500,
            ),
        ) ||
        new Set(item.voices.map((speaker: VoicevoxSpeaker) => speaker.id))
          .size !== item.voices.length ||
        !item.voices.some(
          (speaker: VoicevoxSpeaker) => speaker.id === selected.speaker_id,
        ) ||
        item.pitch_min !== -0.15 ||
        item.pitch_max !== 0.15 ||
        item.pitch_step !== 0.01 ||
        item.billable !== false
      )
        throw new Error("voicevox config");
    } catch {
      throw new Error(
        "VOICEVOXの声の一覧を確認できません。設定を再確認してください。",
      );
    }
  }
  return value as unknown as NarrationConfig;
}
export const narrationApi = {
  config: (signal?: AbortSignal) =>
    request<unknown>("narration/config/", { signal }).then(
      parseNarrationConfig,
    ),
  current: (documentId: string, signal?: AbortSignal) =>
    request<unknown>(`documents/${encodeURIComponent(documentId)}/narration/`, {
      signal,
    }).then((value) => (value === null ? null : parseNarrationJob(value))),
  job: (id: string, signal?: AbortSignal) =>
    request<unknown>(`narrations/${encodeURIComponent(id)}/`, { signal }).then(
      parseNarrationJob,
    ),
  cancel: (id: string, userId: string, signal?: AbortSignal) =>
    request<unknown>(`narrations/${encodeURIComponent(id)}/cancel/`, {
      method: "POST",
      body: "{}",
      headers: { "X-Workspace-User": userId },
      signal,
    }).then(parseNarrationJob),
  mapping: (id: string, signal?: AbortSignal) =>
    request<NarrationMap>(`audio/${encodeURIComponent(id)}/narration-map/`, {
      signal,
    }),
};

// Cancelling the fetch only detaches this view. The server owns cancellation,
// so a lost response is recovered by polling or repeating this same job ID.
export class NarrationCancellation {
  private flight?: AbortController;
  private disposed = false;
  constructor(
    private scope: NarrationScope,
    private post = narrationApi.cancel,
  ) {}
  get busy() {
    return Boolean(this.flight);
  }
  async submit(job: NarrationJob): Promise<NarrationJob | undefined> {
    if (this.disposed || this.flight) return;
    if (
      job.document_version !== this.scope.versionId ||
      !["queued", "running"].includes(job.state)
    )
      return;
    const controller = new AbortController();
    this.flight = controller;
    try {
      const next = await this.post(
        job.id,
        this.scope.userId,
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted) return;
      if (
        next.id !== job.id ||
        next.document_version !== this.scope.versionId ||
        next.provider !== job.provider ||
        !sameVoice(next.voice, job.voice) ||
        (["queued", "running"].includes(next.state) &&
          !next.cancel_requested_at)
      )
        throw new Error("中断の受付結果が依頼と一致しません。");
      return next;
    } finally {
      if (this.flight === controller) this.flight = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    this.flight?.abort();
  }
}

type Receipt = {
  job: NarrationJob;
  pending: NarrationIntent | null;
  cleanupFailed: boolean;
};
type Post = (
  scope: NarrationScope,
  value: NarrationIntent,
  signal: AbortSignal,
) => Promise<unknown>;
const sendRequest: Post = (scope, value, signal) =>
  request<unknown>(
    value.operation === "start"
      ? `documents/${encodeURIComponent(scope.documentId)}/narration/`
      : `narrations/${encodeURIComponent(value.jobId!)}/retry/`,
    {
      method: "POST",
      signal,
      body: JSON.stringify(
        value.operation === "start"
          ? {
              document_version: scope.versionId,
              client_id: value.key,
              provider: value.provider,
              ...(value.voice ? { voice: value.voice } : {}),
            }
          : { client_id: value.key, acknowledge_unknown: value.acknowledge },
      ),
    },
  );

export class NarrationRequests {
  private flight?: AbortController;
  private disposed = false;
  private cached: NarrationIntent | null = null;
  constructor(
    private scope: NarrationScope,
    private intents: NarrationIntents,
    private post: Post = sendRequest,
  ) {}
  get busy() {
    return Boolean(this.flight);
  }
  get pending() {
    return this.cached
      ? {
          ...this.cached,
          ...(this.cached.voice ? { voice: { ...this.cached.voice } } : {}),
        }
      : null;
  }
  restore() {
    this.cached = this.intents.read();
    return this.pending;
  }
  async submit(value: NarrationIntent): Promise<Receipt | undefined> {
    if (this.disposed || this.flight) return;
    const intent = parseNarrationIntent(value);
    this.intents.write(intent);
    this.cached = intent;
    const controller = new AbortController();
    this.flight = controller;
    try {
      const result = await this.post(
        this.scope,
        { ...intent, ...(intent.voice ? { voice: { ...intent.voice } } : {}) },
        controller.signal,
      );
      if (this.disposed || controller.signal.aborted) return;
      const job = parseNarrationJob(result);
      if (
        job.document_version !== this.scope.versionId ||
        job.provider !== intent.provider ||
        (intent.provider === "voicevox" &&
          !sameVoice(job.voice, intent.voice)) ||
        (intent.operation === "retry" && job.id !== intent.jobId)
      )
        throw new Error(
          "別の資料の音声生成結果を受け取りました。受付記録を残したまま処理を止めています。",
        );
      let cleanupFailed = false;
      try {
        this.intents.clear(intent);
        this.cached = null;
      } catch {
        cleanupFailed = true;
      }
      return { job, pending: this.pending, cleanupFailed };
    } finally {
      if (this.flight === controller) this.flight = undefined;
    }
  }
  dispose() {
    this.disposed = true;
    this.flight?.abort();
  }
}

export function retryNarrationIntent(
  job: NarrationJob,
  acknowledge: boolean,
): NarrationIntent {
  if (job.state !== "failed" || (job.has_unknown && !acknowledge))
    throw new Error("未確認の区間を作り直す前に、追加実行への確認が必要です。");
  return parseNarrationIntent({
    key: crypto.randomUUID(),
    operation: "retry",
    provider: job.provider,
    jobId: job.id,
    acknowledge: job.has_unknown && acknowledge,
    ...(job.voice ? { voice: job.voice } : {}),
  });
}
export function narrationFailure(job: NarrationJob): string {
  if (job.error_code === "user_cancelled") return "中断しました。";
  if (job.error_code === "execution_unknown" && job.provider !== "polly")
    return "処理結果を確認できません。未確認の区間を自動で作り直しません。";
  return generationFailure(job.error_code);
}
export function segmentAt(
  position: number,
  segments: AudioSegment[],
): AudioSegment | undefined {
  if (!Number.isFinite(position) || position < 0) return;
  return segments.find(
    (segment, index) =>
      position >= segment.start_ms &&
      (position < segment.end_ms ||
        (index === segments.length - 1 && position === segment.end_ms)),
  );
}
