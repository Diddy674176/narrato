import type { TextChunk, VoicePreset } from '../../types';

export interface TtsRequest {
  chunk: TextChunk;
  preset: VoicePreset;
  voiceURI: string | null;
  rate: number;
  volume: number;
  pitch?: number;
}

export type TtsResult =
  | { kind: 'audio'; url: string; durationHintSec?: number }
  | { kind: 'utterance'; speak: () => Promise<void>; cancel: () => void };

export interface TtsProvider {
  id: string;
  label: string;
  supportsAudioElement: boolean;
  isAvailable(): boolean;
  synthesize(req: TtsRequest): Promise<TtsResult>;
  preview(text: string, preset: VoicePreset, voiceURI: string | null): Promise<void>;
  cancelPreview(): void;
}
