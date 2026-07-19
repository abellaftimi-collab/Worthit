/*
 * Worthit — content script
 * Intercepte les clics sur les boutons d'achat et impose l'écran de pause.
 * Réglages (mots-clés, seuil de prix, on/off) : via le popup de l'extension (chrome.storage.sync).
 */
(function () {
  'use strict';

  const BUY_WORDS = /(ajouter au panier|add to cart|add to bag|add to basket|buy now|acheter|payer maintenant|payer|commander|passer la commande|valider (ma |la )?commande|checkout|proceed to|place order|in den warenkorb|jetzt kaufen|zur kasse|comprar|añadir a la cesta|pagar|in winkelwagen|afrekenen|nu kopen|bestellen)/i;

  let cfg = { enabled: true, pauseAll: true, keywords: [], priceLimit: 0 };

  chrome.storage.sync.get(['worthitCfg'], (r) => {
    if (r && r.worthitCfg) cfg = Object.assign(cfg, r.worthitCfg);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.worthitCfg && changes.worthitCfg.newValue) {
      cfg = Object.assign(cfg, changes.worthitCfg.newValue);
    }
  });

  const allowKey = 'worthit_allow_' + location.hostname;

  function detectPrice(el) {
    const re = /(\d{1,4}(?:[  .,]\d{3})*(?:[.,]\d{2})?)\s?(?:€|EUR)|(?:€|EUR)\s?(\d{1,4}(?:[.,]\d{2})?)/;
    let node = el;
    for (let d = 0; d < 6 && node; d++, node = node.parentElement) {
      const m = (node.innerText || '').match(re);
      if (m) return parseFloat((m[1] || m[2]).replace(/[  ]/g, '').replace(',', '.')) || 0;
    }
    const m = (document.body.innerText || '').match(re);
    return m ? parseFloat((m[1] || m[2]).replace(/[  ]/g, '').replace(',', '.')) || 0 : 0;
  }

  function overlayHtml(price, kwHit) {
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
            <button id="worthit-buy" style="padding:12px;border-radius:13px;border:1px solid rgba(255,255,255,.18);cursor:pointer;background:transparent;color:rgba(255,255,255,.75);font-size:13px;font-family:inherit;">J'achète quand même</button>
          </div>
          <p style="font-size:10.5px;color:rgba(255,255,255,.3);margin:16px 0 0;text-align:center;">Worthit est du côté de l'acheteur, jamais du vendeur.</p>
        </div>
      </div>
      <style>@keyframes worthitPop{from{opacity:0;transform:scale(.6) translateY(30px);}to{opacity:1;transform:scale(1) translateY(0);}}</style>`;
  }

  function showOverlay(target, price, kwHit) {
    if (document.getElementById('worthit-overlay')) return;
    const host = document.createElement('div');
    host.innerHTML = overlayHtml(price, kwHit);
    document.documentElement.appendChild(host);
    document.getElementById('worthit-wait').addEventListener('click', () => {
      host.remove();
      const badge = document.createElement('div');
      badge.textContent = '🔥 Bien joué. Ta série continue.';
      badge.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#1a102c;border:1px solid rgba(167,139,250,.4);color:#fff;padding:12px 18px;border-radius:999px;font-family:system-ui;font-size:13.5px;box-shadow:0 12px 30px rgba(0,0,0,.5);';
      document.documentElement.appendChild(badge);
      setTimeout(() => badge.remove(), 3500);
    });
    document.getElementById('worthit-buy').addEventListener('click', () => {
      host.remove();
      try { sessionStorage.setItem(allowKey, String(Date.now() + 10000)); } catch (e) {}
      if (target) target.click();
    });
  }

  document.addEventListener('click', (e) => {
    if (!cfg.enabled) return;
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
})();
