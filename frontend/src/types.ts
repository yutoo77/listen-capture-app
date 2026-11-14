export type User = { id: string; username: string };
export type TextBlock = {
  id: string;
  index: number;
  start_offset: number;
  end_offset: number;
  text: string;
};
export type PdfImportJob = {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  error_code: string | null;
  extracted_text: string;
  page_count: number | null;
  start_page: number | null;
  end_page: number | null;
  selection_revision: number;
  source_size_bytes: number;
  source_available: boolean;
  filename?: string;
  suggested_title?: string;
  source_url?: string | null;
  confirmed_document: string | null;
  created_at: string;
};
export type Session = {
  user: User | null;
  csrfToken: string;
  ttsAvailable: boolean;
  tts?: TtsSettings;
};
export type TtsSettings = {
  enabled: boolean;
  provider: "polly" | "fixture";
  max_characters: number;
  daily_character_limit: number;
  voice: string;
  engine: string;
  price_per_million_usd: number;
};
export type GenerationJob = {
  id: string;
  client_id: string;
  document_version: string;
  state: "queued" | "running" | "succeeded" | "failed";
  audio_version: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};
export type AudioVersion = {
  id: string;
  document_version: string;
  kind: "demo" | "polly" | "fixture" | "windows" | "voicevox";
  synthesis_profile?: Record<string, unknown>;
  status: "ready";
  duration_ms: number;
  media_url: string | null;
  delivery?: "single" | "playlist";
  playlist_url?: string;
  created_at: string;
};
export type PlaybackProgress = {
  audio_version: string;
  position_ms: number;
  revision: number;
  updated_at: string | null;
};
export type Document = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  current_version: {
    id: string;
    number: number;
    text: string;
    blocks?: TextBlock[];
  };
  audio_versions: AudioVersion[];
  audio_generation?: GenerationJob | null;
  source_pdf?: {
    id: string;
    source_available: boolean;
    source_url: string | null;
    source_size_bytes: number;
    page_count: number | null;
    start_page?: number | null;
    end_page?: number | null;
    selection_revision?: number;
  } | null;
};
export type Memo = {
  id: string;
  client_id: string;
  audio_version: string;
  document: { id: string; title: string };
  document_version: { id: string; number: number };
  position_ms: number;
  duration_ms: number;
  text: string;
  media_url: string;
  created_at: string;
};
export type PendingMemo = {
  clientId: string;
  userId: string;
  audioVersion: string;
  documentId: string;
  documentTitle: string;
  positionMs: number;
  durationMs: number;
  blob: Blob;
  createdAt: string;
  text: string;
};
