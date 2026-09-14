# Narrato

Mobile-friendly AI reading app: **upload / paste → listen with natural system voices → highlight as it reads → lock screen & keep going** (best-effort via Media Session + PWA).

**Live (GitHub Pages):** https://diddy674176.github.io/narrato/

> If that URL 404s, enable **Settings → Pages → Source: GitHub Actions** on this repo (the workflow `.github/workflows/deploy-pages.yml` builds and deploys on push to `main`).

## What works (MVP)

| Feature | Status |
|--------|--------|
| Paste text / TXT / PDF (pdf.js) | ✅ |
| Image OCR (tesseract.js, on-device) | ✅ |
| URL article extract (CORS best-effort + paste fallback) | ✅ |
| Queued sentence/paragraph playback | ✅ |
| Speed 0.5×–3× | ✅ |
| Voice presets mapped to system voices + preview | ✅ Adult labels only |
| Live sentence highlight + auto-scroll | ✅ |
| Media Session metadata + play/pause/skip | ✅ |
| IndexedDB library + resume position | ✅ |
| Character voice manager (dialogue split + manual map) | ✅ stub |
| PWA installable | ✅ |
| Premium TTS (ElevenLabs/OpenAI via proxy) | 🔌 config stub — not required |

**Not in this MVP (next):** EPUB, DOCX, richer OCR column layout, emotion-driven delivery, AI explain/study mode, full audiobook pre-generation cache.

## Voice reality

- **Free baseline:** Browser **Web Speech API** (`speechSynthesis`) with friendly preset names mapped to available system voices.
- **Architecture:** `TtsProvider` interface + optional premium provider that returns **audio blobs** played through an `<audio>` element with preload — survives background better than utterance-only on many phones.
- Set `VITE_TTS_PROVIDER` + `VITE_TTS_PROXY_URL` (backend proxy) later. **Do not** ship secret API keys in frontend JS.

## Mobile / lock-screen limits (honest)

- **Android Chrome:** Often continues with screen locked when Media Session is active; **install PWA** for best results. Battery optimization can still kill tabs.
- **iOS Safari:** Web Speech frequently **pauses when the screen locks**. Add to Home Screen helps somewhat; premium audio-element TTS will be more reliable when configured.
- Lock-screen / Bluetooth controls depend on OS + browser support for Media Session action handlers.

## Privacy & legality

- Documents stay **on-device** (IndexedDB).
- No DRM / paywall / password bypass.
- Only process content you are allowed to access.

## Develop

```bash
npm install
npm run dev
```

```bash
npm run build   # output in dist/ with base /narrato/
npm run preview
```

## Stack

Vite + React + TypeScript · pdf.js · tesseract.js · idb · vite-plugin-pwa · GitHub Pages
