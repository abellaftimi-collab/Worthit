/* Passerelle d'API : Safari expose 'browser', Chrome/Edge exposent 'chrome'.
 * Un seul point d'entrée évite de dupliquer le code par navigateur. */
const wapi = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/* Worthit — popup de réglages (wapi.storage.sync) */
let cfg = { enabled: true, pauseAll: true, hideResults: true, blockSearch: true, blockSites: true, pauseSeconds: 60, strictMode: false, pin: '', keywords: [], priceLimit: 0, lang: '' };

const $ = (id) => document.getElementById(id);
const wt = (cle, vars) => self.WorthitI18n.t(cle, vars);

/* Remplit tous les libellés marqués data-i18n / data-i18n-ph. Appelé une première fois
 * avec la langue du navigateur, puis à nouveau quand la langue du compte est connue. */
function appliquerTraductions() {
  document.documentElement.lang = self.WorthitI18n.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = wt(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = wt(el.dataset.i18nPh); });
}
appliquerTraductions();

function save() {
  wapi.storage.sync.set({ worthitCfg: cfg });
}
function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  if (!cfg.keywords.length) {
    const vide = document.createElement('span');
    vide.style.cssText = 'font-size:11px;color:rgba(255,255,255,.35);';
    vide.textContent = wt('p.noKeyword');
    box.appendChild(vide);
    return;
  }
  cfg.keywords.forEach((k) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = k + ' ';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = wt('p.remove');
    x.addEventListener('click', () => {
      cfg.keywords = cfg.keywords.filter((w) => w !== k);
      save(); renderChips();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

wapi.storage.sync.get(['worthitCfg'], (r) => {
  if (r && r.worthitCfg) cfg = Object.assign(cfg, r.worthitCfg);
  // La langue choisie dans le compte l'emporte sur celle du navigateur.
  self.WorthitI18n.setLang(cfg.lang);
  appliquerTraductions();
  $('enabled').checked = cfg.enabled;
  $('pauseAll').checked = cfg.pauseAll;
  $('hideResults').checked = cfg.hideResults !== false;
  $('blockSearch').checked = cfg.blockSearch !== false;
  $('blockSites').checked = cfg.blockSites !== false;
  $('priceLimit').value = cfg.priceLimit || '';
  $('pauseSeconds').value = (cfg.pauseSeconds === undefined) ? 60 : cfg.pauseSeconds;
  $('strictMode').checked = !!cfg.strictMode;
  // Le code n'est JAMAIS pré-rempli : un champ mot de passe rempli se lit en deux clics
  // dans les outils de développement, et se réécrit sans connaître l'ancien.
  $('pin').value = '';
  majStrictUI();
  renderChips();
});

/* Le mode strict est « verrouillé » dès qu'il protège vraiment quelque chose : actif ET
 * doté d'un code. Dans cet état, l'affaiblir (le couper, changer ou retirer le code)
 * exige le code actuel — sinon il suffisait de décocher la case pour tout lever. */
function verrouille() { return !!(cfg.strictMode && cfg.pin); }
function majStrictUI() {
  $('currentPinRow').hidden = !verrouille();
  if (!verrouille()) $('currentPin').value = '';
}
function erreurStrict(cle, succes) {
  const el = $('strictErr');
  el.textContent = cle ? wt(cle) : '';
  el.style.color = succes ? '#86efac' : '#f87171';   // confirmation en vert, refus en rouge
}
/* Vérifie le code actuel quand il le faut. Renvoie true si l'action peut se poursuivre. */
function codeActuelValide() {
  if (!verrouille()) return true;
  const saisi = ($('currentPin').value || '').trim();
  if (!saisi) { erreurStrict('p.needCurrent'); return false; }
  if (saisi !== String(cfg.pin)) { erreurStrict('p.wrongCurrent'); $('currentPin').value = ''; return false; }
  return true;
}

$('enabled').addEventListener('change', (e) => { cfg.enabled = e.target.checked; save(); });
$('pauseAll').addEventListener('change', (e) => { cfg.pauseAll = e.target.checked; save(); });
$('hideResults').addEventListener('change', (e) => { cfg.hideResults = e.target.checked; save(); });
$('blockSearch').addEventListener('change', (e) => { cfg.blockSearch = e.target.checked; save(); });
$('blockSites').addEventListener('change', (e) => { cfg.blockSites = e.target.checked; save(); });
$('priceLimit').addEventListener('change', (e) => { cfg.priceLimit = Math.max(0, +e.target.value || 0); save(); });
$('pauseSeconds').addEventListener('change', (e) => { cfg.pauseSeconds = Math.min(600, Math.max(0, +e.target.value || 0)); save(); });
$('strictMode').addEventListener('change', (e) => {
  erreurStrict('');
  if (e.target.checked) {
    // Activer ne retire aucune protection : rien à demander. Mais sans code, le mode
    // strict ne protégerait rien — on refuse, comme le fait déjà l'appli.
    if (!cfg.pin) { e.target.checked = false; erreurStrict('p.needCodeFirst'); return; }
    cfg.strictMode = true; save(); majStrictUI(); return;
  }
  // Désactiver, en revanche, lève la protection : le code actuel est exigé.
  if (!codeActuelValide()) { e.target.checked = true; return; }
  cfg.strictMode = false;
  $('currentPin').value = '';
  save(); majStrictUI();
});

$('pinSave').addEventListener('click', () => {
  erreurStrict('');
  if (!codeActuelValide()) return;                 // changer le code demande l'ancien
  const nouveau = ($('pin').value || '').replace(/\s/g, '').slice(0, 12);
  if (!nouveau) {
    // Champ vide = retirer le code. Le mode strict tombe avec lui, il n'aurait plus de sens.
    cfg.pin = ''; cfg.strictMode = false;
    $('strictMode').checked = false;
    save(); majStrictUI(); erreurStrict('p.pinCleared', true);
    return;
  }
  if (nouveau.length < 4) { erreurStrict('p.pinTooShort'); return; }
  cfg.pin = nouveau;
  $('pin').value = ''; $('currentPin').value = '';
  save(); majStrictUI(); erreurStrict('p.pinSaved', true);
});
function addKw() {
  const v = ($('kw').value || '').trim();
  if (!v) return;
  if (!cfg.keywords.includes(v)) cfg.keywords.push(v);
  $('kw').value = '';
  save(); renderChips();
}
$('add').addEventListener('click', addKw);
$('kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKw(); });
