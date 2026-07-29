/*
 * Génère les visuels de présentation (Product Hunt, presse) dans public/press/.
 *
 *   npm run press
 *
 * Format 1270x760, celui recommandé par Product Hunt pour la galerie.
 * Les polices sont relues depuis public/index.html (elles y sont embarquées en base64),
 * donc les visuels restent automatiquement fidèles à la marque sans dupliquer de fichier.
 * Textes en anglais : la cible annoncée est le marché anglophone.
 *
 * Chrome introuvable ? Renseigne son chemin : CHROME_PATH="C:/…/chrome.exe" npm run press
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PUBLIC = path.join(__dirname, '..', 'public');
const PRESSE = path.join(PUBLIC, 'press');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'worthit-press-'));

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

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const faces = html.match(/@font-face\{[\s\S]*?\}/g) || [];
if (!faces.length) throw new Error('aucune @font-face trouvée dans public/index.html');

const L = 1270, H = 760;

/* Jetons de la charte, repris à l'identique de public/index.html. */
const C = {
  void: '#050308', deep: '#08050f', ink: '#f6f3fb',
  dim: 'rgba(246,243,251,.60)', faint: 'rgba(246,243,251,.34)',
  v1: '#a78bfa', v2: '#7c3aed', gold: '#fbcd6b',
  ligne: 'rgba(255,255,255,.09)', verre: 'rgba(255,255,255,.035)',
};

const shell = (body) => `<!doctype html><meta charset="utf-8"><style>
${faces.join('\n')}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${L}px;height:${H}px;overflow:hidden}
body{background:${C.deep};font-family:'Plus Jakarta Sans',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;color:${C.ink}}
.d{font-family:'Unbounded','Plus Jakarta Sans',sans-serif}
.scene{position:relative;width:${L}px;height:${H}px;overflow:hidden;
  background:
    radial-gradient(880px 600px at 14% -6%,rgba(124,58,237,.26),transparent 62%),
    radial-gradient(680px 520px at 104% 108%,rgba(167,139,250,.13),transparent 60%),
    ${C.deep};
  padding:48px 58px;display:flex;flex-direction:column}
/* Les colonnes s'étirent sur toute la hauteur : sinon un panneau de hauteur fixe se
 * centrait et laissait ~140 px de vide en bas de l'image. */
.rangee{display:flex;gap:46px;align-items:stretch;flex:1;min-height:0;margin-top:22px}
.colTexte{width:462px;flex-shrink:0;display:flex;flex-direction:column;justify-content:center}
.eyebrow{display:inline-flex;align-items:center;gap:9px;padding:8px 16px;border-radius:999px;
  border:1px solid rgba(167,139,250,.32);background:rgba(167,139,250,.10);
  color:${C.v1};font-size:14px;font-weight:700;letter-spacing:.01em;align-self:flex-start}
.h1{font-size:47px;font-weight:800;line-height:1.08;letter-spacing:-.035em;margin-top:20px}
.grad{background:linear-gradient(135deg,#c4b5fd,#7c3aed);-webkit-background-clip:text;
  background-clip:text;color:transparent}
.lede{font-size:20px;line-height:1.5;color:${C.dim};margin-top:18px;max-width:520px}
.marque{display:flex;align-items:center;gap:11px}
.marque span{font-size:22px;font-weight:700;letter-spacing:-.02em}
.carte{background:linear-gradient(168deg,#1b1030,#0b0715);
  border:1px solid rgba(167,139,250,.30);border-radius:22px;
  box-shadow:0 40px 90px rgba(0,0,0,.62),0 0 56px rgba(124,58,237,.16)}
.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;
  border:1px solid ${C.ligne};background:${C.verre};font-size:13.5px;color:${C.dim}}
.cta{border-radius:13px;padding:13px 18px;font-size:15px;font-weight:700;text-align:center;
  background:linear-gradient(135deg,#a78bfa,#7c3aed)}
.ghost{border-radius:13px;padding:12px 18px;font-size:14px;text-align:center;
  border:1px solid rgba(255,255,255,.17);color:rgba(255,255,255,.66)}
</style>${body}`;

