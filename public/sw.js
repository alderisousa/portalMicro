// Service worker mínimo — Sprint PWA, Bloco 1 (base instalável).
//
// Propositalmente NÃO implementa cache/offline/estratégia de atualização:
// só existe para satisfazer o critério de instalabilidade (manifest válido
// + service worker registrado com um handler de "fetch") sem risco de
// servir uma versão antiga da aplicação durante a homologação. Todo pedido
// é sempre repassado direto à rede.
self.addEventListener('install', () => {})

self.addEventListener('activate', () => {})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
