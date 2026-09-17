import type { VoicePreset } from '../../types';

/**
 * Optional premium cloud voices (ElevenLabs, OpenAI, or anything else).
 *
 * There is deliberately no API key in this codebase. Narrato is a static site,
 * so any key shipped in the bundle would be readable by everyone who loads the
 * page. Instead the app calls a relay *you* host, and the relay holds the key.
 *
 * Configure with:
 *   VITE_TTS_PROVIDER=elevenlabs | openai
 *   VITE_TTS_PROXY_URL=https://your-relay.example.com/speak
 *
 * The relay must accept a JSON POST and respond with raw audio bytes:
 *   POST { text, voice, provider, speed } -> audio/mpeg | audio/wav
 *
 * See "Premium voices" in the README for a minimal relay implementation.
 */

export function premiumProvider(): 'elevenlabs' | 'openai' | 'none' {
  return (import.meta.env.VITE_TTS_PROVIDER as 'elevenlabs' | 'openai' | 'none') ?? 'none';
}

export function premiumRelayUrl(): string | null {
  const url = import.meta.env.VITE_TTS_PROXY_URL;
  return url && url.trim() !== '' ? url : null;
}

export function isPremiumConfigured(): boolean {
  return premiumProvider() !== 'none' && premiumRelayUrl() !== null;
}

export interface PremiumResult {
  blob: Blob;
  durationSec: number;
}

/**
 * Decode just far enough to learn the clip's duration.
 *
 * The buffer planner works in seconds, so an unknown duration would break
 * every buffering decision. Relays return compressed audio without a duration
 * header we can trust, so we decode it once here.
 */
async function measureDuration(blob: Blob): Promise<number> {
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return 0;

  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    return decoded.duration;
  } catch {
    return 0;
  } finally {
    void ctx.close();
  }
}

export async function generatePremium(
  text: string,
  preset: VoicePreset,
  signal?: AbortSignal
): Promise<PremiumResult> {
  const relay = premiumRelayUrl();
  const provider = premiumProvider();
  if (!relay || provider === 'none') {
    throw new Error(
      'Premium voices are not configured. Set VITE_TTS_PROVIDER and VITE_TTS_PROXY_URL, and host a relay (see the README).'
    );
  }

  const res = await fetch(relay, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      provider,
      voice: preset.kokoroVoice ?? preset.id,
      speed: preset.rateBias,
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`The voice relay returned HTTP ${res.status}.`);
  }

  const blob = await res.blob();
  if (blob.size === 0) throw new Error('The voice relay returned no audio.');

  return { blob, durationSec: await measureDuration(blob) };
}
