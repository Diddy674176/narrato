/**
 * Bundles and runs the end-to-end voice check.
 *
 * Separate from `npm test` because it downloads the ~92 MB Kokoro model and
 * needs network access to Hugging Face.
 */
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'node_modules/.voice-build');
const outfile = resolve(outDir, 'voice-check.mjs');

mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(here, 'voice-check.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  // Keep the native/ONNX dependencies external so Node resolves them normally.
  external: ['kokoro-js', '@huggingface/transformers', 'onnxruntime-node', 'sharp'],
  nodePaths: [resolve(root, 'node_modules')],
  logLevel: 'error',
});

const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root });
rmSync(outDir, { recursive: true, force: true });
process.exit(run.status ?? 1);
