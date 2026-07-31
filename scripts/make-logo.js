/*
 * Génère l'identité visuelle en images, dans public/brand/.
 *
 *   npm run logo
 *
 * Le dessin n'est pas réinventé ici : c'est celui de public/favicon.svg (un disque dont le
 * creux forme un bouton pause) et l'icône `worthy` de public/index.html. Ce script ne fait
 * que les décliner aux tailles et sur les fonds dont on a besoin ailleurs — réseaux, presse,
 * fiche Chrome Web Store — pour qu'aucune de ces déclinaisons ne soit redessinée à la main
 * et ne finisse par diverger de la marque.
 *
 * Les polices sont relues depuis public/index.html, où elles sont embarquées en base64.
 * Chrome introuvable ? CHROME_PATH="C:/…/chrome.exe" npm run logo
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.join(__dirname, '..');
const PUBLIC = path.join(RACINE, 'public');
const SORTIE = path.join(PUBLIC, 'brand');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'worthit-logo-'));

const CANDIDATS = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CANDIDATS.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!CHROME) { console.error('Chrome/Edge introuvable (CHROME_PATH=…)'); process.exit(1); }

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const polices = html.match(/@font-face\{[\s\S]*?\}/g) || [];
if (!polices.length) throw new Error('aucune @font-face trouvée dans public/index.html');

const C = { fond: '#08050f', encre: '#f6f3fb', terne: 'rgba(246,243,251,.62)', v1: '#a78bfa', v2: '#7c3aed' };

/* ------------------------------------------------------------------------ les deux signes */

/* La marque. `id` est unique par appel : deux dégradés portant le même id dans une page
 * s'écrasent, et le second logo sortirait noir. */
let n = 0;
const MARQUE = (t, lueur) => {
  const id = 'g' + (++n);
  return `<svg width="${t}" height="${t}" viewBox="0 0 100 100" style="display:block;flex-shrink:0${
    lueur ? `;filter:drop-shadow(0 ${t * 0.03}px ${t * 0.09}px rgba(124,58,237,.55))` : ''}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.v1}"/><stop offset="1" stop-color="${C.v2}"/></linearGradient></defs>
    <path fill="url(#${id})" fill-rule="evenodd" d="M50 6a44 44 0 1 1 0 88 44 44 0 0 1 0-88Zm-9 27a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Zm18 0a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Z"/>
  </svg>`;
};

/* Worthy, repris trait pour trait de l'icône `worthy` de public/index.html. */
const WORTHY = (t, couleur) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
  style="display:block;flex-shrink:0;color:${couleur}">
  <circle cx="12" cy="2.7" r="1.25" fill="currentColor" stroke="none"/><path d="M12 3.95V6.2"/>
  <rect x="4" y="6.2" width="16" height="12.8" rx="5.6"/>
  <circle cx="9.2" cy="12" r="1.65" fill="currentColor" stroke="none"/>
  <circle cx="14.8" cy="12" r="1.65" fill="currentColor" stroke="none"/>
  <circle cx="6.7" cy="14.6" r="1" fill="currentColor" stroke="none" opacity=".38"/>
  <circle cx="17.3" cy="14.6" r="1" fill="currentColor" stroke="none" opacity=".38"/>
  <path d="M10.1 15.7c.9.8 3 .8 3.9 0"/><path d="M2.3 11.2v2.8M21.7 11.2v2.8"/>
</svg>`;

/* Le mot. Les proportions sont celles de l'en-tête du site (signe 26 / texte 22 / écart 11),
 * simplement mises à l'échelle : c'est ce qui fait qu'un lockup agrandi reste le même objet. */
const MOT = (t) => `<span style="font-family:'Unbounded','Plus Jakarta Sans',sans-serif;
  font-size:${t * 0.846}px;font-weight:700;letter-spacing:-.02em;color:${C.encre};line-height:1">worthit</span>`;
const LOCKUP = (t, lueur) => `<div style="display:flex;align-items:center;gap:${t * 0.42}px">
  ${MARQUE(t, lueur)}${MOT(t)}</div>`;

/* ------------------------------------------------------------------------------- le rendu */
const page = (L, H, corps, fond) => `<!doctype html><meta charset="utf-8"><style>
${polices.join('\n')}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${L}px;height:${H}px;overflow:hidden}
body{${fond ? `background:${fond};` : ''}font-family:'Plus Jakarta Sans',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;color:${C.encre};
  display:flex;align-items:center;justify-content:center}
</style>${corps}`;

