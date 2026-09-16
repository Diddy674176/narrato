# Narrato

Upload a book, PDF, article or photo of a page → pick a natural voice → press Play → put on headphones → lock the phone → keep listening.

**Live:** https://diddy674176.github.io/narrato/

> If that 404s, enable **Settings → Pages → Source: GitHub Actions** on the repo. The workflow in `.github/workflows/deploy-pages.yml` builds and deploys on push to `main`.

---

## What this is

A reading app for people who would rather listen. It turns almost any text into an audiobook-style listening experience using **Kokoro-82M**, a neural TTS model that runs **entirely in your browser** — no account, no API key, no per-character billing, and nothing uploaded.

## Architecture, and one important consequence

Narrato is a **static site with no backend**. That is not a shortcut; it is the design:

- Kokoro runs locally via WebAssembly/WebGPU, so speech generation costs nothing and needs no key.
- Your documents and generated audio live in **IndexedDB on your device** and are never uploaded.
- It deploys to GitHub Pages as plain files.

The consequence: **anything that genuinely requires a server is not included.** There is no account system, no cross-device sync, and no server-side AI. Where a feature needs an external service, the integration is built and the required environment variable is documented (see [Premium voices](#premium-voices)), but it ships disabled.

---

## What works

Everything in this table was built and exercised; see [Testing](#testing) for what is covered automatically.

### Getting content in
| | |
|---|---|
| Paste text | ✅ |
| TXT / Markdown | ✅ (UTF-8, with windows-1252 fallback) |
| PDF | ✅ text extraction with line-structure recovery |
| Scanned PDF | ✅ opt-in OCR, page by page |
| EPUB | ✅ follows the OPF spine; refuses DRM-encrypted files |
| DOCX | ✅ via mammoth, headings preserved |
| Images / screenshots / photos of pages | ✅ on-device OCR, auto-downscaled |
| Web articles | ✅ reader-mode extraction (see [Web pages](#web-pages)) |
| Legacy `.doc` | ❌ explicit error telling you to save as `.docx` |

### Listening
| | |
|---|---|
| Kokoro AI voices, on-device | ✅ 28 voices, 31 named presets |
| Voice preview on every preset | ✅ |
| Device/system voices as fallback | ✅ |
| Speed 0.5×–3× (chips + fine slider) | ✅ pitch-preserved |
| Volume, skip forward/back, chapter nav | ✅ |
| Scrub through the whole document | ✅ |
| Progressive generation + prebuffer | ✅ |
| IndexedDB audio cache with eviction | ✅ |
| Media Session / lock-screen controls | ✅ (see [Background playback](#background-playback-the-honest-version)) |
| Prepare chapter / whole document ahead | ✅ with progress, cancellable, playback keeps priority |
| Sleep timer, incl. end-of-chapter | ✅ fades out rather than cutting |
| Resume exactly where you stopped | ✅ |
| Bookmarks | ✅ |
| Character voices | ✅ conservative detection + manual editing |
| Pronunciation dictionary | ✅ per-book and global |
| Live highlighting + auto-scroll | ✅ sentence / word / paragraph / off |
| Tap any paragraph to start there | ✅ |
| Keyboard shortcuts (desktop) | ✅ space, ←/→, `[`/`]` |
| Dark / light / system theme | ✅ |
| Installable PWA, offline after caching | ✅ |

### Not built
- **AI explain / summarise / flashcards / study mode.** These need an LLM, which needs a server and a key. With no backend there is nowhere to put the key safely, so rather than ship dead buttons, they are absent.
- **Cross-device sync, accounts, cloud library.** Same reason.
- **Non-English narration.** Kokoro-82M v1.0 via `kokoro-js` is English only (American and British). Narrato detects the document language and other languages still work through **Device voices** if your OS has them installed.
- **PDF page rendering in the reader.** Text is extracted and shown in a clean reading view; the original page images are not displayed.

---

## How the audio pipeline works

This is the part that decides whether the app feels like an audiobook or like a robot stuttering, so it is worth describing.

```
document → chapters → sentence-aligned chunks (~700 chars ≈ 25-45s)
                            ↓
              Web Worker (Kokoro, WebGPU → WASM)
                            ↓
        WAV blob → IndexedDB cache → one persistent <audio>
```

**Generation always runs ahead of playback, never in reaction to it.**

- **Prebuffer before the first note.** Pressing Play builds a real buffer (Fast ≈15s / Balanced ≈32s / Smooth ≈60s of audio) before starting, capped at 20s of waiting so a slow device still starts. You see "Generating more audio…", not silence.
- **Buffer target scales with playback rate.** At 2× you burn buffer twice as fast, so the target doubles.
- **Strictly sequential priority.** The chunk you are about to need always outranks anything further ahead, and only one generation is in flight, so a seek is never stuck behind speculative work.
- **It backs off.** Once comfortably ahead (1.6× target) generation pauses — that is what keeps a phone from cooking itself.
- **Chunk size and buffer depth adapt to the device.** A measured real-time factor (audio seconds produced per second of compute) picks 420 / 700 / 950-character chunks, and scales the buffer target: below 1.2x the app banks ~1.8x more audio before starting, because a device under 1.0x can *never* grow its buffer while playing.
- **A book can be prepared while you are doing something else.** Start "Prepare whole document" and the app holds an audio session open (a silent looping track) plus a screen wake lock, so putting the phone down, locking it, or switching apps does not suspend the work - the same mechanism that keeps music playing when you leave a music app. The media notification shows real progress and carries a stop button, because a silent session a user cannot see or cancel is indistinguishable from an app quietly eating their battery. The loop yields through a `MessageChannel` rather than `setTimeout`, since a hidden page has its timers throttled to once a second or once a minute. **Closing the app entirely stops it** - no service worker can host a neural network for half an hour - but nothing is lost: chunks are cached individually, so reopening and pressing prepare again skips everything already done. CI hides the page behind another tab mid-run and asserts sections keep completing.
- **Generation keeps banking while you listen.** The live buffer is sized for ordinary variation; it cannot absorb a phone that throttles when it warms up, or a minute of CPU lost to another app - and when it empties, playback pauses. So once the live buffer is satisfied, a background loop walks forward caching chunks until there are **ten minutes of narration in hand**, yielding to playback before every chunk so a seek is never queued behind speculative work. This costs nothing overall: each chunk is generated exactly once and cached either way, so it only moves the work earlier. It stops on a low battery with no charger, on a full disk, when you stop listening, and when an explicit "prepare this book" takes over. Settings → Diagnostics shows how much is banked.
- **The page makes itself cross-origin isolated, so speech generation is multi-threaded.** ONNX Runtime can only use WASM threads when `SharedArrayBuffer` exists, and that needs two response headers no static host lets you set. The service worker adds them to its own navigation responses (`public/coi.js`), and the app reloads once on first visit to pick them up. `COEP: credentialless` rather than `require-corp`, because the model comes from Hugging Face's CDN and OCR data from jsDelivr and neither owes us a CORP header. Threads are half the cores capped at 4 - saturating every core on a phone buys thermal throttling and a UI thread fighting for time, which is a stutter. If the model ever fails to download on an isolated page, isolation is switched off permanently on that device and the app reloads: speed is never worth a reader that cannot fetch its own voice. CI asserts isolation in a real browser, and that the model still downloads and speaks under it.
- **The model starts loading when the app opens**, not when you press Play, so the first Play is instant on any visit after the weights are cached. That does mean a first visit downloads ~92 MB once with Kokoro selected - the Voices screen shows the progress, and switching to Device voices avoids it entirely.
- **Auto picks the verified backend, not the fastest one.** Auto briefly chose WebGPU on capable phones; a reader on a flagship reported badly distorted speech, so Auto is back to **WASM + q8** everywhere — the path CI exercises on every run. WebGPU stays available in Settings → Diagnostics and is much faster where it works, but nothing available here can verify browser WebGPU output (CI checks the weights on CPU, a different backend), so it is a deliberate choice rather than a default. A phone that chooses WebGPU takes fp16 (163 MB) over fp32 (326 MB); any initialisation failure falls back to WASM + q8. The active precision is part of the audio cache key, so audio generated under one backend is never mixed into a book playing under another.
- **It says so when the device is too slow.** Rather than stalling and apologising, Narrato detects sub-real-time generation up front and offers the two things that help: a bigger pre-roll ("Smooth" start) or the device voice. For reference, a 2-core CI runner measures ~0.99x; ordinary phones and laptops are well above that.
- **Prepare ahead on demand.** "Prepare audio" generates and caches a chapter or the whole document up front, for a flight or a tunnel. It reports progress, can be stopped without losing work, skips anything already cached, and yields to live playback between sections.
- **An offline library, not just a cache.** Storage is capped by a setting you control (up to **10 GB**, roughly 60 hours or ten full-length books), and any book can be marked **Keep offline** so eviction never touches it. Without that, preparing a new book for a trip would silently delete the ones already prepared for it. Settings shows usage per book so you can see what is actually taking room.
- **Storage is sized to real books, and honest when it runs out.** Narration is ~48 KB/s, so a 65,000-word novel is about **1 GB** of cached audio and a 100,000-word one about 1.5 GB. The cache budget is therefore derived from the quota the browser actually offers (60% of it, floor 512 MB) rather than a flat cap that no single book could fit inside. If the browser refuses a write, or one book outgrows the budget, that is surfaced — playback continues, but you are told that sections are no longer being kept for offline use, instead of being left with a half-prepared book that claimed to be ready.
- **Everything is cached** in IndexedDB keyed by document, chunk, voice, engine, text hash and model version. Re-listening never regenerates. Changing voice creates a *parallel* cache instead of destroying the old one.
- **Memory stays bounded.** Only a window around the playhead is held as object URLs; the rest lives in IndexedDB and old URLs are revoked. This is what makes multi-hour books survive on a phone.

### Why one `<audio>` element, not two

The obvious design is A/B double-buffering. Narrato deliberately uses **one persistent element** whose `src` is swapped between chunks, because:

1. Mobile browsers bind the media session — and therefore lock-screen controls and background-audio permission — to the element the user actually gestured on. Recreating elements mid-book is the fastest way to lose the notification and have audio die when the screen locks.
2. Chunks are local blobs, so there is no network latency to hide; the swap costs a few milliseconds of decode.
3. Chunk boundaries fall on sentence and paragraph breaks, where a few milliseconds of gap is indistinguishable from natural narration.

The element is unlocked on first tap by playing a fraction of a second of generated silence — necessary because the first real chunk can take seconds to generate, long after the tap's autoplay permission has expired.

---

## Background playback (the honest version)

This was a priority, and it is implemented as well as the web platform allows — but the platform, not the code, sets the ceiling.

**Android / Chrome — works well.** Audio continues with the screen off, with lock-screen and Bluetooth controls, artwork, titles and a working scrubber. Install as a PWA for the best results; aggressive battery optimisation can still suspend tabs.

**iOS / Safari — works, with caveats.** Playback through the audio element generally continues when the screen locks. Kokoro *generation* is throttled or suspended in the background, so what keeps playing is what was already generated — which is exactly why the buffer targets above exist, and why "Smooth" start mode is worth using before a long locked-screen session.

**Device voices — does not reliably continue.** The Web Speech API is not background-safe on most mobile browsers. This is a limitation of that API, not of Narrato; it is why Kokoro is the default.

The media notification is deliberately kept alive during buffering, so a stall does not make lock-screen controls vanish.

---

## Voice quality

Kokoro publishes a quality grade per voice, and Narrato **shows it on every preset** rather than hiding it, because it is the honest signal for "will this hold up over a 12-hour book". Grade A/B voices (`af_heart`, `af_bella`, `af_nicole`, `bf_emma`) are markedly better than the D-grade ones.

The friendly preset names ("Dark Fantasy Narrator", "Villain Male") are **informed mappings from Kokoro's published voice metadata, not the result of listening to all 28 voices.** Some presets share an underlying voice with a different delivery bias. The underlying voice id is shown next to every preset so you can judge for yourself — use the preview buttons.

All mature/sultry presets are adult voices.

---

## Text handling

The biggest cause of robotic-sounding TTS is dirty text, not the model. Before anything is spoken, Narrato:

- rejoins words hyphenated across line breaks (`care-\nfully` → `carefully`) while keeping real compounds
- rejoins lines soft-wrapped mid-sentence, conservatively enough that lists, headings and verse survive
- detects and removes running headers/footers by frequency across pages
- drops standalone page numbers and duplicated lines
- splits sentences without tripping on `Dr.`, `3.14`, `J. R. R.`, or ellipses

Chapter detection scores candidate headings rather than trusting one pattern, with a guard against false-positive storms, and falls back to synthetic parts for long heading-less documents.

**Pronunciation rules change only what is spoken** — the reader always shows the author's spelling.

---

## Character voices

Off by default. When enabled, chunks are cut at dialogue boundaries so each chunk is either narration or a single character's speech.

Attribution is **deliberately conservative**: a line is only assigned when the text explicitly says who is speaking (`"…," said Marcus`). Anything ambiguous stays with the narrator, because a wrong voice mid-scene is far more jarring than a narrator voice throughout. Characters with a single attributed line are ignored as likely misfires. Everything is editable — reassign, add a character the detector missed, delete one it invented.

---

## Highlighting accuracy

Kokoro does not emit word timings. Position within a chunk is **interpolated from elapsed time**, which tracks well at sentence granularity and approximately at word granularity. Sentence mode is the default for that reason. Device voices *do* report real word boundaries, so word highlighting is exact there. The app says so in Settings rather than pretending otherwise.

---

## Web pages

A browser usually cannot fetch a third-party page directly because of CORS. The normal workaround is a public relay — which means handing that URL to someone else.

Narrato treats that as **your decision**: it tries a direct fetch first, and only offers the relay (`api.allorigins.win`) afterwards, stating plainly that the address is sent to a third party. Page content is still parsed on your device.

Narrato does not bypass paywalls, logins, DRM or any other access control. Only process material you are allowed to read.

---

## Premium voices

Optional, off by default, and there is **no API key anywhere in this repository** — a static site cannot hold a secret.

To enable, host a small relay that holds your key:

```
POST /speak   { text, voice, provider, speed }  →  audio/mpeg | audio/wav
```

Then set:

```bash
VITE_TTS_PROVIDER=elevenlabs   # or openai
VITE_TTS_PROXY_URL=https://your-relay.example.com/speak
```

A minimal Cloudflare Worker relay:

```js
export default {
  async fetch(request, env) {
    const { text, voice } = await request.json();
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY, // stays on the server
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      }
    );
    return new Response(upstream.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};
```

Premium audio is cached and buffered through the same pipeline as Kokoro.

---

## Privacy

- Documents and generated audio never leave your device.
- No analytics, no accounts, no telemetry.
- Deleting a document deletes its audio with it; Settings → Storage clears all cached audio.
- The only outbound requests are: the voice model from Hugging Face (once), OCR data from jsDelivr (once), and — **only if you explicitly choose it** — a URL sent to the article relay.

---

## Testing

```bash
npm test           # 133 assertions: text pipeline, reader highlighting, playback engine
npm run test:e2e         # 30 assertions: real browser, isolation, full import → listen flow
npm run test:e2e:voice   # downloads the model in-browser and synthesises speech (~92 MB)
npm run verify:voice  # downloads Kokoro and synthesises real speech to a WAV
npm run check      # lint + typecheck + tests
```

- **text** — dehyphenation, wrap rejoining, header stripping, sentence splitting, chapter detection, chunk offset integrity, speaker attribution.
- **reader** — exactly one sentence/word highlighted at a time, in every highlight mode, as playback advances.
- **engine** — prebuffer before play, sequential priority, buffer maintenance and backoff, rate-scaled targets, cache reuse (zero regeneration on replay), bounded memory with URL revocation, retry on transient failure, seeking, and bulk preparation (progress, cancellation, and no regeneration of cached sections). Playback continuity is simulated in accelerated time: a device that generates faster than it plays must produce **zero** interruptions across chunk transitions, a slower-than-real-time device must have its opening absorbed by the prebuffer, and any stall must resume **without the user pressing play again**. Runs against stubbed IndexedDB and a fake Kokoro client with a simulated audio element.
- **select** — engine selection across real device profiles: Auto lands on the verified WASM + q8 path even on a flagship, WebGPU is honoured when chosen but refused when the browser lacks it, and an explicit precision always wins.
- **thread policy** — one thread without isolation whatever the core count, half the cores (capped at 4) with it, and never 0 on a device that will not say how many cores it has.
- **storage** — the real IndexedDB layer under `fake-indexeddb`: eviction deletes the oldest *unpinned* book and never the pinned ones or the one playing, reports when it cannot free enough, per-book usage totals, and budget clamping against both the user's preference and the browser's quota.
- **e2e** — Playwright against a production build: import → reader → library persistence across reload → voices → settings → player → chapters → prepare-audio, asserting no console errors. Also covers theming, full-screen player layout, and horizontal-overflow checks at 320 px and in landscape.

### Hearing it for yourself

`npm run verify:voice` is the end-to-end proof that the AI voice actually speaks. It downloads Kokoro-82M, pushes a deliberately awkward passage (a heading, a hyphen split across a line break, a soft-wrapped sentence, `Dr.`, `3.5`, and dialogue) through the **real** pipeline — `cleanText` → `detectChapters` → `planChunks` → Kokoro — then asserts the result is genuinely continuous speech:

- every chunk is audible (RMS above a silence floor), at 24 kHz
- no chunk contains a gap longer than 1.5s, and neither does the stitched whole
- the narration pace lands in a human range (90–240 wpm)
- each chunk join is a clean break rather than a cut mid-word
- generation is faster than real time, so it can stay ahead of playback

It writes `narrato-voice-sample.wav` so you can simply listen to it.

Real-time factor is **reported, not gated** — it is a property of the machine, not of this code. The check only fails if generation is implausibly slow (below 0.5x), which would indicate something genuinely broken rather than merely modest hardware.

**This runs in CI on every push and pull request** (the `voice` job), and the resulting WAV is uploaded as the `voice-sample` artifact — so the audio is produced by a real run, not asserted in a README.

It could not be run in the development sandbox: `huggingface.co` is blocked there by egress policy, so the model could never download. That is also why the failure path is built out — a clear, actionable message plus a one-tap "Use device voice" fallback that preserves your place.

**Still worth checking on your own phone:** subjective voice quality (preset names are mapped from metadata, not from listening) and lock-screen behaviour, which depends on your specific OS and browser.

---

## Development

```bash
npm install
npm run dev
npm run build    # → dist/, base /narrato/
npm run preview
```

### Layout

```
src/
  lib/
    textProcess.ts     cleaning, sentence splitting
    chapters.ts        heading detection
    chunker.ts         chunk planning, device-adaptive sizing
    dialogue.ts        speaker attribution
    pronunciation.ts   spoken-text rewriting
    db.ts              IndexedDB: library, audio cache, positions, bookmarks
    import/            pdf, epub, docx, txt, ocr, url + dispatcher
    tts/
      voices.ts        preset catalogue + Kokoro quality grades
      preview.ts       per-engine voice previews
      premium.ts       optional relay client
      kokoro/          worker, client, message protocol
    player/
      engine.ts        buffering, queue, caching, transport
      mediaSession.ts  lock-screen metadata and controls
  ui/
    components/        player, reader, voice picker, managers
    screens/           library, add, reader, voices, settings
  state/store.tsx      settings, library, open document
tests/                 text, reader, engine, e2e
scripts/               verify-voice: real Kokoro synthesis + audio assertions
```

## Stack

Vite · React · TypeScript · kokoro-js (Kokoro-82M ONNX) · pdf.js · tesseract.js · mammoth · JSZip · idb · vite-plugin-pwa · GitHub Pages
