/**
 * Test runner.
 *
 * Each suite is bundled with esbuild and executed in Node. The two suites that
 * touch browser-only APIs get stubs injected here rather than in the source,
 * so nothing test-related leaks into the shipped bundle.
 *
 *   npm test            all Node suites
 *   npm test text       one suite by name
 */
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'node_modules/.test-build');

/** Swap the IndexedDB layer and Kokoro worker client for in-memory stubs. */
const stubPlugin = {
  name: 'narrato-test-stubs',
  setup(build) {
    build.onResolve({ filter: /(^|\/)db$/ }, (args) =>
      args.importer.includes(`${resolve(root, 'src/lib')}`)
        ? { path: resolve(here, 'stubs/db.ts') }
        : null
    );
    build.onResolve({ filter: /kokoro\/client$/ }, () => ({
      path: resolve(here, 'stubs/kokoro-client.ts'),
    }));
  },
};

const SUITES = [
  { name: 'text', entry: 'text.test.ts', format: 'esm', stubs: false },
  { name: 'reader', entry: 'reader.test.tsx', format: 'cjs', stubs: false },
  { name: 'select', entry: 'engine-select.test.ts', format: 'esm', stubs: false },
  { name: 'engine', entry: 'engine.test.ts', format: 'esm', stubs: true },
  // Runs against the real IndexedDB code via fake-indexeddb, so no stubs.
  { name: 'storage', entry: 'storage.test.ts', format: 'esm', stubs: false },
  { name: 'keepalive', entry: 'keepalive.test.ts', format: 'esm', stubs: false },
];

const filter = process.argv[2];
const selected = filter ? SUITES.filter((s) => s.name === filter) : SUITES;

if (selected.length === 0) {
  console.error(`Unknown suite "${filter}". Available: ${SUITES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let failed = 0;

for (const suite of selected) {
  const ext = suite.format === 'cjs' ? 'cjs' : 'mjs';
  const outfile = resolve(outDir, `${suite.name}.${ext}`);

  await esbuild.build({
    entryPoints: [resolve(here, suite.entry)],
    bundle: true,
    platform: 'node',
    format: suite.format,
    outfile,
    jsx: 'automatic',
    nodePaths: [resolve(root, 'node_modules')],
    plugins: suite.stubs ? [stubPlugin] : [],
    logLevel: 'error',
  });

  console.log(`\n=== ${suite.name} ===`);
  const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
  if (run.status !== 0) failed++;
}

rmSync(outDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} suite(s) failed.`);
  process.exit(1);
}
console.log('\nAll suites passed.');
