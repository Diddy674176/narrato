/**
 * End-to-end voice verification.
 *
 * Runs a passage through Narrato's *real* pipeline - clean -> chapters ->
 * chunk plan -> Kokoro - then checks the resulting audio actually sounds like
 * continuous speech, and writes a WAV you can listen to.
 *
 * This needs the ~92 MB model from Hugging Face, so it is deliberately kept
 * out of `npm test`. Run it with `npm run verify:voice`, or let CI run it and
 * download the `voice-sample` artifact.
 */
import { writeFileSync } from 'node:fs';
import { KokoroTTS } from 'kokoro-js';
import { env as hfEnv } from '@huggingface/transformers';
import { cleanText, countWords } from '../src/lib/textProcess';
import { detectChapters } from '../src/lib/chapters';
import { planChunks, DEFAULT_CHUNK_OPTIONS } from '../src/lib/chunker';
import { getPreset } from '../src/lib/tts/voices';

// Pin the model cache to a predictable directory so CI can cache it between
// runs; transformers.js otherwise hides it inside node_modules, which npm ci
// wipes on every run.
hfEnv.cacheDir = process.env.MODEL_CACHE_DIR ?? '.model-cache';

const SAMPLE_RATE = 24000;
const OUT = process.env.VOICE_OUT ?? 'narrato-voice-sample.wav';
const PRESET_ID = process.env.VOICE_PRESET ?? 'k_audiobook_f';

/**
 * Deliberately awkward source text: a heading, a hyphen split across a line
 * break, a soft-wrapped sentence, an abbreviation, a decimal and dialogue.
 * If the pipeline mangles any of these, it is audible.
 */
const SOURCE = `Chapter One

The harbour bell rang twice before the fog lifted. Dr. Vance counted the
seconds between them, and found the gap had widened to 3.5 since the previous
night. She wrote the number down care-
fully, then closed the book.

"We should go now," said Marcus. Elena shook her head.

"Not yet," Elena replied. "The tide is wrong, and you know it."

He did know it. He had known it since the morning, when the gulls had gone
quiet and the water began to move the wrong way against the harbour wall.`;

let failures = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
};

/** Root-mean-square level: a cheap "is there actually sound here" measure. */
function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Longest run of near-silence, in seconds. Detects stalls and dropouts. */
function longestSilence(samples: Float32Array, threshold = 0.005): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) < threshold) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest / SAMPLE_RATE;
}

function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

async function main(): Promise<void> {
  // --- the app's own text pipeline, unchanged ---
  const cleaned = cleanText(SOURCE);
  check('line-break hyphen rejoined', cleaned.includes('carefully'), cleaned.slice(0, 120));
  check('abbreviation preserved', cleaned.includes('Dr. Vance'));

  const chapters = detectChapters(cleaned, 'Voice check');
  const chunks = planChunks(chapters, DEFAULT_CHUNK_OPTIONS);
  check('produced multiple chunks to stitch', chunks.length >= 2, `chunks=${chunks.length}`);

  const preset = getPreset(PRESET_ID);
  const voice = preset.kokoroVoice ?? 'af_heart';
  console.log(`\nVoice: ${preset.label} (${voice}, Kokoro grade ${preset.quality ?? '?'})`);
  console.log(`Chunks: ${chunks.length}, words: ${countWords(cleaned)}\n`);

  console.log('Loading Kokoro-82M (first run downloads ~92 MB)...');
  const loadStart = Date.now();
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'cpu',
  });
  console.log(`Model ready in ${((Date.now() - loadStart) / 1000).toFixed(1)}s\n`);

  // --- generate every chunk, exactly as the player does ---
  const pieces: Float32Array[] = [];
  let totalGenMs = 0;
  let totalAudioSec = 0;

  for (const chunk of chunks) {
    const started = Date.now();
    const audio = await tts.generate(chunk.text, {
      voice: voice as Parameters<typeof tts.generate>[1] extends { voice?: infer V } ? V : never,
      speed: preset.rateBias,
    });
    const genMs = Date.now() - started;
    totalGenMs += genMs;

    const samples = audio.audio;
    const seconds = samples.length / audio.sampling_rate;
    totalAudioSec += seconds;

    const level = rms(samples);
    check(
      `chunk ${chunk.index} produced audible speech (${seconds.toFixed(1)}s, rms ${level.toFixed(3)})`,
      samples.length > 0 && level > 0.01,
    );
    check(
      `chunk ${chunk.index} has no long internal gap`,
      longestSilence(samples) < 1.5,
      `${longestSilence(samples).toFixed(2)}s of silence`,
    );
    check(
      `chunk ${chunk.index} sample rate is ${SAMPLE_RATE}`,
      audio.sampling_rate === SAMPLE_RATE,
      String(audio.sampling_rate),
    );

    pieces.push(samples);
    process.stdout.write(
      `  chunk ${chunk.index + 1}/${chunks.length}: ${seconds.toFixed(1)}s audio in ${(genMs / 1000).toFixed(1)}s\n`,
    );
  }

  // --- stitch and check the whole thing reads continuously ---
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  const joins: number[] = [];
  for (const piece of pieces) {
    if (offset > 0) joins.push(offset);
    merged.set(piece, offset);
    offset += piece.length;
  }

  const durationSec = merged.length / SAMPLE_RATE;
  const words = countWords(cleaned);
  const wpm = words / (durationSec / 60);

  check('stitched audio is continuous, with no stall', longestSilence(merged) < 1.5,
    `longest silence ${longestSilence(merged).toFixed(2)}s`);
  check(
    `narration pace is human (${wpm.toFixed(0)} wpm)`,
    wpm > 90 && wpm < 240,
    `${words} words in ${durationSec.toFixed(1)}s`,
  );

  // A chunk join should not land in the middle of a word: check the boundary
  // region is quiet-ish, which is what a sentence break sounds like.
  for (const join of joins) {
    const window = Math.round(SAMPLE_RATE * 0.04);
    const level = rms(merged, Math.max(0, join - window), Math.min(merged.length, join + window));
    check(`chunk join at ${(join / SAMPLE_RATE).toFixed(1)}s is a clean break`, level < 0.2,
      `rms ${level.toFixed(3)}`);
  }

  // Real-time factor is a property of the machine, not of this code, so it is
  // reported rather than gated. A 2-core CI runner measures ~0.99x; a phone or
  // laptop is typically several times that. Only an implausibly low number
  // indicates something actually broken (wrong dtype, CPU fallback thrashing).
  const rtf = totalAudioSec / (totalGenMs / 1000);
  check('generation speed is plausible, not broken', rtf > 0.5, `rtf ${rtf.toFixed(2)}x`);
  if (rtf < 1.2) {
    console.log(
      `\nNOTE: this machine generates at ${rtf.toFixed(2)}x real time, so it cannot build a\n` +
        '      buffer while playing. Narrato detects this at runtime and offers "Smooth"\n' +
        '      start or the device voice. Faster hardware will not hit it.',
    );
  }

  writeFileSync(OUT, encodeWav(merged, SAMPLE_RATE));

  console.log(`\nWrote ${OUT} - ${durationSec.toFixed(1)}s of speech, ${(merged.length * 2 / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Real-time factor: ${rtf.toFixed(2)}x (>1 means it can stay ahead of playback)`);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nVoice verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
