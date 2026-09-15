/**
 * Narrato shared domain types.
 *
 * Everything in Narrato is client-side: documents, generated audio and reading
 * positions live in IndexedDB on the user's own device. There is no server that
 * sees a user's books (see README "Architecture & honesty").
 */

/* ------------------------------------------------------------------ *
 * Voices
 * ------------------------------------------------------------------ */

/** Which synthesis backend produces the audio. */
export type VoiceEngineId = 'kokoro' | 'device' | 'premium';

/** The 28 voices shipped with Kokoro-82M v1.0. */
export type KokoroVoiceId =
  | 'af_heart' | 'af_alloy' | 'af_aoede' | 'af_bella' | 'af_jessica'
  | 'af_kore' | 'af_nicole' | 'af_nova' | 'af_river' | 'af_sarah' | 'af_sky'
  | 'am_adam' | 'am_echo' | 'am_eric' | 'am_fenrir' | 'am_liam'
  | 'am_michael' | 'am_onyx' | 'am_puck' | 'am_santa'
  | 'bf_emma' | 'bf_isabella' | 'bf_alice' | 'bf_lily'
  | 'bm_george' | 'bm_lewis' | 'bm_daniel' | 'bm_fable';

export type VoiceGender = 'male' | 'female';
export type VoiceAccent = 'american' | 'british';

/**
 * A user-facing voice choice. Presets are friendly names ("Deep Male Narrator")
 * mapped onto a concrete engine voice, plus delivery biases we can apply
 * without re-training anything (speed bias, and pitch for device TTS).
 */
export interface VoicePreset {
  id: string;
  label: string;
  engine: VoiceEngineId;
  /** Set when engine === 'kokoro'. */
  kokoroVoice?: KokoroVoiceId;
  /** Hint used to pick a matching system voice when engine === 'device'. */
  deviceHint?: string;
  gender: VoiceGender;
  accent: VoiceAccent;
  description: string;
  /** Multiplied into the user's playback rate. 1 = no bias. */
  rateBias: number;
  /** Device-TTS pitch (0-2). Kokoro has no pitch control. */
  pitch: number;
  /** Kokoro's own published quality grade for the underlying voice (A best). */
  quality?: string;
  tags: string[];
}

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

export type DocSource = 'paste' | 'txt' | 'pdf' | 'docx' | 'epub' | 'image' | 'url';

/** Lightweight record shown in the library; never holds the full text. */
export interface DocMeta {
  id: string;
  title: string;
  author: string | null;
  source: DocSource;
  /** Original URL or filename, for provenance. */
  sourceRef: string | null;
  createdAt: number;
  updatedAt: number;
  wordCount: number;
  charCount: number;
  chapterCount: number;
  /** Rough narration length at 1x, in seconds. */
  estSeconds: number;
  favorite: boolean;
  finished: boolean;
  coverEmoji: string;
  description: string | null;
  language: string;
}

export interface Chapter {
  index: number;
  title: string;
  text: string;
}

/** The full text of a document, split into chapters. Stored separately from meta. */
export interface DocContent {
  id: string;
  chapters: Chapter[];
}

/* ------------------------------------------------------------------ *
 * Chunks
 * ------------------------------------------------------------------ */

/**
 * One unit of speech generation. Sized so that a single chunk is worth roughly
 * 20-60s of audio: big enough that we are not paying model warm-up constantly,
 * small enough that the first chunk arrives quickly.
 */
export interface TextChunk {
  id: string;
  /** Global index across the whole document. */
  index: number;
  chapterIndex: number;
  /** Text actually sent to the voice engine (pronunciation rules applied). */
  text: string;
  /** Original text as it appears in the reader. */
  displayText: string;
  /** Character offsets of displayText within its chapter's text. */
  charStart: number;
  charEnd: number;
  /** Detected speaker name, or null for narration. */
  speaker: string | null;
  /** Estimated seconds at 1x, used for buffer math before audio exists. */
  estSeconds: number;
}

/* ------------------------------------------------------------------ *
 * Reading state
 * ------------------------------------------------------------------ */

export interface ReadingPosition {
  docId: string;
  chunkIndex: number;
  chapterIndex: number;
  /** Seconds into the current chunk. */
  offsetSec: number;
  updatedAt: number;
  /** Total seconds listened to this document, for stats. */
  listenedSec: number;
}

export interface Bookmark {
  id: string;
  docId: string;
  chunkIndex: number;
  chapterIndex: number;
  label: string;
  /** Snippet of text so the bookmark is recognisable in a list. */
  preview: string;
  createdAt: number;
}

/** "Kael" -> "Kay el". Applied to spoken text only, never to displayed text. */
export interface PronunciationRule {
  id: string;
  /** null = applies to every document (global rule). */
  docId: string | null;
  from: string;
  to: string;
  matchCase: boolean;
  wholeWord: boolean;
}

/** A character detected in dialogue, optionally bound to a voice preset. */
export interface CharacterVoice {
  id: string;
  docId: string;
  name: string;
  presetId: string | null;
  /** How many dialogue lines we attributed to them (detection confidence signal). */
  lineCount: number;
  manual: boolean;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export type ThemeMode = 'dark' | 'light' | 'system';
export type HighlightMode = 'word' | 'sentence' | 'paragraph' | 'none';
export type StartupMode = 'fast' | 'balanced' | 'smooth';

export interface Settings {
  engine: VoiceEngineId;
  presetId: string;
  rate: number;
  volume: number;
  theme: ThemeMode;
  highlight: HighlightMode;
  startupMode: StartupMode;
  /** Seconds jumped by the skip buttons. */
  skipSeconds: number;
  fontScale: number;
  lineHeight: number;
  readingWidth: number;
  autoScroll: boolean;
  batterySaver: boolean;
  characterVoices: boolean;
  showDiagnostics: boolean;
  /** Preferred device-TTS system voice URI. */
  deviceVoiceURI: string | null;
}

/* ------------------------------------------------------------------ *
 * Engine / diagnostics
 * ------------------------------------------------------------------ */

export type KokoroDevice = 'webgpu' | 'wasm';

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  device: KokoroDevice | null;
  /** Model download progress, 0-1. */
  progress: number;
  message: string;
  /**
   * Real-time factor: generated audio seconds per second of compute.
   * > 1 means the device generates faster than it plays.
   */
  rtf: number | null;
}

export interface BufferStatus {
  /** Seconds of contiguous generated audio ahead of the playhead. */
  bufferedSec: number;
  targetSec: number;
  generating: number | null;
  ready: number[];
  queued: number[];
}
