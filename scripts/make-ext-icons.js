/*
 * Génère les icônes de l'extension Chrome (extension/icon16.png, icon48.png, icon128.png)
 * à partir du MÊME logo que le reste du site (bouton pause dans un cercle dégradé) —
 * jusqu'ici l'extension utilisait un simple « W », visuellement incohérent avec la marque
 * et peu lisible en tout petit.
 *
 *   npm run ext-icons
 *
 * Contrairement à make-og.js (qui capture une page entière, toujours opaque), ce script
 * dessine sur un <canvas> transparent et récupère les octets PNG via canvas.toDataURL() —
 * c'est la seule méthode qui préserve un vrai canal alpha avec Chrome headless en CLI :
 * --screenshot aplatit toujours le fond, même avec un CSS background:transparent.
 * Chaque icône est dessinée en interne à 8× sa taille finale puis réduite avec un lissage
 * de haute qualité, pour rester nette à 16 px (sinon les bords du cercle crantent).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT = path.join(__dirname, '..', 'extension');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'worthit-icons-'));

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!CHROME) {
  console.error('Chrome/Edge introuvable. Relance avec CHROME_PATH=<chemin vers chrome.exe>');
  process.exit(1);
}

/* Mêmes couleurs que favicon.svg / make-og.js : un seul dégradé de marque. Les barres sont
 * en aplat sombre (et non « découpées » en transparence comme dans le SVG du site) : une
 * icône de barre d'outils doit rester lisible qu'elle repose sur un Chrome clair ou sombre —
 * une découpe transparente aurait laissé transparaître le thème du navigateur à travers
 * les barres, imprévisible selon l'utilisateur. */
function dessinerLogo(taille) {
  return `
  try {
    const S = ${taille}, ECH = 8;                 // rendu interne à 8×, réduit ensuite : bords nets même à 16 px
    const c = document.createElement('canvas');
    c.width = S * ECH; c.height = S * ECH;
    const ctx = c.getContext('2d');
    const cx = c.width / 2, cy = c.height / 2, r = c.width * 0.44;

    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, '#a78bfa');
    g.addColorStop(1, '#7c3aed');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    const bw = c.width * 0.11, bh = c.width * 0.40, gap = c.width * 0.09;
    const top = cy - bh / 2, rad = bw / 2;
    ctx.fillStyle = '#1b1030';
    for (const bx of [cx - gap / 2 - bw, cx + gap / 2]) {
      ctx.beginPath();
      ctx.moveTo(bx, top + rad);
      ctx.arc(bx + rad, top + rad, rad, Math.PI, 0);
      ctx.lineTo(bx + bw, top + bh - rad);
      ctx.arc(bx + rad, top + bh - rad, rad, 0, Math.PI);
      ctx.closePath(); ctx.fill();
    }

    const final = document.createElement('canvas');
    final.width = S; final.height = S;
    const fctx = final.getContext('2d');
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(c, 0, 0, S, S);
    document.getElementById('out').textContent = final.toDataURL('image/png');
  } catch (e) {
    // Le try/catch n'est pas cosmétique : sans lui, --dump-dom capture parfois la page
    // AVANT la fin du dessin (le canvas est pourtant 100% synchrone) et le <pre> reste
    // vide, sans qu'aucune exception ne soit levée nulle part. Constaté de façon fiable
    // et reproductible ; entourer le bloc suffit à l'éliminer.
    document.getElementById('out').textContent = 'ERREUR:' + e.message;
  }
  `;
}

function genererIcone(taille) {
  const html = `<!doctype html><meta charset="utf-8"><body><pre id="out"></pre>
    <script>${dessinerLogo(taille)}</script></body>`;
  const src = path.join(TMP, `icon${taille}.html`);
  fs.writeFileSync(src, html, 'utf8');

  const sortie = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--virtual-time-budget=2000', '--dump-dom', 'file:///' + src.replace(/\\/g, '/'),
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).toString('utf8');

  // On isole le CONTENU du <pre> : la page dumpée contient aussi le SOURCE du <script>
  // (donc le mot « ERREUR » y apparaît toujours, dans le code du catch) — un simple
  // .includes() sur toute la page se déclencherait à tort à chaque fois.
  const sortiePre = sortie.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  const resultat = sortiePre ? sortiePre[1] : '';
  if (resultat.startsWith('ERREUR:')) throw new Error(`icône ${taille}px : ${resultat.slice(7)}`);
  const m = resultat.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error(`icône ${taille}px : le canvas n'a produit aucune image`);

  const buf = Buffer.from(m[1], 'base64');
  const dest = path.join(EXT, `icon${taille}.png`);
  fs.writeFileSync(dest, buf);
  console.log(`extension/icon${taille}.png — ${taille}x${taille}, ${(buf.length / 1024).toFixed(1)} Ko`);
}

for (const taille of [16, 48, 128]) genererIcone(taille);
fs.rmSync(TMP, { recursive: true, force: true });
