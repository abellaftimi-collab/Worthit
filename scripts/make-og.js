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

const og = shell(`<div style="position:relative;width:1200px;height:630px;overflow:hidden;
  background:radial-gradient(900px 620px at 22% 0%,rgba(124,58,237,.30),transparent 62%),
             radial-gradient(700px 520px at 100% 110%,rgba(167,139,250,.16),transparent 60%),#08050f;
  padding:74px 78px;display:flex;flex-direction:column;justify-content:space-between;">

  <div style="display:flex;align-items:center;gap:13px;">
    <span style="width:19px;height:19px;border-radius:50%;
      background:linear-gradient(135deg,#a78bfa,#7c3aed);box-shadow:0 0 26px rgba(167,139,250,.85);"></span>
    <span class="d" style="color:#fff;font-size:33px;font-weight:700;letter-spacing:-.02em;">worthit</span>
  </div>

  <div>
    <div style="display:inline-block;padding:9px 19px;border-radius:999px;
      border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.045);
      color:rgba(246,243,251,.72);font-size:20px;font-weight:600;margin-bottom:30px;">
      Du côté de l'acheteur, pas du vendeur
    </div>
    <h1 class="d" style="font-size:97px;font-weight:800;line-height:1.03;letter-spacing:-.035em;color:#f6f3fb;">
      Achète moins.<br>
      <span style="background:linear-gradient(135deg,#a78bfa,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent;">Vis mieux.</span>
    </h1>
  </div>

  <p style="font-size:29px;line-height:1.45;color:rgba(246,243,251,.62);max-width:930px;">
    Une pause entre l'envie et l'achat : ton budget réel, une question honnête, ta décision.
  </p>
</div>`, 1200, 630);

const icon = shell(`<div style="width:180px;height:180px;background:#08050f;
  display:flex;align-items:center;justify-content:center;">
  <span style="width:96px;height:96px;border-radius:50%;
    background:linear-gradient(135deg,#a78bfa,#7c3aed);box-shadow:0 0 46px rgba(167,139,250,.6);"></span>
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

shoot('og', og, 1200, 630);
shoot('apple-touch-icon', icon, 180, 180);
fs.rmSync(TMP, { recursive: true, force: true });
