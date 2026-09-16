/**
 * In-browser voice verification.
 *
 * `verify:voice` proves the model speaks under Node on a CPU. That is not the
 * same thing as proving it speaks *in a browser*, which is where every user
 * actually runs it - different runtime, different threading, and now a
 * cross-origin isolated page whose fetches behave differently from Node's.
 *
 * So this drives the real app in Chromium: isolate the page, download the
 * model through the browser, and synthesise a preview. It is deliberately
 * separate from `test:e2e` because it downloads ~92 MB.
 */
import { chromium } from 'playwright';

const BASE = process.env.NARRATO_URL ?? 'http://localhost:4173/narrato/';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page
  .waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 })
  .catch(() => {});

const isolated = await page.evaluate(() => window.crossOriginIsolated === true);
check('page is cross-origin isolated before the model loads', isolated);

// --- download the model through the browser ---
// Navigate the way a person does. A hash-only goto can resolve before the
// screen has rendered, which is what made this time out the first time.
await page.click('nav.nav >> text=Voices');
await page.waitForSelector('text=Voice engine', { timeout: 20000 });

// Selecting the Kokoro engine is itself what starts the download; the
// explicit button only exists when the engine is selected but idle.
await page.click('.card >> text=Kokoro AI', { timeout: 20000 });
const startButton = page.locator('text=Download the free voice model');
if (await startButton.isVisible().catch(() => false)) await startButton.click();
console.log('downloading model in-browser (this is the slow part)...');

await page.waitForSelector('text=Voice engine ready', { timeout: 15 * 60 * 1000 });
check('the model downloads and initialises inside the browser', true);

// Under COEP the model request is a cross-origin fetch made without
// credentials. If that were broken, the line above would have timed out - so
// reaching here is the assertion that isolation did not cost us the model.

// --- synthesise something, for real ---
const previewButton = page.locator('[aria-label^="Preview "]').first();
await previewButton.click();
await page.waitForTimeout(45000);

// --- what the engine reports about itself ---
await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle' });
const diagSwitch = page.locator('[aria-label="Show diagnostics"]').first();
if (!(await diagSwitch.isChecked().catch(() => false))) await diagSwitch.click();

const threadLine = await page.textContent('[data-testid="diag-threads"]');
const threads = Number(/CPU threads:\s*(\d+)/.exec(threadLine ?? '')?.[1] ?? 0);
const cores = await page.evaluate(() => navigator.hardwareConcurrency ?? 0);
console.log(`diagnostics: ${threadLine}`);

// Assert the policy, not a number: a CI runner has far fewer cores than a
// phone, and hard-coding "more than one" would fail on a 2-core box for a
// reason that has nothing to do with the code under test.
const expected = cores < 2 ? 1 : Math.max(1, Math.min(4, Math.floor(cores / 2)));
check(
  `the engine took the threads the policy allows (${threads} of ${cores} cores)`,
  threads === expected,
  `${threadLine} - expected ${expected}`,
);
if (cores >= 4) {
  check('which on a machine this size means more than one', threads > 1, String(threads));
} else {
  console.log(`note: ${cores}-core machine, so 1 thread is the correct outcome here`);
}

const rtf = Number(/Real-time factor:\s*([\d.]+)x/.exec(await page.textContent('body'))?.[1] ?? 0);
console.log(`measured real-time factor in-browser: ${rtf || 'not measured'}`);
check(
  'a preview actually synthesised speech in the browser',
  rtf > 0,
  `real-time factor ${rtf} (0 means no generation completed)`,
);

const fatal = errors.filter((e) => !/favicon|manifest/i.test(e));
check('no console errors during the whole run', fatal.length === 0, fatal.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
