/**
 * In-browser voice verification, and the measurement that justifies threading.
 *
 * `verify:voice` proves the model speaks under Node on a CPU. That is not the
 * same as proving it speaks *in a browser*, which is where every reader
 * actually runs it: different runtime, different threading, and a
 * cross-origin isolated page whose fetches behave differently from Node's.
 *
 * So this drives the real app in Chromium twice - once isolated (threads) and
 * once not (one thread) - and reports the real-time factor of each. The second
 * pass exists because "threads make it faster" is a claim, and a claim about
 * performance that nobody measured is just a hope with a commit message.
 *
 * Separate from `test:e2e` because each pass downloads ~92 MB.
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

/**
 * One full run: load the app, get the model, synthesise a preview, and read
 * back what the engine says about itself.
 *
 * `isolate: false` sets the same flag the app writes when it gives up on
 * isolation, which keeps the page single-threaded without touching any code
 * paths a real user would not hit.
 */
const SAMPLE = `Chapter One

The harbour bell rang twice before the fog lifted. Marcus stood at the rail and watched the water turn from grey to silver, and said nothing at all for a long while.

"We should go now," said Marcus. Elena shook her head.

"Not yet," Elena replied. "The tide is wrong, and you know it."

He did know it. He had known it since the morning, when the gulls had gone quiet and the water began to move the wrong way against the harbour wall.

Chapter Two

By evening the wind had changed. Elena climbed the stair to the lantern room and lit the wick with hands that did not shake, and the light swung out across the water.`;

/**
 * Does preparation keep running when the app is not in front of you?
 *
 * Be precise about what this can and cannot show. A headless browser has no
 * window manager, so a tab never really goes to the background: bringing
 * another page to the front leaves `visibilityState` at "visible", and the
 * throttling a real phone applies never happens here. Asserting "the page was
 * hidden" in this environment asserts a lie.
 *
 * What is testable, and is what the feature actually rests on:
 *
 * - the app holds an audio session for the duration, which is the mechanism
 *   that stops a mobile browser suspending the page at all;
 * - the loop keeps completing sections when the page is told it is hidden,
 *   so nothing in our own code pauses on visibilitychange.
 *
 * Whether Android then honours the audio session is Android's contract, not
 * something any browser on a CI runner can answer - that one is verified on a
 * real phone.
 */
async function checkBackgroundPrepare(page, ctx) {
  await page.click('nav.nav >> text=Library');
  await page.click('text=Add something to read');
  await page.waitForSelector('.chip-row');
  await page.click('text=Paste text');
  await page.fill('#ptitle', 'Background Test');
  await page.fill('#ptext', SAMPLE);
  await page.click('text=Prepare for listening');
  await page.waitForSelector('.reader', { timeout: 20000 });

  await page.click('text=Prepare audio');
  await page.waitForSelector('.sheet');
  // Target the chip itself. A bare text selector also matches the explanatory
  // copy in the sheet ("Start a whole document, then lock the phone..."), and
  // clicking a paragraph silently does nothing - which is exactly how this
  // failed the first time.
  await page.locator('.sheet .chip', { hasText: 'Whole document' }).first().click();
  await page.getByRole('button', { name: 'Prepare whole document' }).click({ timeout: 20000 });

  const readProgress = async () =>
    await page.evaluate(() => {
      const match = /(\d+)\s*\/\s*(\d+)\s*\(\d+%\)/.exec(document.body.innerText);
      return match ? { done: Number(match[1]), total: Number(match[2]) } : null;
    });

  // Wait until it has actually started, so we measure progress and not startup.
  const startDeadline = Date.now() + 120000;
  let started = null;
  while (Date.now() < startDeadline && !started) {
    started = await readProgress();
    if (!started) await page.waitForTimeout(1000);
  }
  if (!started) return { ok: false, why: 'preparation never reported progress' };

  // The mechanism: an audio session is what keeps a backgrounded page alive.
  const session = await page.evaluate(() => ({
    state: navigator.mediaSession?.playbackState ?? 'unsupported',
    title: navigator.mediaSession?.metadata?.title ?? '',
    playingAudio: [...document.querySelectorAll('audio[data-narrato="keep-alive"]')].some(
      (a) => !a.paused
    ),
  }));

  // Tell the page it is hidden and put another tab in front. The second part
  // is theatre in headless; the first part exercises our own code.
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const hiddenAt = await readProgress();
  await other.waitForTimeout(25000);
  const afterHidden = await readProgress();
  await other.close();
  await page.bringToFront();

  return {
    ok: true,
    session,
    advanced: (afterHidden?.done ?? 0) > (hiddenAt?.done ?? 0),
    from: hiddenAt,
    to: afterHidden,
  };
}

