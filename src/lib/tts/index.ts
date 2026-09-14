import { createBrowserSpeechProvider } from './browserSpeech';
import { createPremiumTtsProvider } from './premiumStub';
import type { TtsProvider } from './types';

export type { TtsProvider, TtsRequest, TtsResult } from './types';

export function getActiveTtsProvider(): TtsProvider {
  const provider = (import.meta.env.VITE_TTS_PROVIDER as 'elevenlabs' | 'openai' | 'none') || 'none';
  const proxyUrl = import.meta.env.VITE_TTS_PROXY_URL as string | undefined;
  const premium = createPremiumTtsProvider({ provider, proxyUrl });
  if (premium.isAvailable()) return premium;
  return createBrowserSpeechProvider();
}

export function getBrowserProvider() {
  return createBrowserSpeechProvider();
}
