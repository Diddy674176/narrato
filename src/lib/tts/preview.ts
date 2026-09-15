import type { VoiceEngineId, VoicePreset } from '../../types';
import { kokoroClient } from './kokoro/client';
import { generatePremium } from './premium';
import { PREVIEW_TEXT, matchSystemVoice } from './voices';

/**
 * Voice previews.
 *
 * Every preset in the picker has a preview button. Kokoro previews are cached
 * per preset for the session so repeatedly auditioning voices does not
 * re-synthesise the same sentence each time.
 */

const cache = new Map<string, string>();
let current: HTMLAudioElement | null = null;

export function stopPreview(): void {
  if (current) {
    current.pause();
    current = null;
  }
  window.speechSynthesis?.cancel();
}

export async function previewVoice(
  preset: VoicePreset,
  deviceVoiceURI: string | null,
  engine: VoiceEngineId = preset.engine
): Promise<void> {
  stopPreview();

  if (engine === 'device' || preset.engine === 'device') {
    const synth = window.speechSynthesis;
    if (!synth) throw new Error('This browser has no built-in speech voices.');
    const utter = new SpeechSynthesisUtterance(PREVIEW_TEXT);
    utter.rate = preset.rateBias;
    utter.pitch = preset.pitch;
    const voice = matchSystemVoice(preset, synth.getVoices(), deviceVoiceURI);
    if (voice) utter.voice = voice;
    synth.speak(utter);
    return;
  }

  // Cache per engine+preset: the same preset sounds different through a relay.
  const cacheKey = `${engine}:${preset.id}`;
  let url = cache.get(cacheKey);
  if (!url) {
    const result =
      engine === 'premium'
        ? await generatePremium(PREVIEW_TEXT, preset)
        : await kokoroClient.generate(
            PREVIEW_TEXT,
            preset.kokoroVoice ?? 'af_heart',
            preset.rateBias
          );
    url = URL.createObjectURL(result.blob);
    cache.set(cacheKey, url);
  }

  const audio = new Audio(url);
  current = audio;
  await audio.play();
}
