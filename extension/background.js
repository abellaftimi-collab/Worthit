/*
 * Worthit — service worker
 * Seul rôle : appeler l'agent Worthy (/api/chat) pour le compte du content script.
 * On passe par le worker parce que, en MV3, un fetch cross-origin depuis un content
 * script est soumis au CORS de la page marchande ; depuis le worker, les host_permissions
 * du manifest le débloquent proprement.
 */
const ORIGINES_AUTORISEES = [
  'https://worthit-bi9e.onrender.com',
  'http://localhost:3000',
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'worthy-nudge') return;
  const base = String(msg.apiBase || '').replace(/\/+$/, '');
  // On ne parle qu'à des origines connues : jamais à une URL arbitraire venue d'ailleurs.
  if (ORIGINES_AUTORISEES.indexOf(base) === -1) { sendResponse({ error: 'origine_non_autorisee' }); return; }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000); // Worthy doit être rapide ; sinon on abandonne.
  fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg.body || {}),
    signal: ctrl.signal,
  })
    .then((r) => r.json())
    .then((d) => sendResponse({ reply: d && d.reply, source: d && d.source }))
    .catch((e) => sendResponse({ error: e.message || 'reseau' }))
    .finally(() => clearTimeout(t));

  return true; // réponse asynchrone
});
