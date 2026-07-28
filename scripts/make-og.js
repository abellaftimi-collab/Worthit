/*
 * Génère public/og.png (1200x630, aperçu de lien sur les réseaux) et
 * public/apple-touch-icon.png (180x180) à partir d'un gabarit HTML rendu par Chrome headless.
 *
 *   npm run og
 *
 * Les polices sont relues depuis public/index.html : le visuel reste donc automatiquement
 * fidèle à la marque, sans dupliquer les fichiers de police.
 * Chrome introuvable ? Renseigne son chemin : CHROME_PATH="C:/…/chrome.exe" npm run og
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'worthit-og-'));

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!CHROME) {
  console.error('Chrome/Edge introuvable. Relance avec CHROME_PATH=<chemin vers chrome.exe>');
  process.exit(1);
}

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const faces = html.match(/@font-face\{[\s\S]*?\}/g) || [];
if (!faces.length) throw new Error('aucune @font-face trouvée dans public/index.html');

const shell = (body, w, h) => `<!doctype html><meta charset="utf-8"><style>
${faces.join('\n')}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${w}px;height:${h}px;overflow:hidden}
body{background:#08050f;font-family:'Plus Jakarta Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.d{font-family:'Unbounded','Plus Jakarta Sans',sans-serif}
</style>${body}`;

/* Logo Worthit : le point de la marque est devenu un bouton pause (l'achat suspendu).
 * Une seule source SVG, réutilisée pour l'image de partage et toutes les icônes. */
const LOGO = (taille) => `<svg width="${taille}" height="${taille}" viewBox="0 0 100 100">
  <defs><linearGradient id="lg${taille}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
  <path fill="url(#lg${taille})" fill-rule="evenodd" d="M50 6a44 44 0 1 1 0 88 44 44 0 0 1 0-88Zm-9 27a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Zm18 0a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Z"/>
</svg>`;

const og = shell(`<div style="position:relative;width:1200px;height:630px;overflow:hidden;
  background:radial-gradient(900px 620px at 22% 0%,rgba(124,58,237,.30),transparent 62%),
             radial-gradient(700px 520px at 100% 110%,rgba(167,139,250,.16),transparent 60%),#08050f;
  padding:74px 78px;display:flex;flex-direction:column;justify-content:space-between;">

  <div style="display:flex;align-items:center;gap:13px;">
    <span style="display:flex;filter:drop-shadow(0 0 22px rgba(167,139,250,.7));">${LOGO(32)}</span>
    <span class="d" style="color:#fff;font-size:33px;font-weight:700;letter-spacing:-.02em;">worthit</span>
  </div>

  <div>
    <div style="display:inline-block;padding:9px 19px;border-radius:999px;
      border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.045);
      color:rgba(246,243,251,.72);font-size:20px;font-weight:600;margin-bottom:30px;">
      On the buyer's side, never the seller's
    </div>
    <h1 class="d" style="font-size:97px;font-weight:800;line-height:1.03;letter-spacing:-.035em;color:#f6f3fb;">
      Buy less.<br>
      <span style="background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent;">Live more.</span>
    </h1>
  </div>

  <p style="font-size:29px;line-height:1.45;color:rgba(246,243,251,.62);max-width:930px;">
    A pause between the urge and the purchase: your real budget, an honest question, your call.
  </p>
</div>`, 1200, 630);

const icon = shell(`<div style="width:180px;height:180px;background:#08050f;
  display:flex;align-items:center;justify-content:center;">
  <span style="display:flex;filter:drop-shadow(0 0 34px rgba(167,139,250,.5));">${LOGO(116)}</span>
</div>`, 180, 180);

function shoot(name, source, w, h) {
  const src = path.join(TMP, name + '.html');
  const dest = path.join(PUBLIC, name + '.png');
  fs.writeFileSync(src, source, 'utf8');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--screenshot=${dest}`, `--window-size=${w},${h}`,
    'file:///' + src.replace(/\\/g, '/'),
  ], { stdio: 'pipe', timeout: 120000 });
  console.log(`public/${name}.png — ${w}x${h}, ${(fs.statSync(dest).size / 1024).toFixed(1)} Ko`);
}

/* Icônes PWA. La version « maskable » garde le logo dans la zone sûre (~80 % centrés),
 * sinon Android le rogne quand il applique sa forme (cercle, squircle…). */
const iconePWA = (taille, maskable) => shell(`<div style="width:${taille}px;height:${taille}px;background:#08050f;
  display:flex;align-items:center;justify-content:center;">
  <span style="display:flex;filter:drop-shadow(0 0 ${Math.round(taille * 0.16)}px rgba(167,139,250,.5));">
    ${LOGO(Math.round(taille * (maskable ? 0.56 : 0.70)))}
  </span>
</div>`, taille, taille);

shoot('og', og, 1200, 630);
shoot('apple-touch-icon', icon, 180, 180);
shoot('icon-192', iconePWA(192, false), 192, 192);
shoot('icon-512', iconePWA(512, false), 512, 512);
shoot('icon-maskable-512', iconePWA(512, true), 512, 512);
fs.rmSync(TMP, { recursive: true, force: true });
