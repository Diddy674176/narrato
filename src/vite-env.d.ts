/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_TTS_PROVIDER?: 'none' | 'elevenlabs' | 'openai';
  readonly VITE_TTS_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * mammoth ships its browser build without type declarations. We only use
 * convertToHtml, so a narrow declaration is better than pulling in `any`.
 */
declare module 'mammoth/mammoth.browser.js' {
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
}
