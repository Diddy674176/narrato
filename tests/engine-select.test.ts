/**
 * Engine selection policy.
 *
 * This decides which backend a device gets, and it is the difference between
 * a flagship phone running the voice model on its GPU and being pinned to the
 * slow path because its user agent says "Android".
 */
import { resolveEnginePreference, wasmThreadCount } from '../src/lib/tts/kokoro/protocol';
import type { DeviceCapabilities } from '../src/lib/tts/kokoro/protocol';

let failures = 0;
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
};

const AUTO = { device: 'auto', dtype: 'auto' } as const;

/** Real-world device profiles. */
const FLAGSHIP_PHONE: DeviceCapabilities = { hasWebGpu: true, isMobile: true, cores: 8 };
const BUDGET_PHONE: DeviceCapabilities = { hasWebGpu: true, isMobile: true, cores: 4 };
const OLD_PHONE: DeviceCapabilities = { hasWebGpu: false, isMobile: true, cores: 8 };
const DESKTOP: DeviceCapabilities = { hasWebGpu: true, isMobile: false, cores: 12 };
const OLD_DESKTOP: DeviceCapabilities = { hasWebGpu: false, isMobile: false, cores: 4 };
const UNKNOWN_CORES: DeviceCapabilities = { hasWebGpu: true, isMobile: true, cores: 0 };

console.log('--- auto takes the verified path, even on a flagship ---');
{
  // A Galaxy S26 Ultra class device: 8 cores, WebGPU in Chrome. Auto used to
  // hand it WebGPU + fp16; a reader reported badly distorted speech, so auto
  // now picks what CI actually verifies.
  const got = resolveEnginePreference(AUTO, FLAGSHIP_PHONE);
  check(
    'a capable phone gets WASM, not an unverified WebGPU path',
    got.device === 'wasm',
    `${got.device} - fast but distorted speech is worth nothing`,
  );
  check('with the quantised weights CI exercises', got.dtype === 'q8', got.dtype);

  const desktop = resolveEnginePreference(AUTO, DESKTOP);
  check('a desktop with WebGPU is treated the same way', desktop.device === 'wasm', desktop.device);
  check('and also takes q8', desktop.dtype === 'q8', desktop.dtype);
}

console.log('\n--- weaker devices are unchanged ---');
{
  const budget = resolveEnginePreference(AUTO, BUDGET_PHONE);
  check('a low-core phone stays on WASM', budget.device === 'wasm', budget.device);
  check('with the small quantised weights', budget.dtype === 'q8', budget.dtype);

  const old = resolveEnginePreference(AUTO, OLD_PHONE);
  check('a phone without WebGPU stays on WASM', old.device === 'wasm', old.device);

  const oldDesktop = resolveEnginePreference(AUTO, OLD_DESKTOP);
  check('a desktop without WebGPU falls back to WASM + q8',
    oldDesktop.device === 'wasm' && oldDesktop.dtype === 'q8');

  const unknown = resolveEnginePreference(AUTO, UNKNOWN_CORES);
  check('an unknown core count needs no special case now', unknown.device === 'wasm');
}

console.log('\n--- WebGPU is available, but only on purpose ---');
{
  const forcedGpu = resolveEnginePreference({ device: 'webgpu', dtype: 'auto' }, FLAGSHIP_PHONE);
  check('choosing WebGPU is honoured', forcedGpu.device === 'webgpu', forcedGpu.device);
  check(
    'and a phone takes fp16 rather than a 326 MB fp32 download',
    forcedGpu.dtype === 'fp16',
    forcedGpu.dtype,
  );

  const gpuDesktop = resolveEnginePreference({ device: 'webgpu', dtype: 'auto' }, DESKTOP);
  check('a desktop on WebGPU takes fp32, where size matters least',
    gpuDesktop.dtype === 'fp32', gpuDesktop.dtype);

  const forcedWasm = resolveEnginePreference({ device: 'wasm', dtype: 'auto' }, FLAGSHIP_PHONE);
  check('choosing WASM explicitly still works', forcedWasm.device === 'wasm');
  check('and takes q8 to match', forcedWasm.dtype === 'q8');

  // Asking for a backend the browser does not have would fail at load; the
  // policy corrects it rather than handing ONNX Runtime something impossible.
  const impossible = resolveEnginePreference({ device: 'webgpu', dtype: 'auto' }, OLD_PHONE);
  check(
    'WebGPU is refused when the browser lacks it',
    impossible.device === 'wasm',
    impossible.device,
  );
  check('and the dtype follows the real backend', impossible.dtype === 'q8', impossible.dtype);

  const pinned = resolveEnginePreference({ device: 'auto', dtype: 'q4f16' }, DESKTOP);
  check('an explicit precision is always respected', pinned.dtype === 'q4f16', pinned.dtype);
}

console.log('\n--- WASM threads: the biggest speed-up the CPU path has ---');
{
  // Without cross-origin isolation SharedArrayBuffer does not exist, so ONNX
  // Runtime cannot thread at all, whatever the hardware says.
  check('an un-isolated page gets one thread', wasmThreadCount(8, false) === 1);
  check('however many cores it has', wasmThreadCount(16, false) === 1);

  check('an isolated 8-core phone gets 4', wasmThreadCount(8, true) === 4, String(wasmThreadCount(8, true)));
  check(
    'a 16-core desktop is still capped at 4',
    wasmThreadCount(16, true) === 4,
    'more threads on one small model buys contention, not speed',
  );
  check('a 4-core device gets 2', wasmThreadCount(4, true) === 2, String(wasmThreadCount(4, true)));
  check(
    'half the cores, so efficiency cores and the UI still get time',
    wasmThreadCount(6, true) === 3,
    String(wasmThreadCount(6, true)),
  );
  check('a single-core device asks for one', wasmThreadCount(1, true) === 1);
  check('an unknown core count is never 0 threads', wasmThreadCount(0, true) === 1);
  check('and neither is a nonsense one', wasmThreadCount(Number.NaN, true) === 1);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
