/* Worthit — popup de réglages (chrome.storage.sync) */
let cfg = { enabled: true, pauseAll: true, hideResults: true, blockSearch: true, keywords: [], priceLimit: 0 };

const $ = (id) => document.getElementById(id);

function save() {
  chrome.storage.sync.set({ worthitCfg: cfg });
}
function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  if (!cfg.keywords.length) {
    box.innerHTML = '<span style="font-size:11px;color:rgba(255,255,255,.35);">Aucun mot-clé pour l\'instant.</span>';
    return;
  }
  cfg.keywords.forEach((k) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = k + ' ';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Retirer';
    x.addEventListener('click', () => {
      cfg.keywords = cfg.keywords.filter((w) => w !== k);
      save(); renderChips();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

chrome.storage.sync.get(['worthitCfg'], (r) => {
  if (r && r.worthitCfg) cfg = Object.assign(cfg, r.worthitCfg);
  $('enabled').checked = cfg.enabled;
  $('pauseAll').checked = cfg.pauseAll;
  $('hideResults').checked = cfg.hideResults !== false;
  $('blockSearch').checked = cfg.blockSearch !== false;
  $('priceLimit').value = cfg.priceLimit || '';
  renderChips();
});

$('enabled').addEventListener('change', (e) => { cfg.enabled = e.target.checked; save(); });
$('pauseAll').addEventListener('change', (e) => { cfg.pauseAll = e.target.checked; save(); });
$('hideResults').addEventListener('change', (e) => { cfg.hideResults = e.target.checked; save(); });
$('blockSearch').addEventListener('change', (e) => { cfg.blockSearch = e.target.checked; save(); });
$('priceLimit').addEventListener('change', (e) => { cfg.priceLimit = Math.max(0, +e.target.value || 0); save(); });
function addKw() {
  const v = ($('kw').value || '').trim();
  if (!v) return;
  if (!cfg.keywords.includes(v)) cfg.keywords.push(v);
  $('kw').value = '';
  save(); renderChips();
}
$('add').addEventListener('click', addKw);
$('kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') addKw(); });
