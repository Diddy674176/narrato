import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.NARRATO_URL ?? 'http://localhost:4173/narrato/';
const SHOT = process.env.NARRATO_SHOTS ?? '.screenshots';

const SAMPLE = `Chapter One

The harbour bell rang twice before the fog lifted. Marcus stood at the rail and watched the water turn from grey to silver.

"We should go now," said Marcus. Elena shook her head.

"Not yet," Elena replied. "The tide is wrong, and you know it."

He did know it. He had known it since the morning, when the gulls had gone quiet.

Chapter Two

By evening the wind had changed. Elena climbed the stair to the lantern room and lit the wick with hands that did not shake.

"We wait for dawn," Elena said. Marcus did not argue.`;

mkdirSync(process.env.NARRATO_SHOTS ?? '.screenshots', { recursive: true });

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
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--use-fake-device-for-media-stream',
  ],
});

const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });

// 0. Cross-origin isolation: the service worker adds the two headers the host
// will not, and the app reloads once to pick them up. Without this the voice
// model is stuck on a single CPU core, so it is worth asserting rather than
// assuming - it is invisible when it silently stops working.
await page
  .waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 20000 })
  .catch(() => {});
const isolation = await page.evaluate(() => ({
  isolated: window.crossOriginIsolated === true,
  sab: typeof SharedArrayBuffer !== 'undefined',
  controlled: !!navigator.serviceWorker.controller,
}));
check('service worker took control', isolation.controlled);
check('page is cross-origin isolated', isolation.isolated, JSON.stringify(isolation));
check('SharedArrayBuffer exists, so WASM threads are possible', isolation.sab);

// 1. Empty library
await page.waitForSelector('.empty h3', { timeout: 15000 });
check('empty state shown', (await page.textContent('.empty h3')).includes('Nothing to listen'));
await page.screenshot({ path: `${SHOT}/01-empty.png` });

// 2. Add -> paste
await page.click('text=Add something to read');
await page.waitForSelector('.chip-row');
await page.click('text=Paste text');
await page.fill('#ptitle', 'The Lantern Room');
await page.fill('#ptext', SAMPLE);
await page.click('text=Prepare for listening');

// 3. Reader opens
await page.waitForSelector('.reader', { timeout: 20000 });
const title = await page.textContent('.topbar h1');
check('reader opened with title', title === 'The Lantern Room', `got "${title}"`);

const readerText = await page.textContent('.reader');
check('body text rendered', readerText.includes('The harbour bell rang twice'));
check('chapter heading present', (await page.$$('.reader h3')).length > 0);

const chapterLine = await page.textContent('.container .small.muted');
check('two chapters detected', /of 2/.test(await page.textContent('.container')), '');
await page.screenshot({ path: `${SHOT}/02-reader.png` });

// 4. Library persisted
await page.click('nav.nav >> text=Library');
await page.waitForSelector('.doc-card');
check('document in library', (await page.textContent('.doc-card')).includes('The Lantern Room'));
await page.screenshot({ path: `${SHOT}/03-library.png` });

// 5. Voices screen
await page.click('nav.nav >> text=Voices');
await page.waitForSelector('text=Voice engine');
const voiceCards = await page.$$('.stack .card');
check('voice presets listed', voiceCards.length > 10, `got ${voiceCards.length}`);
check('grade badge shown', (await page.textContent('.container')).includes('Audiobook Narrator'));
await page.screenshot({ path: `${SHOT}/04-voices.png` });

// 6. Switch to device voices (no big download) and confirm presets change
await page.click('text=Device voices');
await page.waitForTimeout(400);
check(
  'device presets shown',
  (await page.textContent('.container')).includes('Device Default'),
);

// 7. Settings screen
await page.click('nav.nav >> text=Settings');
await page.waitForSelector('text=Appearance');
check('settings rendered', (await page.textContent('.container')).includes('Cached audio'));
await page.click('text=Light');
await page.waitForTimeout(300);
const theme = await page.getAttribute('html', 'data-theme');
check('light theme applied', theme === 'light', `got ${theme}`);
await page.screenshot({ path: `${SHOT}/05-settings-light.png` });
await page.click('text=Dark');

// 8. Reopen document and confirm position/state survives a reload
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.doc-card', { timeout: 15000 });
check('library persisted across reload', (await page.$$('.doc-card')).length >= 1);

await page.click('.doc-card');
await page.waitForSelector('.reader', { timeout: 20000 });
check('reopened into reader', (await page.textContent('.reader')).includes('harbour bell'));

// 9. Player sheet opens and transport renders
await page.click('.mini-player .doc-cover');
await page.waitForSelector('.player-sheet', { timeout: 10000 });
check('player sheet open', (await page.$$('.play-btn')).length === 1);
check('speed chips present', (await page.textContent('.player-sheet')).includes('1.5x'));
await page.screenshot({ path: `${SHOT}/06-player.png` });

// 10. Chapters list navigates
await page.click('text=Chapters');
await page.waitForSelector('.sheet');
const chapterButtons = await page.$$('.sheet .doc-card');
check('chapter list populated', chapterButtons.length === 2, `got ${chapterButtons.length}`);
await page.screenshot({ path: `${SHOT}/07-chapters.png` });

// 11. Prepare-audio sheet is reachable and reports cached state
await page.click('.sheet .doc-card >> nth=0');
// Selecting a chapter closes the chapter list but leaves the player covering
// the reader, so dismiss it before reaching for the reader's own controls.
await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 });
await page.click('.player-sheet .icon-btn >> nth=0');
await page.waitForSelector('.player-sheet', { state: 'detached', timeout: 10000 });
await page.waitForSelector('.reader', { timeout: 10000 });
await page.click('text=Prepare audio');
await page.waitForSelector('.sheet');