function rendre(nom, L, H, corps, fond) {
  const src = path.join(TMP, nom + '.html');
  const dest = path.join(SORTIE, nom + '.png');
  fs.writeFileSync(src, page(L, H, corps, fond), 'utf8');
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--screenshot=${dest}`, `--window-size=${L},${H}`];
  // Sans fond déclaré, on veut un PNG réellement transparent : le logo doit pouvoir se poser
  // sur n'importe quel support sans traîner un rectangle sombre derrière lui.
  if (!fond) args.push('--default-background-color=00000000');
  args.push('file:///' + src.replace(/\\/g, '/'));
  execFileSync(CHROME, args, { stdio: 'pipe', timeout: 120000 });
  console.log(`  brand/${nom}.png — ${L}x${H}, ${(fs.statSync(dest).size / 1024).toFixed(0)} Ko${fond ? '' : ', fond transparent'}`);
}

/* Fond de marque : les mêmes halos que l'accueil du site. */
const HALOS = (a, b) => `radial-gradient(${a} at 50% -10%,rgba(124,58,237,.30),transparent 62%),
  radial-gradient(${b} at 88% 112%,rgba(167,139,250,.16),transparent 60%),${C.fond}`;

fs.mkdirSync(SORTIE, { recursive: true });
console.log('Identité Worthit :');

/* 1. Le signe seul, très grand — la source de toutes les découpes ultérieures. */
rendre('marque-1024', 1024, 1024, MARQUE(1024, false));

/* 2. Le verrou horizontal, signe + mot : l'usage courant (en-têtes, partenaires, presse). */
rendre('lockup-2400x640', 2400, 640, LOCKUP(420, false));

/* 3. Worthy seul, pour tout ce qui parle de l'agent plutôt que du produit. */
rendre('worthy-1024', 1024, 1024, WORTHY(1024, C.v1));

/* 4. Avatar carré : réseaux sociaux, où l'image est rognée en cercle — d'où la marge
 *    généreuse autour du signe, sinon le rognage mord dessus. */
rendre('avatar-512', 512, 512, `<div style="display:grid;place-items:center;width:512px;height:512px">
  ${MARQUE(300, true)}</div>`, HALOS('700px 500px', '400px 320px'));

/* 5. L'image de présentation : celle qu'on partage quand il faut une seule image. */
rendre('presentation-1600x900', 1600, 900, `<div style="display:flex;flex-direction:column;
  align-items:center;gap:34px">
  ${LOCKUP(188, true)}
  <p style="font-family:'Unbounded','Plus Jakarta Sans',sans-serif;font-size:46px;font-weight:600;
    letter-spacing:-.02em;background:linear-gradient(135deg,#c4b5fd,#7c3aed);-webkit-background-clip:text;
    background-clip:text;color:transparent;padding-bottom:6px">Buy less. Live more.</p>
</div>`, HALOS('1100px 760px', '700px 560px'));

/* 6. L'icône de la FICHE Chrome Web Store — à ne pas confondre avec extension/icon128.png,
 *    qui s'affiche dans la barre d'outils et a raison d'y occuper presque tout le carré.
 *    Ici Google attend un dessin de 96x96 centré dans 128x128 : la marge de 16 px sert à
 *    l'ombre et au cadre que le store ajoute lui-même. Sans elle, l'icône paraît plus
 *    grosse que celle des voisines dans la grille.
 *
 *    109 et non 96 : dans son gabarit de 100, le disque va de 6 à 94, il n'en occupe donc
 *    que 88 %. Rendu à 96 px, l'encre n'en mesurerait que 86 et l'icône paraîtrait perdue
 *    au milieu du carré. 96 ÷ 0,88 ≈ 109 donne un dessin qui mesure vraiment 96. */
rendre('store-icone-128', 128, 128, `<div style="display:grid;place-items:center;width:128px;height:128px">
  ${MARQUE(109, false)}</div>`);

/* 7 et 8. Les deux tuiles promotionnelles du Chrome Web Store, aux dimensions imposées.
 *         Composition décentrée : la fiche affiche du texte par-dessus la marquee. */
rendre('store-tuile-440x280', 440, 280, `<div style="display:flex;flex-direction:column;
  align-items:center;gap:16px">${LOCKUP(64, true)}
  <p style="font-size:17px;color:${C.terne};letter-spacing:.01em">Buy less. Live more.</p>
</div>`, HALOS('420px 300px', '260px 200px'));

rendre('store-marquee-1400x560', 1400, 560, `<div style="display:flex;align-items:center;
  justify-content:space-between;width:100%;padding:0 110px">
  <div style="display:flex;flex-direction:column;gap:28px">
    ${LOCKUP(108, true)}
    <p style="font-size:33px;line-height:1.35;color:${C.terne};max-width:600px">
      The pause between the urge<br>and the purchase.</p>
  </div>
  <div style="display:grid;place-items:center;width:260px;height:260px;border-radius:50%;
    background:linear-gradient(135deg,${C.v1},${C.v2});
    box-shadow:0 30px 80px rgba(124,58,237,.45)">${WORTHY(150, '#fff')}</div>
</div>`, HALOS('1000px 700px', '600px 480px'));

fs.rmSync(TMP, { recursive: true, force: true });
