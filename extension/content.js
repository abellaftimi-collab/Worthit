/*
 * Worthit — content script
 * 1) Intercepte les clics sur les boutons d'achat et impose l'écran de pause.
 * 2) Masque (floute) les produits contenant tes mots-clés bloqués dans les pages de résultats.
 * 3) Se synchronise automatiquement avec ton compte quand tu visites ton dashboard Worthit.
 * Réglages : popup de l'extension (chrome.storage.sync) + synchro depuis le site.
 */
(function () {
  'use strict';

  const BUY_WORDS = /(ajouter au panier|add to cart|add to bag|add to basket|buy now|acheter|payer maintenant|payer|commander|passer la commande|valider (ma |la )?commande|checkout|proceed to|place order|in den warenkorb|jetzt kaufen|zur kasse|comprar|añadir a la cesta|pagar|in winkelwagen|afrekenen|nu kopen|bestellen)/i;

  let cfg = { enabled: true, pauseAll: true, hideResults: true, blockSearch: true, pauseSeconds: 60, keywords: [], priceLimit: 0 };

  const allowKey = 'worthit_allow_' + location.hostname;

  function isWorthitApp() {
    return document.documentElement.dataset.worthitApp === '1';
  }

  /* ---------- 3) Synchronisation compte → extension (sur le site Worthit uniquement) ---------- */
  function syncFromSite() {
    if (!isWorthitApp()) return;
    try {
      const raw = localStorage.getItem('worthit_ext_sync');
      if (!raw) return;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return;
      const nextKeywords = Array.isArray(d.keywords) ? d.keywords.map(String).slice(0, 50) : cfg.keywords;
      const nextLimit = Math.max(0, +d.priceLimit || 0);
      // Durée du minuteur : bornée 0–600 s pour éviter toute valeur aberrante venue du site.
      const nextPause = (d.pauseSeconds === undefined) ? cfg.pauseSeconds : Math.min(600, Math.max(0, +d.pauseSeconds || 0));
      if (JSON.stringify(nextKeywords) !== JSON.stringify(cfg.keywords) || nextLimit !== cfg.priceLimit || nextPause !== cfg.pauseSeconds) {
        cfg.keywords = nextKeywords;
        cfg.priceLimit = nextLimit;
        cfg.pauseSeconds = nextPause;
        chrome.storage.sync.set({ worthitCfg: cfg });
      }
    } catch (e) {}
  }
  setTimeout(syncFromSite, 1200);
  setInterval(syncFromSite, 4000);

  /* ---------- 2) Masquage des produits contenant un mot-clé bloqué ---------- */
  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.textContent = '.worthit-masked{filter:blur(10px) grayscale(.65) !important;opacity:.4 !important;pointer-events:none !important;user-select:none !important;transition:filter .3s ease;}';
    document.documentElement.appendChild(st);
  }
  const MASK_LIMIT = 80; // garde-fou : jamais plus de 80 éléments masqués sur une même page
  /* Texte représentatif d'un lien. Beaucoup de fiches produit ne contiennent qu'une image :
   * sans aria-label / title / alt, elles seraient totalement invisibles pour le filtre. */
  function linkText(a) {
    let t = (a.innerText || '').trim();
    if (!t) {
      const img = a.querySelector('img[alt]');
      t = (a.getAttribute('aria-label') || a.getAttribute('title') ||
           (img && img.getAttribute('alt')) || '').trim();
    }
    return t.slice(0, 300).toLowerCase();
  }
  function maskProducts() {
    if (!cfg.enabled || !cfg.hideResults || !(cfg.keywords || []).length) return;
    if (isWorthitApp()) return;
    const kws = cfg.keywords.map(k => String(k).toLowerCase()).filter(Boolean);
    if (!kws.length) return;
    injectStyle();
    // budget recalculé à chaque passage : le masquage ne s'épuise plus définitivement
    let budget = MASK_LIMIT - document.querySelectorAll('.worthit-masked').length;
    if (budget <= 0) return;
    const links = document.querySelectorAll('a:not([data-worthit-checked])');
    let checked = 0;
    for (const a of links) {
      if (checked++ > 500) break;
      const t = linkText(a);
      // Pas encore de texte (chargement différé) : on ne le marque pas, on le rejugera au prochain passage.
      if (!t) continue;
      a.setAttribute('data-worthit-checked', '1');
      const hit = kws.find(k => t.includes(k));
      if (!hit) continue;
      const card = a.closest('li,article,[class*="product" i],[class*="item" i],[class*="card" i]') || a;
      if (card.dataset.worthitMasked) continue;
      const r = card.getBoundingClientRect();
      // garde-fou : ne jamais flouter un conteneur qui couvre presque toute la page
      if (r.width > window.innerWidth * 0.92 && r.height > window.innerHeight * 0.7) continue;
      card.dataset.worthitMasked = '1';
      card.classList.add('worthit-masked');
      card.title = 'Masqué par Worthit (mot-clé « ' + hit + ' »)';
      if (--budget <= 0) return;
    }
  }
  let maskTimer = null;
  const mo = new MutationObserver(() => {
    clearTimeout(maskTimer);
    maskTimer = setTimeout(() => { checkBlockedSearch(); maskProducts(); }, 500);
  });
  if (document.body) mo.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body) mo.observe(document.body, { childList: true, subtree: true });
    maskProducts();
  });
  setTimeout(maskProducts, 1500);

  /* ---------- 2 bis) Blocage de la recherche elle-même ----------
   * Plus fort que le floutage : si la requête tapée contient un mot-clé bloqué,
   * on masque toute la page de résultats derrière un écran de pause. */
  const SEARCH_PARAMS = ['q', 'k', 'query', 'search', 'search_text', 'searchterm', 'search_query',
    'keyword', 'keywords', 'text', 'term', '_nkw', 'searchtext', 'wd'];
  const searchAllowKey = 'worthit_search_allow_' + location.hostname;

  function currentSearchQuery() {
    try {
      const p = new URLSearchParams(location.search);
      for (const key of SEARCH_PARAMS) {
        const v = p.get(key);
        if (v && v.trim()) return v.trim();
      }
    } catch (e) {}
    // Certains sites mettent la recherche dans le chemin : /search/nike, /recherche/nike
    const m = location.pathname.match(/\/(?:search|recherche|catalogsearch\/result)\/([^/?#]+)/i);
    if (m) { try { return decodeURIComponent(m[1]).replace(/[-+_]/g, ' '); } catch (e) {} }
    const el = document.querySelector('input[type="search"],input[name="q"],input[name="k"]');
    return el && el.value ? el.value.trim() : '';
  }

  function searchAllowedNow() {
    try { return Date.now() < (+sessionStorage.getItem(searchAllowKey) || 0); } catch (e) { return false; }
  }

  function showSearchBlock(hit, query) {
    if (document.getElementById('worthit-search-block')) return;
    const host = document.createElement('div');
    host.id = 'worthit-search-host';
    host.innerHTML = `
      <div id="worthit-search-block" style="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(5,3,10,.94);backdrop-filter:blur(14px);font-family:'Segoe UI',system-ui,sans-serif;">
        <div style="max-width:430px;width:100%;background:linear-gradient(165deg,#1a102c,#0c0716);border:1px solid rgba(167,139,250,.35);border-radius:22px;padding:32px 28px;box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 50px rgba(124,58,237,.2);animation:worthitPop .45s cubic-bezier(.34,1.56,.64,1) both;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;">
            <span style="width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#7c3aed);box-shadow:0 0 12px rgba(167,139,250,.8);"></span>
            <span style="color:#fff;font-size:16px;font-weight:800;letter-spacing:-.02em;">worthit</span>
            <span style="margin-left:auto;font-size:11px;color:rgba(255,255,255,.4);">Recherche bloquée</span>
          </div>
          <h2 style="color:#fff;font-size:20px;font-weight:800;margin:0 0 12px;line-height:1.35;">Tu cherches « ${esc(query)} ».</h2>
          <p style="color:rgba(255,255,255,.62);font-size:14px;line-height:1.6;margin:0 0 24px;">
            Tu as toi-même bloqué <strong style="color:rgba(255,255,255,.85);">« ${esc(hit)} »</strong> un jour où tu avais les idées claires.<br/>
            Rien n'a changé depuis, à part l'envie du moment.
          </p>
          <div style="display:flex;flex-direction:column;gap:9px;">
            <button id="worthit-sb-leave" style="padding:14px;border-radius:13px;border:none;cursor:pointer;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;font-size:14.5px;font-weight:700;font-family:inherit;">💪 Je fais autre chose</button>
            <button id="worthit-sb-stay" style="padding:12px;border-radius:13px;border:1px solid rgba(255,255,255,.18);cursor:pointer;background:transparent;color:rgba(255,255,255,.75);font-size:13px;font-family:inherit;">Voir quand même (5 min)</button>
          </div>
          <p style="font-size:10.5px;color:rgba(255,255,255,.3);margin:18px 0 0;text-align:center;">Worthit est du côté de l'acheteur, jamais du vendeur.</p>
        </div>
      </div>
      <style>@keyframes worthitPop{from{opacity:0;transform:scale(.6) translateY(30px);}to{opacity:1;transform:scale(1) translateY(0);}}</style>`;
    document.documentElement.appendChild(host);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    const close = () => { host.remove(); document.documentElement.style.overflow = prevOverflow; };
    document.getElementById('worthit-sb-leave').addEventListener('click', () => {
      close();
      if (history.length > 1) history.back(); else location.href = 'about:blank';
    });
    document.getElementById('worthit-sb-stay').addEventListener('click', () => {
      try { sessionStorage.setItem(searchAllowKey, String(Date.now() + 5 * 60 * 1000)); } catch (e) {}
      close();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function checkBlockedSearch() {
    if (!cfg.enabled || cfg.blockSearch === false || isWorthitApp()) return;
    if (!(cfg.keywords || []).length) return;
    if (searchAllowedNow()) return;
    const q = currentSearchQuery().toLowerCase();
    if (!q) return;
    const hit = (cfg.keywords || []).find((k) => k && q.includes(String(k).toLowerCase()));
    if (hit) showSearchBlock(hit, currentSearchQuery());
  }

  // Google & co changent l'URL sans recharger la page : on surveille aussi les changements d'URL.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; checkBlockedSearch(); }
  }, 800);

  /* ---------- 1) Pause à l'achat ---------- */
  function detectPrice(el) {
    const re = /(\d{1,4}(?:[  .,]\d{3})*(?:[.,]\d{2})?)\s?(?:€|EUR)|(?:€|EUR)\s?(\d{1,4}(?:[.,]\d{2})?)/;
    let node = el;
    for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
      const m = (node.innerText || '').match(re);
      if (m) return parseFloat((m[1] || m[2]).replace(/[  ]/g, '').replace(',', '.')) || 0;
    }
    const m = (document.body.innerText || '').match(re);
    return m ? parseFloat((m[1] || m[2]).replace(/[  ]/g, '').replace(',', '.')) || 0 : 0;
  }

  function overlayHtml(price, kwHit, wait) {
    const priceTxt = price > 0 ? `<strong>${price.toLocaleString('fr-FR')} €</strong>` : 'cet achat';
    const reason = kwHit
      ? `Tu as toi-même bloqué le mot-clé <strong>« ${kwHit} »</strong> un jour où tu avais les idées claires.`
      : (cfg.priceLimit > 0 && price >= cfg.priceLimit
        ? `C'est au-dessus de ton seuil de <strong>${cfg.priceLimit} €</strong>.`
        : `L'envie dure moins de 20 minutes. Le regret, lui, revient à chaque relevé de compte.`);
    return `
      <div id="worthit-overlay" style="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(5,3,10,.82);backdrop-filter:blur(6px);font-family:'Segoe UI',system-ui,sans-serif;">
        <div style="max-width:400px;width:100%;background:linear-gradient(165deg,#1a102c,#0c0716);border:1px solid rgba(167,139,250,.35);border-radius:22px;padding:30px 26px;box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 50px rgba(124,58,237,.2);animation:worthitPop .45s cubic-bezier(.34,1.56,.64,1) both;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;">
            <span style="width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#a78bfa,#7c3aed);box-shadow:0 0 12px rgba(167,139,250,.8);"></span>
            <span style="color:#fff;font-size:16px;font-weight:800;letter-spacing:-.02em;">worthit</span>
            <span style="margin-left:auto;font-size:11px;color:rgba(255,255,255,.4);">Pause anti-impulsion</span>
          </div>
          <h2 style="color:#fff;font-size:19px;font-weight:800;margin:0 0 10px;line-height:1.35;">Une seconde. Tu allais dépenser ${priceTxt}.</h2>
          <p style="color:rgba(255,255,255,.62);font-size:14px;line-height:1.6;margin:0 0 22px;">${reason}<br/>Question honnête : besoin réel, ou envie du moment ?</p>
          <div style="display:flex;flex-direction:column;gap:9px;">
            <button id="worthit-wait" style="padding:14px;border-radius:13px;border:none;cursor:pointer;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;font-size:14.5px;font-weight:700;font-family:inherit;">💪 J'attends 24 h</button>
            <button id="worthit-buy" ${wait > 0 ? 'disabled' : ''} style="padding:12px;border-radius:13px;border:1px solid rgba(255,255,255,.18);cursor:${wait > 0 ? 'not-allowed' : 'pointer'};background:transparent;color:rgba(255,255,255,${wait > 0 ? '.38' : '.75'});font-size:13px;font-family:inherit;transition:color .3s ease;">${wait > 0 ? `J'achète dans ${wait} s…` : "J'achète quand même"}</button>
          </div>
          <p style="font-size:10.5px;color:rgba(255,255,255,.3);margin:16px 0 0;text-align:center;">Worthit est du côté de l'acheteur, jamais du vendeur.</p>
        </div>
      </div>
      <style>@keyframes worthitPop{from{opacity:0;transform:scale(.6) translateY(30px);}to{opacity:1;transform:scale(1) translateY(0);}}</style>`;
  }

  function showOverlay(target, price, kwHit) {
    if (document.getElementById('worthit-overlay')) return;
    let wait = Math.min(600, Math.max(0, Math.round(+cfg.pauseSeconds || 0)));
    const host = document.createElement('div');
    host.innerHTML = overlayHtml(price, kwHit, wait);
    document.documentElement.appendChild(host);

    const buyBtn = document.getElementById('worthit-buy');
    // Résister est toujours instantané ; c'est seulement « J'achète quand même » qui doit patienter.
    let timer = null;
    if (wait > 0) {
      timer = setInterval(() => {
        wait--;
        if (wait > 0) {
          buyBtn.textContent = `J'achète dans ${wait} s…`;
        } else {
          clearInterval(timer); timer = null;
          buyBtn.disabled = false;
          buyBtn.textContent = "J'achète quand même";
          buyBtn.style.cursor = 'pointer';
          buyBtn.style.color = 'rgba(255,255,255,.75)';
        }
      }, 1000);
    }
    const cleanup = () => { if (timer) clearInterval(timer); host.remove(); };

    document.getElementById('worthit-wait').addEventListener('click', () => {
      cleanup();
      const badge = document.createElement('div');
      badge.textContent = '🔥 Bien joué. Ta série continue.';
      badge.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#1a102c;border:1px solid rgba(167,139,250,.4);color:#fff;padding:12px 18px;border-radius:999px;font-family:system-ui;font-size:13.5px;box-shadow:0 12px 30px rgba(0,0,0,.5);';
      document.documentElement.appendChild(badge);
      setTimeout(() => badge.remove(), 3500);
    });
    buyBtn.addEventListener('click', () => {
      if (buyBtn.disabled) return; // le minuteur n'est pas terminé
      cleanup();
      try { sessionStorage.setItem(allowKey, String(Date.now() + 10000)); } catch (e) {}
      if (target) target.click();
    });
  }

  document.addEventListener('click', (e) => {
    if (!cfg.enabled || isWorthitApp()) return;
    const btn = e.target && e.target.closest && e.target.closest('button, a, input[type="submit"], [role="button"]');
    if (!btn) return;
    const label = ((btn.innerText || btn.value || btn.getAttribute('aria-label') || '') + '').slice(0, 140);
    if (!BUY_WORDS.test(label)) return;

    let until = 0;
    try { until = +sessionStorage.getItem(allowKey) || 0; } catch (err) {}
    if (Date.now() < until) return;

    const pageText = (document.title + ' ' + location.href + ' ' + label).toLowerCase();
    const kwHit = (cfg.keywords || []).find((k) => k && pageText.includes(String(k).toLowerCase()));
    const price = detectPrice(btn);
    const priceHit = cfg.priceLimit > 0 && price >= cfg.priceLimit;

    if (!(cfg.pauseAll || kwHit || priceHit)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    showOverlay(btn, price, kwHit);
  }, true);

  /* ---------- chargement des réglages (en dernier : toutes les fonctions sont prêtes) ---------- */
  chrome.storage.sync.get(['worthitCfg'], (r) => {
    if (r && r.worthitCfg) cfg = Object.assign(cfg, r.worthitCfg);
    checkBlockedSearch();
    maskProducts();
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.worthitCfg && changes.worthitCfg.newValue) {
      cfg = Object.assign(cfg, changes.worthitCfg.newValue);
      checkBlockedSearch();
      maskProducts();
    }
  });
})();
