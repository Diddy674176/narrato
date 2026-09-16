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
 * This file is imported into the generated Workbox worker (see vite.config).
 */

/** Set when isolation has been blamed for a failed download; see client.ts. */
const DISABLED_CACHE = 'coi-disabled';

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Only the document needs the headers. Leaving every other request alone
  // keeps Workbox's precache routes in charge of offline assets.
  if (request.mode !== 'navigate') return;

  event.respondWith(
    (async () => {
      if (await caches.has(DISABLED_CACHE)) return fetch(request);

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

      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })()
  );
});