/* Le logo : une seule source SVG pour tout le projet (le point de la marque est un bouton pause). */
const LOGO = (t) => `<svg width="${t}" height="${t}" viewBox="0 0 100 100" style="display:block;flex-shrink:0">
  <defs><linearGradient id="lp${t}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
  <path fill="url(#lp${t})" fill-rule="evenodd" d="M50 6a44 44 0 1 1 0 88 44 44 0 0 1 0-88Zm-9 27a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Zm18 0a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Z"/>
</svg>`;

const entete = () => `<div class="marque">${LOGO(26)}<span class="d">worthit</span></div>`;

/* Le signe de Worthy. L'emoji 🧠 se réduit à une tache rosâtre dans Chrome headless, et un
 * cerveau dessiné devient illisible sous 20 px : une étincelle reste nette et se lit
 * immédiatement comme « IA ». */
const ETINCELLE = (t, couleur) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24"
  fill="${couleur}" style="display:block;flex-shrink:0">
  <path d="M12 2.6l2.05 5.5 5.5 2.05-5.5 2.05L12 17.7l-2.05-5.5-5.5-2.05 5.5-2.05L12 2.6Z"/>
  <path d="M18.6 15.4l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" opacity=".7"/>
</svg>`;

/* Arrière-plan : une fausse page marchande, volontairement floutée et sans texte lisible.
 * Aucune marque réelle n'est représentée — juste des blocs, pour situer le contexte. */
const pageMarchande = () => {
  const carte = (x, y, w, h) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;
    border-radius:14px;background:linear-gradient(150deg,rgba(255,255,255,.22),rgba(255,255,255,.07))"></div>`;
  const barre = (x, y, w, h, o) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;
    border-radius:4px;background:rgba(255,255,255,${o})"></div>`;
  let s = '';
  for (let rang = 0; rang < 2; rang++) {
    for (let i = 0; i < 3; i++) {
      const x = 34 + i * 196, y = 92 + rang * 250;
      s += carte(x, y, 172, 162) + barre(x, y + 176, 126, 11, .16) + barre(x, y + 196, 70, 11, .1);
    }
  }
  s += barre(34, 38, 124, 15, .2) + barre(420, 38, 200, 15, .1);
  return `<div style="position:absolute;inset:0;filter:blur(2.5px);opacity:.9">${s}</div>`;
};

/* ---------------------------------------------------------------- Visuel 1 : la pause */
const visuel1 = shell(`<div class="scene">
  ${entete()}
  <div class="rangee">

    <div class="colTexte">
      <span class="eyebrow">${LOGO(15)} The moment that matters</span>
      <h1 class="d h1">It stops you<br>the second you<br><span class="grad">click buy.</span></h1>
      <p class="lede">On any store, on any site. Worthit steps in with your real budget — not a guilt trip.</p>
      <div style="display:flex;gap:10px;margin-top:26px;flex-wrap:wrap">
        <span class="pill">Works on any store</span>
        <span class="pill">No bank connection</span>
      </div>
    </div>

    <div style="position:relative;flex:1;border-radius:20px;overflow:hidden;
      border:1px solid ${C.ligne};background:${C.void}">
      ${pageMarchande()}
      <div style="position:absolute;inset:0;background:rgba(5,3,10,.62)"></div>

      <div class="carte" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
        width:356px;padding:26px 24px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
          ${LOGO(17)}<span class="d" style="font-size:15px;font-weight:700">worthit</span>
          <span style="margin-left:auto;font-size:11px;color:${C.faint}">Anti-impulse pause</span>
        </div>
        <div class="d" style="font-size:19px;font-weight:800;line-height:1.32;margin-bottom:12px">
          Hold on. You were about to spend <span style="color:${C.v1}">€149</span>.
        </div>
        <p style="font-size:13.5px;line-height:1.6;color:${C.dim};margin-bottom:20px">
          That's <strong style="color:rgba(246,243,251,.86)">34%</strong> of what's left this month.
          Your goal “Japan trip” would move slower.<br>Real need, or passing urge?
        </p>
        <div class="cta">💪 I'll wait 24 h</div>
        <div class="ghost" style="margin-top:9px">Buying in 47s…</div>
      </div>
    </div>

  </div>
</div>`);

