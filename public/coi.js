/*
 * Cross-origin isolation shim.
 *
 * ONNX Runtime can only use WASM threads when SharedArrayBuffer exists, and
 * SharedArrayBuffer only exists on a cross-origin isolated page. Isolation is
 * granted by two response headers - and GitHub Pages, like most static hosts,
 * lets nobody set headers. So the service worker adds them to its own
 * navigation responses, which is enough: the document is what carries the
 * isolation, and everything else on the page is same-origin.
 *
 * `credentialless` rather than `require-corp` deliberately: the voice model
 * comes from Hugging Face's CDN and OCR data from jsDelivr, and neither is
 * obliged to send us a CORP header. Under credentialless those requests are
 * simply sent without credentials, which is what they are anyway. A browser
 * that does not understand the value ignores it and the page runs uncached -
 * slower, never broken.
 *
 * Navigation responses are not the whole story: a dedicated worker started
 * from an isolated page refuses to load unless its own script response carries
 * the policy too, and the voice model lives in exactly such a worker.
 *
 * This file is imported into the generated Workbox worker (see vite.config).
 */

/** Set when isolation has been blamed for a failed download; see client.ts. */
const DISABLED_CACHE = 'coi-disabled';

/** Headers that grant, and keep, cross-origin isolation. */
function isolate(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Same-origin resources loaded into an isolated page need to say they are
  // happy to be embedded. Workers additionally refuse to start unless they
  // carry the embedder policy themselves - which is what the header above does.
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Prefer the precache, so isolation never costs offline support. */
async function fetchLikeWorkbox(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const sameOrigin = new URL(request.url).origin === self.location.origin;

  // A dedicated worker started from an isolated page is blocked outright
  // (ERR_BLOCKED_BY_RESPONSE) unless its own script response carries the
  // embedder policy. Narrato runs the voice model and the PDF parser in
  // workers, so without this branch isolation silently removes the voice.
  const isWorkerScript =
    sameOrigin && (request.destination === 'worker' || request.destination === 'sharedworker');

  if (request.mode !== 'navigate' && !isWorkerScript) return;

  event.respondWith(
    (async () => {
      if (await caches.has(DISABLED_CACHE)) return fetch(request);

      if (isWorkerScript) {
        return isolate(await fetchLikeWorkbox(request));
      }

      let response;
      try {
        response = await fetch(request);
      } catch {
        // Offline: fall back to the precached shell, still isolated.
        response = await caches.match(new URL('index.html', self.registration.scope).href, {
          ignoreSearch: true,
        });
        if (!response) return new Response('Offline', { status: 503 });
      }
      return isolate(response);
    })()
  );
});