async function runPass({ isolate, label, background = false }) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    console.log(`  [requestfailed] ${r.url().slice(0, 120)} - ${r.failure()?.errorText}`);
  });

  if (!isolate) {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('narrato.coi.disabled', '1');
      } catch {
        /* nothing to do */
      }
    });
  }

  console.log(`\n--- ${label} ---`);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (isolate) {
    await page
      .waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 })
      .catch(() => {});
  }

  const isolated = await page.evaluate(() => window.crossOriginIsolated === true);

  // Navigate the way a person does: a hash-only goto can resolve before the
  // screen has rendered. Selecting the engine is what starts the download.
  await page.click('nav.nav >> text=Voices');
  await page.waitForSelector('text=Voice engine', { timeout: 20000 });
  await page.click('.card >> text=Kokoro AI', { timeout: 20000 });
  const startButton = page.locator('text=Download the free voice model');
  if (await startButton.isVisible().catch(() => false)) await startButton.click();

  // Three outcomes matter and only one is success: ready, an error, or the app
  // abandoning isolation. Waiting only for success turns the other two into a
  // silent timeout that explains nothing.
  const deadline = Date.now() + 10 * 60 * 1000;
  let outcome = { ok: false, why: 'timed out waiting for the engine' };
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        ready: document.body.innerText.includes('Voice engine ready'),
        text: document.body.innerText.slice(0, 300).replace(/\s+/g, ' '),
        stillIsolated: window.crossOriginIsolated === true,
        errored: document.body.innerText.includes('could not be downloaded'),
      }))
      .catch(() => null);
    if (!state) {
      await page.waitForTimeout(2000);
      continue;
    }
    if (state.ready) {
      outcome = { ok: true };
      break;
    }
    if (state.errored) {
      outcome = { ok: false, why: `engine error: ${state.text}` };
      break;
    }
    if (isolate && !state.stillIsolated) {
      outcome = { ok: false, why: 'the app abandoned isolation - the model fetch failed under COEP' };
      break;
    }
    await page.waitForTimeout(2000);
  }

  if (!outcome.ok) {
    await ctx.close();
    return { ok: false, why: outcome.why, isolated };
  }

  // Synthesise something real, then read the measurement off the engine.
  await page.locator('[aria-label^="Preview "]').first().click();

  await page.click('nav.nav >> text=Settings');
  const diagSwitch = page.locator('[aria-label="Show diagnostics"]').first();
  if (!(await diagSwitch.isChecked().catch(() => false))) await diagSwitch.click();

  let rtf = 0;
  const rtfDeadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < rtfDeadline && !rtf) {
    const body = await page.textContent('body');
    rtf = Number(/Real-time factor:\s*([\d.]+)x/.exec(body ?? '')?.[1] ?? 0);
    if (!rtf) await page.waitForTimeout(2000);
  }

  const threadLine = (await page.textContent('[data-testid="diag-threads"]')) ?? '';
  const threads = Number(/CPU threads:\s*(\d+)/.exec(threadLine)?.[1] ?? 0);
  const cores = await page.evaluate(() => navigator.hardwareConcurrency ?? 0);

  const backgroundResult = background ? await checkBackgroundPrepare(page, ctx) : null;

  await ctx.close();
  return { ok: true, isolated, rtf, threads, cores, errors, threadLine, backgroundResult };
}

// --- the configuration real users get ---
const fast = await runPass({
  isolate: true,
  label: 'isolated: the default a reader gets',
  background: true,
});
check('the model downloads and initialises inside the browser', fast.ok, fast.why ?? '');
if (!fast.ok) {
  await browser.close();
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}
check('isolation survived the model download', fast.isolated, 'COEP blocked the model fetch');
check('a preview actually synthesised speech in the browser', fast.rtf > 0, `rtf ${fast.rtf}`);

// Assert the policy rather than a number: a CI runner has far fewer cores
// than a phone, and "more than one thread" would fail on a 2-core box for a
// reason that has nothing to do with the code under test.
const expected = fast.cores < 2 ? 1 : Math.max(1, Math.min(4, Math.floor(fast.cores / 2)));
console.log(`diagnostics: ${fast.threadLine}`);
check(
  `the engine took the threads the policy allows (${fast.threads} of ${fast.cores} cores)`,
  fast.threads === expected,
  `expected ${expected}`,
);
check('no console errors during the run', (fast.errors ?? []).length === 0,
  (fast.errors ?? []).slice(0, 2).join(' | '));

// --- preparing a book while the app is not in front ---
const bg = fast.backgroundResult;
check('background preparation started', bg?.ok === true, bg?.why ?? '');
if (bg?.ok) {
  check(
    'an audio session is held while preparing, which is what survives backgrounding',
    bg.session.state === 'playing' && bg.session.playingAudio,
    JSON.stringify(bg.session),
  );
  check(
    'and the notification says what it is doing',
    /preparing/i.test(bg.session.title),
    bg.session.title || '(no metadata)',
  );
  console.log(
    `background progress: ${bg.from?.done ?? '?'}/${bg.from?.total ?? '?'} -> ` +
      `${bg.to?.done ?? '?'}/${bg.to?.total ?? '?'} after the page was told it is hidden`
  );
  check(
    'preparation keeps completing sections once the page reports itself hidden',
    bg.advanced,
    'nothing completed in 25 seconds',
  );
}

// --- the same machine, single-threaded, for comparison ---
const slow = await runPass({ isolate: false, label: 'un-isolated: one thread, for comparison' });
check('the un-isolated path still works', slow.ok && slow.rtf > 0, slow.why ?? `rtf ${slow.rtf}`);
check('and is single-threaded, as expected', slow.threads === 1, slow.threadLine ?? '');

if (fast.rtf && slow.rtf) {
  const speedup = fast.rtf / slow.rtf;
  console.log(
    `\nreal-time factor: ${slow.rtf.toFixed(2)}x on 1 thread -> ${fast.rtf.toFixed(2)}x on ` +
      `${fast.threads} (${speedup.toFixed(2)}x faster) on a ${fast.cores}-core runner`
  );
  // Reported, not gated: the size of the win is a property of the machine.
  // Only a *slowdown* would mean the change was not worth making.
  check(
    'threading did not make generation slower',
    speedup > 0.95,
    `${speedup.toFixed(2)}x - threads cost more than they returned here`,
  );
}

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
