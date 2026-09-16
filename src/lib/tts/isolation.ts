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
const DISABLED_CACHE = 'coi-disabled';

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

function writeFlag(key: string, store: Storage | undefined): void {
  try {
    store?.setItem(key, '1');
  } catch {
    /* private mode: the reload guard degrades to "do not reload" */
  }
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

  writeFlag(DISABLED_FOREVER, window.localStorage);
  try {
    // The worker cannot read localStorage, so the marker it checks is a cache.
    await caches.open(DISABLED_CACHE);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
