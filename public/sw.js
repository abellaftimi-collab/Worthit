/*
 * Worthit — service worker (PWA)
 * Objectif : que l'app s'ouvre même sans réseau, sans jamais servir une version périmée.
 * - Pages (navigation) : réseau d'abord, cache en secours → jamais de version obsolète en ligne.
 * - Fichiers statiques : cache d'abord → démarrage instantané.
 * - /api/ : jamais mis en cache (données personnelles + doivent être fraîches).
 */
const CACHE = 'worthit-v2';
// /vendor/supabase.js fait partie de la coquille : sans lui, l'app hors ligne perdait
// la connexion aux comptes (il venait d'un CDN, injoignable sans réseau).
const SHELL = ['/', '/dashboard', '/favicon.svg', '/manifest.webmanifest', '/vendor/supabase.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(noms.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;         // pas de cache pour l'externe (Supabase, Stripe…)
  if (url.pathname.startsWith('/api/')) return;        // données : toujours le réseau

  // Navigation : réseau d'abord (fraîcheur), cache si hors ligne.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(req, copie)); return r; })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // Statique : cache d'abord, puis réseau (et on garde une copie).
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((r) => {
      if (r && r.status === 200) { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(req, copie)); }
      return r;
    }).catch(() => cached))
  );
});