/* ------------------------------------------------------- Visuel 2 : Worthy, l'agent IA */
const bulle = (qui, texte, large) => qui === 'bot'
  ? `<div style="align-self:flex-start;max-width:${large}px;background:rgba(167,139,250,.11);
      border:1px solid rgba(167,139,250,.24);border-radius:15px 15px 15px 5px;padding:13px 15px;
      font-size:14.5px;line-height:1.55">${texte}</div>`
  : `<div style="align-self:flex-end;max-width:${large}px;background:rgba(255,255,255,.06);
      border:1px solid ${C.ligne};border-radius:15px 15px 5px 15px;padding:13px 15px;
      font-size:14.5px;line-height:1.55;color:rgba(246,243,251,.82)">${texte}</div>`;

const visuel2 = shell(`<div class="scene">
  ${entete()}
  <div class="rangee">

    <div class="colTexte">
      <span class="eyebrow">${ETINCELLE(15, C.v1)} Worthy, your AI guardrail</span>
      <h1 class="d h1">Not a blocker.<br><span class="grad">A conversation.</span></h1>
      <p class="lede">Worthy knows your income, your rent, your goal. So it asks the one question that actually lands — with your numbers, not generic advice.</p>
      <div style="display:flex;gap:10px;margin-top:26px;flex-wrap:wrap">
        <span class="pill">Always on your side</span>
        <span class="pill">Never recommends a purchase</span>
      </div>
    </div>

    <div class="carte" style="flex:1;padding:24px;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:11px;padding-bottom:16px;
        border-bottom:1px solid ${C.ligne};margin-bottom:16px;flex-shrink:0">
        <div style="width:38px;height:38px;border-radius:50%;flex-shrink:0;
          background:linear-gradient(135deg,#a78bfa,#7c3aed);display:flex;align-items:center;
          justify-content:center">${ETINCELLE(19, "#fff")}</div>
        <div>
          <div style="font-size:15px;font-weight:700">Worthy</div>
          <div style="font-size:12px;color:${C.v1}">Online — never on the seller's side</div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;flex:1;justify-content:space-between">
        ${bulle('user', 'I want these sneakers, €149', 300)}
        ${bulle('bot', '€149 is <strong>34%</strong> of what you have left this month (€440). Almost half your headroom.<br><br>My suggestion: let\'s put a 24 h pause on it. If you still want them tomorrow, we\'ll talk again.', 400)}
        ${bulle('user', 'ok but I really like them', 300)}
        ${bulle('bot', 'I believe you. Would you have bought them last week?<br>If not, the algorithm won — not you.', 400)}
      </div>

      <div style="display:flex;gap:9px;margin-top:18px;flex-shrink:0">
        <div style="flex:1;border:1px solid ${C.ligne};background:${C.verre};border-radius:12px;
          padding:12px 14px;font-size:14px;color:${C.faint}">Your answer to Worthy…</div>
        <div style="width:46px;border-radius:12px;background:linear-gradient(135deg,#a78bfa,#7c3aed);
          display:flex;align-items:center;justify-content:center;font-size:17px">→</div>
      </div>
    </div>

  </div>
</div>`);

/* ------------------------------------------------- Visuel 3 : la preuve, ce que tu gardes */
const tuile = (label, valeur, accent) => `<div style="flex:1;border:1px solid ${C.ligne};
  background:${C.verre};border-radius:17px;padding:20px 22px">
  <div style="font-size:13px;color:${C.dim};margin-bottom:7px">${label}</div>
  <div class="d" style="font-size:31px;font-weight:800;letter-spacing:-.02em;
    ${accent ? `background:linear-gradient(135deg,#c4b5fd,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent` : ''}">${valeur}</div>
</div>`;

const semaine = [42, 0, 78, 0, 120, 35, 0];
const maxSem = Math.max(...semaine);
const barres = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((j, i) => {
  const v = semaine[i];
  const haut = v > 0 ? Math.max(16, Math.round((v / maxSem) * 100)) : 6;
  return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;
    height:100%;justify-content:flex-end">
    <div style="width:100%;max-width:34px;height:${haut}%;border-radius:8px 8px 4px 4px;
      background:${v > 0 ? 'linear-gradient(180deg,#a78bfa,#7c3aed)' : 'rgba(255,255,255,.07)'}"></div>
    <span style="font-size:11.5px;color:${v > 0 ? C.dim : C.faint}">${j}</span>
  </div>`;
}).join('');