// The engine was switched to device voices earlier in this run, where there is
// nothing to generate ahead of time - the sheet should say so rather than
// offering a button that cannot work.
const deviceText = await page.textContent('.sheet');
check(
  'prepare sheet explains device voices cannot be prepared',
  deviceText.includes('nothing to prepare in advance'),
  deviceText.slice(0, 80),
);
await page.click('.sheet .icon-btn >> nth=0');
await page.waitForSelector('.sheet', { state: 'detached' });

// Switch back to the on-device AI engine, where preparing is meaningful.
await page.click('nav.nav >> text=Voices');
await page.waitForSelector('text=Voice engine');
await page.click('text=Kokoro AI');
await page.click('nav.nav >> text=Reader');
await page.waitForSelector('.reader', { timeout: 10000 });
await page.click('text=Prepare audio');
await page.waitForSelector('.sheet');
const prepareText = await page.textContent('.sheet');
check(
  'prepare sheet offers chapter and whole-document scopes',
  prepareText.includes('This chapter') && prepareText.includes('Whole document'),
  prepareText.slice(0, 80),
);
check(
  'and says up front that preparing can be left running',
  /lock the phone|something else/i.test(prepareText),
  'a reader who does not know they can walk away will sit and watch a progress bar',
);

// The cached count is read from IndexedDB, so wait for it rather than racing it.
const cachedLine = await page
  .waitForSelector('text=sections already prepared', { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
check('prepare sheet reports how much is already cached', cachedLine,
  (await page.textContent('.sheet')).slice(0, 120));
await page.screenshot({ path: `${SHOT}/08-prepare.png` });
await page.click('.sheet .icon-btn >> nth=0');

// 12. Offline-library controls: budget ceiling and per-book keep-offline
await page.click('nav.nav >> text=Settings');
await page.waitForSelector('text=Storage');
const budgetSlider = await page.$('#budget');
check('storage budget control exists', budgetSlider !== null);
if (budgetSlider) {
  const max = await budgetSlider.getAttribute('max');
  check('budget can be raised to 10 GB', max === '10', `max=${max}`);
  await page.fill('#budget', '10');
  await page.waitForTimeout(300);
  const label = await page.textContent('label[for="budget"]');
  check('the chosen budget is shown', /10 GB/.test(label), label);
  const settingsText = await page.textContent('.container');
  check(
    'the budget is explained in books, not just bytes',
    /full-length books/.test(settingsText),
  );
}

await page.click('nav.nav >> text=Library');
await page.waitForSelector('.doc-card');
await page.click('.icon-btn[aria-label^="Options for"]');
await page.waitForSelector('.sheet');
const menuText = await page.textContent('.sheet');
check('a book can be kept offline', /Keep offline/.test(menuText), menuText.slice(0, 120));
await page.click('text=Keep offline');
await page.waitForTimeout(400);
check(
  'kept books are marked in the library',
  (await page.textContent('.doc-card')).includes('\u2B07'),
  await page.textContent('.doc-card'),
);
await page.screenshot({ path: `${SHOT}/13-offline-library.png` });

// 14. Preparation survives the sheet that started it.
//
// The run used to belong to the sheet, so closing it cancelled an hour of
// generating - and there was nowhere else in the app to see that anything was
// happening.
//
// Holding the model request open is what keeps a job running here: this
// environment cannot download the model, and a generation that fails
// instantly would end the job for reasons that have nothing to do with the
// sheet. The route has to be in place before the page loads, since the app
// starts loading the model on open - hence the reload.
await page.route('**huggingface.co/**', () => {
  /* never resolved: the engine stays loading, so generation stays pending */
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.doc-card', { timeout: 20000 });
await page.click('.doc-card');
await page.waitForSelector('.reader', { timeout: 20000 });
await page.click('text=Prepare audio');
await page.waitForSelector('.sheet');
await page.locator('.sheet .chip', { hasText: 'Whole document' }).first().click();
await page.getByRole('button', { name: 'Prepare whole document' }).click();

await page.waitForSelector('[data-testid="prepare-bar"]', { timeout: 10000 });
check('preparing shows an app-wide progress bar', true);

await page.click('.sheet .icon-btn >> nth=0');
await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 });
await page.waitForTimeout(500);
check(
  'closing the sheet does not cancel the run',
  await page.locator('[data-testid="prepare-bar"]').isVisible(),
  'an hour of generating should not end because a sheet was dismissed',
);

await page.click('nav.nav >> text=Library');
await page.waitForTimeout(400);
check(
  'and progress is visible from other screens',
  await page.locator('[data-testid="prepare-bar"]').isVisible(),
);
const barText = await page.textContent('[data-testid="prepare-bar"]');
check('the bar names the book being prepared', /Lantern Room/.test(barText), barText);
check('and offers a way to stop it', /Stop/.test(barText), barText);

// Cancellation is checked between sections, so a section already being
// generated has to finish first - here it never will, because the model
// request is stalled on purpose. What matters is that the press is
// acknowledged rather than appearing to do nothing.
await page.click('[data-testid="prepare-bar"] >> text=Stop');
await page.waitForTimeout(500);
const stoppingText = await page.textContent('[data-testid="prepare-bar"]');
check(
  'pressing stop is acknowledged immediately',
  /stopping/i.test(stoppingText),
  stoppingText,
);
await page.screenshot({ path: `${SHOT}/14-prepare-bar.png` });
await page.unroute('**huggingface.co/**');

const realErrors = errors.filter(
  (e) => !/favicon|manifest|Download the React DevTools/i.test(e),
);
check('no console errors', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
