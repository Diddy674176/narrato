import type { TtsProvider, TtsRequest, TtsResult } from './types';
import type { VoicePreset } from '../../types';

export function createBrowserSpeechProvider(): TtsProvider {
  return {
    id: 'browser-speech',
    label: 'System Voices (free)',
    supportsAudioElement: false,
    isAvailable() {
      return typeof window !== 'undefined' && 'speechSynthesis' in window;
    },
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      return {
        kind: 'utterance',
        speak: () =>
          new Promise<void>((resolve, reject) => {
            if (!window.speechSynthesis) {
              reject(new Error('Speech synthesis unavailable'));
              return;
            }
            window.speechSynthesis.cancel();
            const u = new SpeechSynthesisUtterance(req.chunk.text);
            u.rate = Math.min(2, Math.max(0.5, req.rate * (req.preset.rateBias || 1)));
            u.pitch = req.pitch ?? req.preset.pitch;
            u.volume = req.volume;
            if (req.voiceURI) {
              const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === req.voiceURI);
              if (voice) u.voice = voice;
            }
            u.onend = () => resolve();
            u.onerror = (e) => {
              if (e.error === 'canceled' || e.error === 'interrupted') resolve();
              else reject(new Error(e.error || 'TTS error'));
            };
            window.speechSynthesis.speak(u);
          }),
        cancel: () => window.speechSynthesis?.cancel(),
      };
    },
    async preview(text: string, preset: VoicePreset, voiceURI: string | null) {
      this.cancelPreview();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1 * (preset.rateBias || 1);
      u.pitch = preset.pitch;
      if (voiceURI) {
        const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
        if (voice) u.voice = voice;
      }
      window.speechSynthesis.speak(u);
    },
    cancelPreview() {
      window.speechSynthesis?.cancel();
    },
  };
}