const visuel3 = shell(`<div class="scene">
  <div style="display:flex;align-items:flex-end;justify-content:space-between">
    ${entete()}
    <span class="pill" style="color:${C.gold};border-color:rgba(251,205,107,.28);
      background:rgba(251,205,107,.08)">🔥 12 day streak</span>
  </div>

  <div style="margin-top:26px">
    <span class="eyebrow">📊 Your progress, in plain sight</span>
    <h1 class="d" style="font-size:44px;font-weight:800;line-height:1.08;letter-spacing:-.035em;margin-top:18px">
      Every “no” becomes <span class="grad">something you keep.</span>
    </h1>
  </div>

  <div style="display:flex;gap:16px;margin-top:26px">
    ${tuile('Left this month', '€440')}
    ${tuile('Saved by resisting', '€1,240', true)}
    ${tuile('Purchases avoided', '31')}
  </div>

  <div style="display:flex;gap:16px;margin-top:16px;flex:1;min-height:0">
    <div style="flex:1.35;border:1px solid ${C.ligne};background:${C.verre};border-radius:17px;
      padding:20px 22px;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-shrink:0">
        <span style="font-size:14px;font-weight:700">Your week of resistance</span>
        <span style="font-size:13px;color:${C.dim}">€275 kept</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:9px;flex:1;min-height:0">${barres}</div>
    </div>

    <div style="flex:1;border:1px solid ${C.ligne};background:${C.verre};border-radius:17px;
      padding:20px 22px;display:flex;flex-direction:column;gap:20px">
      <div>
        <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:9px">
          <span style="font-weight:700">Japan trip</span>
          <span style="color:${C.dim}">€1,240 / 1,800</span>
        </div>
        <div style="height:9px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden">
          <div style="height:100%;width:69%;border-radius:99px;
            background:linear-gradient(90deg,#a78bfa,#7c3aed)"></div>
        </div>
      </div>
      <div>
        <div style="font-size:13px;color:${C.dim};margin-bottom:11px">This week, among friends</div>
        ${[[1, 'Léa', '€142', false], [2, 'You', '€120', true], [3, 'Tom', '€64', false]]
          .map(([rang, n, v, moi]) => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;
            font-size:13.5px;color:${moi ? C.ink : C.dim};font-weight:${moi ? 700 : 400}">
            <span style="width:20px;height:20px;border-radius:50%;flex-shrink:0;font-size:11px;
              display:flex;align-items:center;justify-content:center;font-weight:700;
              ${moi ? `background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff`
                    : `background:rgba(255,255,255,.07);color:${C.faint}`}">${rang}</span>
            <span style="flex:1">${n}</span><span>${v}</span></div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:auto">
        <span class="pill" style="font-size:12.5px">🔒 Parental mode</span>
        <span class="pill" style="font-size:12.5px">🌍 5 languages</span>
      </div>
    </div>
  </div>
</div>`);

/* ------------------------------------------------------------------------------ rendu */
function shoot(nom, source) {
  const src = path.join(TMP, nom + '.html');
  const dest = path.join(PRESSE, nom + '.png');
  fs.writeFileSync(src, source, 'utf8');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--screenshot=${dest}`, `--window-size=${L},${H}`,
    'file:///' + src.replace(/\\/g, '/'),
  ], { stdio: 'pipe', timeout: 120000 });
  console.log(`public/press/${nom}.png — ${L}x${H}, ${(fs.statSync(dest).size / 1024).toFixed(0)} Ko`);
}

fs.mkdirSync(PRESSE, { recursive: true });
shoot('ph-1-pause', visuel1);
shoot('ph-2-worthy', visuel2);
shoot('ph-3-progress', visuel3);
fs.rmSync(TMP, { recursive: true, force: true });
