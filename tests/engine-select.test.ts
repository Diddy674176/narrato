/**
 * Engine selection policy.
 *
 * This decides which backend a device gets, and it is the difference between
 * a flagship phone running the voice model on its GPU and being pinned to the
 * slow path because its user agent says "Android".
 */
import { resolveEnginePreference } from '../src/lib/tts/kokoro/protocol';
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

console.log('--- a flagship phone is not treated as entry-level ---');
{
  // A Galaxy S26 Ultra class device: 8 cores, WebGPU in Chrome.
  const got = resolveEnginePreference(AUTO, FLAGSHIP_PHONE);
  check('a capable phone gets WebGPU, not WASM', got.device === 'webgpu', got.device);
  check(
    'and fp16 rather than a 326 MB fp32 download',
    got.dtype === 'fp16',
    `${got.dtype} - GPUs compute in fp16 natively and the download halves`,
  );
}

console.log('\n--- weaker devices keep the safe path ---');
{
  const budget = resolveEnginePreference(AUTO, BUDGET_PHONE);
  check('a low-core phone stays on WASM', budget.device === 'wasm', budget.device);
  check('with the small quantised weights', budget.dtype === 'q8', budget.dtype);

  const old = resolveEnginePreference(AUTO, OLD_PHONE);
  check('a phone without WebGPU stays on WASM', old.device === 'wasm', old.device);

  const unknown = resolveEnginePreference(AUTO, UNKNOWN_CORES);
  check(
    'an unknown core count is treated conservatively',
    unknown.device === 'wasm',
    'guessing high on an unknown phone risks a 163 MB download it cannot use',
  );
}

console.log('\n--- desktops take the documented fast path ---');
{
  const desktop = resolveEnginePreference(AUTO, DESKTOP);
  check('desktop uses WebGPU', desktop.device === 'webgpu');
  check('desktop uses fp32, where download size matters least', desktop.dtype === 'fp32');

  const oldDesktop = resolveEnginePreference(AUTO, OLD_DESKTOP);
  check('a desktop without WebGPU falls back to WASM + q8',
    oldDesktop.device === 'wasm' && oldDesktop.dtype === 'q8');
}

console.log('\n--- explicit choices are honoured, but never impossible ones ---');
{
  const forcedWasm = resolveEnginePreference({ device: 'wasm', dtype: 'auto' }, FLAGSHIP_PHONE);
  check('choosing WASM overrides the capable-device default', forcedWasm.device === 'wasm');
  check('and takes q8 to match', forcedWasm.dtype === 'q8');

  const forcedGpu = resolveEnginePreference({ device: 'webgpu', dtype: 'auto' }, BUDGET_PHONE);
  check('choosing WebGPU overrides the core-count heuristic', forcedGpu.device === 'webgpu');

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
