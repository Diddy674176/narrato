/**
 * Cross-origin isolation, from the page's side.
 *
 * The service worker adds the headers (public/coi.js), but the document that
 * asked for them was already fetched without them - so the first load of a
 * session is never isolated. One reload fixes that for good; after it, the
 * response comes through the worker and SharedArrayBuffer exists, which is
 * what lets the voice model use more than one CPU core.
 *
 * Everything here fails safe. If isolation never arrives the app runs exactly
 * as it did before, single-threaded, and if it arrives and breaks the model
 * download it is switched off permanently on this device.
 */

const RELOADED_THIS_SESSION = 'narrato.coi.reloaded';
const DISABLED_FOREVER = 'narrato.coi.disabled';
const DISABLED_AT = 'narrato.coi.disabledAt';
const STRIKES = 'narrato.coi.strikes';
const DISABLED_CACHE = 'coi-disabled';

/** Two failures, not one: a single failed download is usually just the train. */
const STRIKES_BEFORE_ABANDONING = 2;

/** Isolation is worth re-testing eventually; conditions change. */
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function isIsolated(): boolean {
  return typeof window !== 'undefined' && window.crossOriginIsolated === true;
}

export function threadsAvailable(): boolean {
  return isIsolated() && typeof SharedArrayBuffer !== 'undefined';
}

function readFlag(key: string, store: Storage | undefined): boolean {
  try {
    return store?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, store: Storage | undefined, value = '1'): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* private mode: the reload guard degrades to "do not reload" */
  }
}

function readNumber(key: string, store: Storage | undefined): number {
  try {
    return Number(store?.getItem(key) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function clearKeys(keys: string[], store: Storage | undefined): void {
  try {
    for (const key of keys) store?.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Give isolation another chance once the ban is old enough.
 *
 * Whatever made the download fail - a captive portal, a proxy, a bad week for
 * a CDN - is rarely permanent, and a device that silently lost multi-core
 * speech months ago should not be stuck with that forever.
 */
async function expireOldBan(): Promise<void> {
  const disabledAt = readNumber(DISABLED_AT, window.localStorage);
  if (!disabledAt || Date.now() - disabledAt < RETRY_AFTER_MS) return;
  clearKeys([DISABLED_FOREVER, DISABLED_AT, STRIKES], window.localStorage);
  try {
    await caches.delete(DISABLED_CACHE);
  } catch {
    /* the marker stays; isolation simply remains off */
  }
}

/** The engine loaded, so whatever the earlier failures were, they are past. */
export function forgetIsolationStrikes(): void {
  if (typeof window === 'undefined') return;
  clearKeys([STRIKES], window.localStorage);
}

/**
 * Reload once, after the worker takes control, so the document comes back
 * carrying the isolation headers.
 *
 * The session flag is what stops this being a reload loop on a browser that
 * ignores the headers: such a browser reloads once, stays un-isolated, and is
 * left alone for the rest of the session.
 */
export function claimIsolation(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  void expireOldBan();
  if (isIsolated()) return;
  if (readFlag(DISABLED_FOREVER, window.localStorage)) return;
  if (readFlag(RELOADED_THIS_SESSION, window.sessionStorage)) return;

  const reloadIfControlled = (): void => {
    if (!navigator.serviceWorker.controller) return;
    if (readFlag(RELOADED_THIS_SESSION, window.sessionStorage)) return;
    writeFlag(RELOADED_THIS_SESSION, window.sessionStorage);
    window.location.reload();
  };

  void navigator.serviceWorker.ready.then(reloadIfControlled);
  navigator.serviceWorker.addEventListener('controllerchange', reloadIfControlled);
}

/**
 * Turn isolation off for good and reload unisolated.
 *
 * Called when the model download fails on an isolated page: threads are worth
 * having, but not at the price of an app that cannot fetch its own voice.
 * Returns true when a reload has been scheduled, so the caller can stop.
 */
export async function abandonIsolation(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!isIsolated()) return false;
  if (readFlag(DISABLED_FOREVER, window.localStorage)) return false;

  // A download that fails while the device is offline says nothing about
  // isolation, and turning isolation off would not have helped. Blaming it
  // would cost every subsequent launch its threads for no reason.
  if (navigator.onLine === false) return false;

  const strikes = readNumber(STRIKES, window.localStorage) + 1;
  writeFlag(STRIKES, window.localStorage, String(strikes));
  if (strikes < STRIKES_BEFORE_ABANDONING) return false;

  writeFlag(DISABLED_FOREVER, window.localStorage);
  writeFlag(DISABLED_AT, window.localStorage, String(Date.now()));
  try {
    // The worker cannot read localStorage, so the marker it checks is a cache.
    await caches.open(DISABLED_CACHE);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
