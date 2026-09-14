import type { TtsProvider, TtsRequest, TtsResult } from './types';
import type { VoicePreset } from '../../types';

/**
 * Premium TTS stub (ElevenLabs / OpenAI-style).
 * Set VITE_TTS_PROVIDER + VITE_TTS_PROXY_URL to a backend proxy — never ship secret keys in the client.
 */
export function createPremiumTtsProvider(opts: {
  provider: 'elevenlabs' | 'openai' | 'none';
  proxyUrl?: string;
}): TtsProvider {
  const enabled = opts.provider !== 'none' && Boolean(opts.proxyUrl);

  return {
    id: `premium-${opts.provider}`,
    label: opts.provider === 'none' ? 'Premium (not configured)' : `Premium (${opts.provider})`,
    supportsAudioElement: true,
    isAvailable() {
      return enabled;
    },
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      if (!enabled || !opts.proxyUrl) throw new Error('Premium TTS not configured');
      const res = await fetch(opts.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: req.chunk.text,
          voice: req.preset.id,
          rate: req.rate,
          provider: opts.provider,
        }),
      });
      if (!res.ok) throw new Error(`Premium TTS failed: ${res.status}`);
      const blob = await res.blob();
      return { kind: 'audio', url: URL.createObjectURL(blob) };
    },
    async preview(text: string, preset: VoicePreset) {
      if (!enabled || !opts.proxyUrl) throw new Error('Premium TTS not configured');
      const res = await fetch(opts.proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: preset.id, provider: opts.provider }),
      });
      if (!res.ok) throw new Error('Preview failed');
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      await audio.play();
    },
    cancelPreview() {},
  };
}
