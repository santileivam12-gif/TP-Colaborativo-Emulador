/* Service worker opcional de PokeEmulador.
 * Agrega las cabeceras COOP/COEP para que el navegador permita el multihilo
 * (SharedArrayBuffer). Funciona con Live Server, sin instalar nada. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  let r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;

  // Con COEP "credentialless", los pedidos cruzados van sin cookies
  if (r.mode === 'no-cors') r = new Request(r, { credentials: 'omit' });

  e.respondWith(
    fetch(r)
      .then((resp) => {
        if (resp.status === 0) return resp; // respuesta opaca: se deja pasar tal cual
        const h = new Headers(resp.headers);
        h.set('Cross-Origin-Embedder-Policy', 'credentialless');
        h.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: h,
        });
      })
      .catch((err) => {
        console.error('sw.js:', err);
        return Response.error();
      })
  );
});
