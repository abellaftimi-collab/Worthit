/*
 * Génère la vidéo de présentation : public/press/worthit-demo.mp4 (+ un GIF allégé).
 *
 *   node scripts/make-video.js
 *
 * 1920x1080, 30 i/s, ~45 s, sans son — pensée pour Product Hunt et les réseaux, où la
 * lecture se fait muette par défaut : tout est donc porté par les sous-titres incrustés.
 *
 * DEUX OUTILS EXTERNES, volontairement PAS dans les dépendances du projet (ils pèsent
 * ~200 Mo et n'ont rien à faire dans un déploiement Render) :
 *
 *   mkdir video-tools && cd video-tools && npm init -y
 *   npm install puppeteer-core ffmpeg-static
 *   VIDEO_TOOLS=<chemin vers video-tools/node_modules> node scripts/make-video.js
 *
 * Principe : chaque image est rendue par une page dont l'état ne dépend QUE du numéro de
 * frame — aucune animation CSS, aucune horloge. Deux rendus successifs sont donc
 * rigoureusement identiques, et on peut relancer la génération sans variation.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { PRODUITS } = require('./lib/produits');

const RACINE = path.join(__dirname, '..');
const PUBLIC = path.join(RACINE, 'public');
const SORTIE = path.join(PUBLIC, 'press');
const FRAMES = path.join(os.tmpdir(), 'worthit-video-frames');

/* ------------------------------------------------------------------ outils externes */
function charger(nom) {
  const bases = [process.env.VIDEO_TOOLS, path.join(RACINE, 'node_modules'),
    path.join(RACINE, '..', 'video-tools', 'node_modules')].filter(Boolean);
  for (const base of bases) {
    try { return require(path.join(base, nom)); } catch (e) { /* on essaie le suivant */ }
  }
  try { return require(nom); } catch (e) { /* absent */ }
  console.error(`\n« ${nom} » introuvable. Voir l'en-tête de ce fichier pour l'installer,`);
  console.error('puis relance avec VIDEO_TOOLS=<chemin vers node_modules>.\n');
  process.exit(1);
}
const puppeteer = charger('puppeteer-core');
const ffmpeg = charger('ffmpeg-static');

const CHROMES = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CHROMES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!CHROME) { console.error('Chrome/Edge introuvable (CHROME_PATH=…)'); process.exit(1); }

/* ------------------------------------------------------------------------ constantes */
const L = 1920, H = 1080, FPS = 30;
/* Rythme global. 1 = les durées de scènes telles qu'écrites ; 1.5 accélère d'un tiers,
 * ce qui rend le film nettement plus nerveux sans rien retirer du propos. */
const VITESSE = 1.5;

const C = {
  fond: '#08050f', vide: '#050308', encre: '#f6f3fb',
  terne: 'rgba(246,243,251,.62)', pale: 'rgba(246,243,251,.34)',
  v1: '#a78bfa', v2: '#7c3aed', or: '#fbcd6b', rouge: '#f87171',
  ligne: 'rgba(255,255,255,.09)', verre: 'rgba(255,255,255,.035)',
};

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const polices = html.match(/@font-face\{[\s\S]*?\}/g) || [];
if (!polices.length) throw new Error('aucune @font-face trouvée dans public/index.html');

/* ------------------------------------------------------------- aides d'interpolation */
const borne = (x) => Math.max(0, Math.min(1, x));
/* Progression d'un sous-élément entre deux instants de la scène. */
const fen = (t, a, b) => borne((t - a) / (b - a));
const sortie3 = (t) => 1 - Math.pow(1 - t, 3);
const douceur = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const entre = (t, a, b) => a + (b - a) * t;
/* Apparition puis disparition : 1 au milieu de la fenêtre, 0 aux extrémités. */
const paraitre = (t, entree, sorti) => Math.min(fen(t, 0, entree), 1 - fen(t, 1 - sorti, 1));
const nombre = (t, jusqua) => Math.round(sortie3(t) * jusqua).toLocaleString('en-US');

/* ------------------------------------------------------------------------- fragments */
const LOGO = (t) => `<svg width="${t}" height="${t}" viewBox="0 0 100 100" style="display:block;flex-shrink:0">
  <defs><linearGradient id="g${t}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
  <path fill="url(#g${t})" fill-rule="evenodd" d="M50 6a44 44 0 1 1 0 88 44 44 0 0 1 0-88Zm-9 27a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Zm18 0a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Z"/></svg>`;

const ETINCELLE = (t, c) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="${c}"
  style="display:block;flex-shrink:0"><path d="M12 2.6l2.05 5.5 5.5 2.05-5.5 2.05L12 17.7l-2.05-5.5-5.5-2.05 5.5-2.05L12 2.6Z"/>
  <path d="M18.6 15.4l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z" opacity=".7"/></svg>`;

/* Curseur de souris dessiné : aucune capture réelle n'est nécessaire. */
const CURSEUR = (x, y, appui) => `<svg width="30" height="30" viewBox="0 0 24 24"
  style="position:absolute;left:${x}px;top:${y}px;z-index:60;
  transform:scale(${appui ? 0.86 : 1});transform-origin:top left;
  filter:drop-shadow(0 3px 7px rgba(0,0,0,.6))">
  <path d="M5 2l14 8.5-6.2 1.4L9.6 19 5 2Z" fill="#fff" stroke="#0b0715" stroke-width="1.3"/></svg>`;

/* Fausse boutique : des blocs abstraits. Aucune marque réelle, aucun texte lisible.
 * Une seule rangée de grandes fiches — à l'échelle d'une vidéo vue en petit, quatre
 * éléments larges se lisent, douze petits deviennent une bouillie grise. */
const FICHE = { x0: 90, y: 150, pas: 440, larg: 380, img: 300 };

function boutique(flou, masques) {
  const bloc = (x, y, w, h, o) => `<div style="position:absolute;left:${x}px;top:${y}px;
    width:${w}px;height:${h}px;border-radius:18px;
    background:linear-gradient(150deg,rgba(255,255,255,${o + 0.14}),rgba(255,255,255,${o}))"></div>`;
  const barre = (x, y, w, o, h) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;
    height:${h || 15}px;border-radius:6px;background:rgba(255,255,255,${o})"></div>`;
  // Les barres d'en-tête commencent après le filigrane « worthit », sinon elles se superposent.
  let s = barre(430, 60, 190, .18, 17) + barre(760, 62, 300, .1) + barre(1560, 62, 140, .1);
  for (let i = 0; i < 4; i++) {
    const x = FICHE.x0 + i * FICHE.pas;
    // Une fiche « masquée » reçoit le même traitement que dans l'extension : flou + gris.
    const m = masques && masques.includes(i);
    s += `<div style="position:absolute;left:${x}px;top:${FICHE.y}px;width:${FICHE.larg}px;height:400px;
      ${m ? 'filter:blur(15px) grayscale(.65);opacity:.4;' : ''}">
      ${bloc(0, 0, FICHE.larg, FICHE.img, .07)}
      <div style="position:absolute;left:0;top:0;width:${FICHE.larg}px;height:${FICHE.img}px;
        display:flex;align-items:center;justify-content:center">${PRODUITS[i % PRODUITS.length](190, 0.8)}</div>
      ${barre(0, FICHE.img + 26, 270, .2, 17)}${barre(0, FICHE.img + 57, 140, .1)}</div>`;
  }
  return `<div style="position:absolute;inset:0;${flou ? `filter:blur(${flou}px);` : ''}">${s}</div>`;
}

/* Sous-titre incrusté, position et style constants d'une scène à l'autre. */
function soustitre(texte, opacite, monte) {
  return `<div style="position:absolute;left:0;right:0;bottom:96px;display:flex;justify-content:center;
    opacity:${opacite.toFixed(3)};transform:translateY(${(1 - monte) * 22}px)">
    <div style="max-width:1240px;padding:20px 40px;border-radius:20px;
      background:rgba(8,5,15,.80);border:1px solid rgba(167,139,250,.24);
      backdrop-filter:blur(10px);box-shadow:0 24px 60px rgba(0,0,0,.5)">
      <div class="d" style="font-size:40px;font-weight:800;line-height:1.22;letter-spacing:-.025em;
        text-align:center;color:${C.encre}">${texte}</div>
    </div></div>`;
}

const filigrane = () => `<div style="position:absolute;top:44px;left:52px;display:flex;align-items:center;
  gap:12px;opacity:.92;z-index:50">${LOGO(30)}
  <span class="d" style="font-size:25px;font-weight:700;letter-spacing:-.02em">worthit</span></div>`;

/* La carte de pause de l'extension, reproduite à l'identique. */
function cartePause(avancee, secondes) {
  const monte = sortie3(borne(avancee));
  return `<div style="position:absolute;left:50%;top:50%;
    transform:translate(-50%,calc(-50% + ${((1 - monte) * 46).toFixed(1)}px)) scale(${entre(monte, 0.93, 1).toFixed(3)});
    opacity:${monte.toFixed(3)};width:560px;padding:40px 38px;border-radius:30px;
    background:linear-gradient(168deg,#1b1030,#0b0715);border:1px solid rgba(167,139,250,.34);
    box-shadow:0 60px 130px rgba(0,0,0,.66),0 0 90px rgba(124,58,237,.20);z-index:40">
    <div style="display:flex;align-items:center;gap:11px;margin-bottom:24px">
      ${LOGO(24)}<span class="d" style="font-size:21px;font-weight:700">worthit</span>
      <span style="margin-left:auto;font-size:15px;color:${C.pale}">Anti-impulse pause</span>
    </div>
    <div class="d" style="font-size:29px;font-weight:800;line-height:1.3;margin-bottom:18px">
      Hold on. You were about to spend <span style="color:${C.v1}">€149</span>.
    </div>
    <p style="font-size:19px;line-height:1.62;color:${C.terne};margin-bottom:30px">
      That's <strong style="color:rgba(246,243,251,.9)">34%</strong> of what's left this month.<br>
      Your goal “Japan trip” would move slower.
    </p>
    <div style="border-radius:18px;padding:19px;font-size:21px;font-weight:700;text-align:center;
      background:linear-gradient(135deg,#a78bfa,#7c3aed)">💪 I'll wait 24 h</div>
    <div style="border-radius:18px;padding:17px;font-size:18px;text-align:center;margin-top:13px;
      border:1px solid rgba(255,255,255,.17);color:rgba(255,255,255,.5)">
      ${secondes > 0 ? `Buying in ${secondes}s…` : 'Buy anyway'}</div>
  </div>`;
}

/* =================================================================== LES SIX SCÈNES */
/* Chaque scène reçoit t (0 -> 1) et rend le contenu de la zone image. */
const scenes = [

  /* 1. Le problème : un clic ordinaire, et l'argent part. */
  { duree: 5, rendu: (t) => {
    // Le bouton d'achat de la première fiche : c'est lui que le curseur vient chercher.
    const bx = FICHE.x0, by = FICHE.y + FICHE.img + 96;
    const av = douceur(fen(t, 0.10, 0.62));
    const appui = t > 0.60 && t < 0.68;
    const eclat = fen(t, 0.60, 0.72) * (1 - fen(t, 0.74, 0.95));
    return `${boutique(0)}
      <div class="d" style="position:absolute;left:${bx + FICHE.larg - 132}px;
        top:${FICHE.y + FICHE.img - 66}px;padding:11px 20px;border-radius:14px;
        font-size:27px;font-weight:800;color:${C.encre};background:rgba(8,5,15,.82);
        border:1px solid rgba(255,255,255,.16)">€149</div>
      <div style="position:absolute;left:${bx}px;top:${by}px;width:${FICHE.larg}px;padding:21px 0;
        border-radius:16px;text-align:center;font-size:22px;font-weight:700;
        background:linear-gradient(135deg,#3b82f6,#1d4ed8);
        box-shadow:0 0 ${(eclat * 54).toFixed(0)}px rgba(59,130,246,${(eclat * 0.85).toFixed(2)})">
        Add to cart</div>
      ${CURSEUR(entre(av, 1520, bx + 292), entre(av, 300, by + 34), appui)}
      ${soustitre('One click. €149 gone.<br><span style="color:' + C.terne + ';font-size:31px">The urge lasted 20 seconds.</span>',
        paraitre(t, 0.22, 0.14), fen(t, 0, 0.20))}`;
  } },

  /* 2. La pause : Worthit s'interpose, avec les vrais chiffres. */
  { duree: 8, rendu: (t) => {
    const voile = fen(t, 0.02, 0.20);
    const sec = Math.max(0, 60 - Math.floor(fen(t, 0.34, 1) * 13));
    return `${boutique(entre(fen(t, 0.02, 0.26), 0, 5))}
      <div style="position:absolute;inset:0;background:rgba(5,3,10,${(voile * 0.72).toFixed(2)})"></div>
      ${cartePause(fen(t, 0.10, 0.42), sec)}
      ${soustitre('Worthit steps in — with your <span style="color:' + C.v1 + '">real budget</span>.',
        paraitre(t, 0.14, 0.12), fen(t, 0.06, 0.26))}`;
  } },

  /* 3. Worthy : ce n'est pas un mur, c'est un échange. */
  { duree: 9, rendu: (t) => {
    const bulles = [
      { qui: 'moi', txt: 'I want these sneakers, €149', a: 0.06 },
      { qui: 'bot', txt: '€149 is <strong>34%</strong> of what you have left this month (€440). Almost half your headroom.<br><br>My suggestion: a 24 h pause. If you still want them tomorrow, we\'ll talk again.', a: 0.20 },
      { qui: 'moi', txt: 'ok but I really like them', a: 0.46 },
      { qui: 'bot', txt: 'I believe you. Would you have bought them last week?<br>If not, the algorithm won — not you.', a: 0.58 },
    ];
    const rendues = bulles.map((b) => {
      const p = sortie3(fen(t, b.a, b.a + 0.11));
      if (p <= 0) return '';
      const bot = b.qui === 'bot';
      return `<div style="align-self:${bot ? 'flex-start' : 'flex-end'};max-width:${bot ? 720 : 480}px;
        opacity:${p.toFixed(3)};transform:translateY(${((1 - p) * 16).toFixed(1)}px);
        padding:20px 24px;font-size:21px;line-height:1.55;
        ${bot ? `background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.26);
                 border-radius:22px 22px 22px 7px`
              : `background:rgba(255,255,255,.06);border:1px solid ${C.ligne};
                 border-radius:22px 22px 7px 22px;color:rgba(246,243,251,.84)`}">${b.txt}</div>`;
    }).join('');
    return `<div style="position:absolute;inset:0;background:
        radial-gradient(1100px 700px at 20% 0%,rgba(124,58,237,.20),transparent 62%),${C.fond}"></div>
      <div style="position:absolute;left:50%;top:428px;transform:translate(-50%,-50%);width:1060px;
        padding:34px;border-radius:30px;background:linear-gradient(168deg,#1b1030,#0b0715);
        border:1px solid rgba(167,139,250,.28);box-shadow:0 50px 110px rgba(0,0,0,.6)">
        <div style="display:flex;align-items:center;gap:15px;padding-bottom:22px;
          border-bottom:1px solid ${C.ligne};margin-bottom:26px">
          <div style="width:52px;height:52px;border-radius:50%;flex-shrink:0;display:flex;
            align-items:center;justify-content:center;
            background:linear-gradient(135deg,#a78bfa,#7c3aed)">${ETINCELLE(26, '#fff')}</div>
          <div><div style="font-size:21px;font-weight:700">Worthy</div>
            <div style="font-size:16px;color:${C.v1}">Online — never on the seller's side</div></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:16px;min-height:420px;justify-content:flex-end">
          ${rendues}
        </div>
      </div>
      ${soustitre('Not a blocker. <span style="color:' + C.v1 + '">A conversation.</span>',
        paraitre(t, 0.12, 0.10), fen(t, 0.04, 0.22))}`;
  } },

  /* 4. Le filtrage : mots-clés, produits masqués, site entier. */
  { duree: 8, rendu: (t) => {
    /* Mots-clés d'exemple volontairement génériques : afficher une marque réelle en grand
     * dans une vidéo promotionnelle exposerait le produit sans rien apporter. */
    const mots = ['sneakers', 'gaming', 'sale'];
    const puces = mots.map((m, i) => {
      const p = sortie3(fen(t, 0.04 + i * 0.06, 0.18 + i * 0.06));
      return `<span style="opacity:${p.toFixed(3)};transform:scale(${entre(p, 0.86, 1).toFixed(3)});
        display:inline-flex;align-items:center;gap:11px;padding:15px 28px;border-radius:999px;
        font-size:23px;font-weight:600;background:rgba(167,139,250,.16);
        border:1px solid rgba(167,139,250,.42);color:#cbb8ff">${m} ✕</span>`;
    }).join('');
    // Les fiches se masquent l'une après l'autre, comme le fait le vrai passage de l'extension.
    const masques = [0, 2, 3].filter((_, i) => fen(t, 0.30 + i * 0.06, 0.38 + i * 0.06) > 0.5);
    const bandeau = sortie3(fen(t, 0.70, 0.86));
    return `${boutique(0, masques)}
      <div style="position:absolute;left:0;right:0;top:625px;display:flex;justify-content:center;gap:16px">${puces}</div>
      ${bandeau > 0 ? `
        <div style="position:absolute;left:0;right:0;top:110px;height:480px;
          background:rgba(5,3,10,${(bandeau * 0.86).toFixed(2)})"></div>
        <div style="position:absolute;left:50%;top:350px;transform:translate(-50%,-50%)
          scale(${entre(bandeau, 0.94, 1).toFixed(3)});opacity:${bandeau.toFixed(3)};
          padding:34px 58px;border-radius:26px;text-align:center;
          background:rgba(11,7,21,.96);border:1px solid rgba(248,113,113,.42);
          box-shadow:0 40px 90px rgba(0,0,0,.65)">
          <div style="font-size:19px;color:${C.rouge};margin-bottom:12px;letter-spacing:.06em">SITE BLOCKED</div>
          <div class="d" style="font-size:36px;font-weight:800">sneaker-shop.com</div>
          <div style="font-size:19px;color:${C.terne};margin-top:12px">matches your keyword “sneakers”</div>
        </div>` : ''}
      ${soustitre('Blur what makes you cave.<br><span style="color:' + C.terne + ';font-size:31px">Or block the whole site.</span>',
        paraitre(t, 0.14, 0.12), fen(t, 0.06, 0.24))}`;
  } },

  /* 5. La preuve : ce que tu gardes, chiffré. */
  { duree: 10, rendu: (t) => {
    const semaine = [42, 0, 78, 0, 120, 35, 0];
    const maxS = Math.max(...semaine);
    const barres = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((j, i) => {
      const v = semaine[i];
      const p = sortie3(fen(t, 0.34 + i * 0.035, 0.54 + i * 0.035));
      const haut = v > 0 ? Math.max(14, Math.round((v / maxS) * 100)) * p : 5;
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:12px;
        height:100%;justify-content:flex-end">
        <div style="width:100%;max-width:52px;height:${haut.toFixed(1)}%;border-radius:11px 11px 5px 5px;
          background:${v > 0 ? 'linear-gradient(180deg,#a78bfa,#7c3aed)' : 'rgba(255,255,255,.07)'}"></div>
        <span style="font-size:17px;color:${v > 0 ? C.terne : C.pale}">${j}</span></div>`;
    }).join('');
    const tuile = (label, val, i, accent) => {
      const p = sortie3(fen(t, 0.06 + i * 0.06, 0.26 + i * 0.06));
      return `<div style="flex:1;opacity:${p.toFixed(3)};transform:translateY(${((1 - p) * 20).toFixed(1)}px);
        border:1px solid ${C.ligne};background:${C.verre};border-radius:24px;padding:30px 34px">
        <div style="font-size:19px;color:${C.terne};margin-bottom:11px">${label}</div>
        <div class="d" style="font-size:48px;font-weight:800;letter-spacing:-.02em;
          ${accent ? 'background:linear-gradient(135deg,#c4b5fd,#7c3aed);-webkit-background-clip:text;background-clip:text;color:transparent' : ''}">${val}</div></div>`;
    };
    const obj = sortie3(fen(t, 0.56, 0.82));
    return `<div style="position:absolute;inset:0;background:
        radial-gradient(1100px 700px at 80% 0%,rgba(124,58,237,.18),transparent 62%),${C.fond}"></div>
      <div style="position:absolute;left:96px;right:96px;top:150px">
        <div style="display:flex;gap:22px">
          ${tuile('Left this month', '€' + nombre(fen(t, 0.10, 0.40), 440), 0)}
          ${tuile('Saved by resisting', '€' + nombre(fen(t, 0.14, 0.50), 1240), 1, true)}
          ${tuile('Purchases avoided', nombre(fen(t, 0.18, 0.46), 31), 2)}
        </div>
        <div style="display:flex;gap:22px;margin-top:22px">
          <div style="flex:1.4;border:1px solid ${C.ligne};background:${C.verre};border-radius:24px;
            padding:28px 32px;height:300px;display:flex;flex-direction:column">
            <div style="display:flex;justify-content:space-between;margin-bottom:22px">
              <span style="font-size:20px;font-weight:700">Your week of resistance</span>
              <span style="font-size:19px;color:${C.terne}">€275 kept</span></div>
            <div style="display:flex;align-items:flex-end;gap:14px;flex:1">${barres}</div>
          </div>
          <div style="flex:1;border:1px solid ${C.ligne};background:${C.verre};border-radius:24px;
            padding:28px 32px;height:300px;display:flex;flex-direction:column;justify-content:center;gap:22px">
            <div>
              <div style="display:flex;justify-content:space-between;font-size:20px;margin-bottom:14px">
                <span style="font-weight:700">Japan trip</span>
                <span style="color:${C.terne}">€${nombre(fen(t, 0.56, 0.82), 1240)} / 1,800</span></div>
              <div style="height:14px;border-radius:99px;background:rgba(255,255,255,.07);overflow:hidden">
                <div style="height:100%;width:${(obj * 69).toFixed(1)}%;border-radius:99px;
                  background:linear-gradient(90deg,#a78bfa,#7c3aed)"></div></div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;padding:15px 20px;border-radius:16px;
              background:rgba(251,205,107,.09);border:1px solid rgba(251,205,107,.26);
              opacity:${sortie3(fen(t, 0.66, 0.84)).toFixed(3)}">
              <span style="font-size:24px">🔥</span>
              <span style="font-size:19px;color:${C.or};font-weight:700">12 day streak</span></div>
          </div>
        </div>
      </div>
      ${soustitre('Every “no” becomes <span style="color:' + C.v1 + '">something you keep.</span>',
        paraitre(t, 0.12, 0.10), fen(t, 0.04, 0.22))}`;
  } },

  /* 6. Clôture : la marque, la promesse, l'adresse. */
  { duree: 5, rendu: (t) => {
    const p = sortie3(fen(t, 0.04, 0.36));
    const q = sortie3(fen(t, 0.24, 0.56));
    const r = sortie3(fen(t, 0.42, 0.72));
    return `<div style="position:absolute;inset:0;background:
        radial-gradient(1000px 760px at 50% 42%,rgba(124,58,237,.30),transparent 66%),${C.fond}"></div>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:34px">
        <div style="display:flex;align-items:center;gap:22px;opacity:${p.toFixed(3)};
          transform:scale(${entre(p, 0.9, 1).toFixed(3)})">
          ${LOGO(76)}<span class="d" style="font-size:76px;font-weight:700;letter-spacing:-.03em">worthit</span>
        </div>
        <div class="d" style="font-size:44px;font-weight:800;letter-spacing:-.025em;text-align:center;
          opacity:${q.toFixed(3)};transform:translateY(${((1 - q) * 20).toFixed(1)}px)">
          On the buyer's side,<br><span style="background:linear-gradient(135deg,#c4b5fd,#7c3aed);
          -webkit-background-clip:text;background-clip:text;color:transparent">never the seller's.</span>
        </div>
        <div style="display:flex;align-items:center;gap:16px;opacity:${r.toFixed(3)};
          transform:translateY(${((1 - r) * 16).toFixed(1)}px)">
          <span style="font-size:31px;color:${C.encre};font-weight:600">worthits.com</span>
          <span style="padding:11px 22px;border-radius:999px;font-size:20px;color:${C.terne};
            border:1px solid ${C.ligne};background:${C.verre}">Free · Chrome extension</span>
        </div>
      </div>`;
  } },
];

const DUREE = scenes.reduce((s, sc) => s + sc.duree, 0) / VITESSE;
const TOTAL = Math.round(DUREE * FPS);

/* Repère la scène courante et la progression locale à partir du numéro de frame. */
function etat(f) {
  let debut = 0;
  for (const sc of scenes) {
    const fin = debut + (sc.duree / VITESSE) * FPS;
    if (f < fin) return { sc, t: (f - debut) / ((sc.duree / VITESSE) * FPS) };
    debut = fin;
  }
  const last = scenes[scenes.length - 1];
  return { sc: last, t: 1 };
}

function pageDe(f) {
  const { sc, t } = etat(f);
  // Fondu au noir de 6 frames en tout début et toute fin du film.
  const ouverture = borne(f / 6);
  const fermeture = borne((TOTAL - 1 - f) / 6);
  const global = f / (TOTAL - 1);
  return `<!doctype html><meta charset="utf-8"><style>
${polices.join('\n')}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${L}px;height:${H}px;overflow:hidden;background:#000}
body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:${C.encre}}
.d{font-family:'Unbounded','Plus Jakarta Sans',sans-serif}
strong{font-weight:800;color:${C.encre}}
</style><body>
<div style="position:relative;width:${L}px;height:${H}px;overflow:hidden;background:${C.fond};
  opacity:${Math.min(ouverture, fermeture).toFixed(3)}">
  ${sc.rendu(t)}
  ${filigrane()}
  <div style="position:absolute;left:0;bottom:0;height:5px;width:${(global * 100).toFixed(2)}%;
    background:linear-gradient(90deg,#a78bfa,#7c3aed);z-index:70"></div>
</div></body>`;
}

/* --------------------------------------------------------------------------- rendu */
/* `--preview` sort une image au cœur de chaque scène, dans un dossier temporaire :
 * de quoi juger la mise en page en quelques secondes au lieu d'attendre tout le film. */
const APERCU = process.argv.includes('--preview');

(async () => {
  if (APERCU) {
    const dossier = process.env.PREVIEW_DIR || path.join(os.tmpdir(), 'worthit-video-apercu');
    fs.rmSync(dossier, { recursive: true, force: true });
    fs.mkdirSync(dossier, { recursive: true });
    const nav = await puppeteer.launch({ executablePath: CHROME, headless: true,
      args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu'] });
    const ong = await nav.newPage();
    await ong.setViewport({ width: L, height: H, deviceScaleFactor: 1 });
    let debut = 0;
    for (let i = 0; i < scenes.length; i++) {
      // Deux instants par scène : au tiers (animations en cours) et vers la fin (état final).
      for (const [nom, part] of [['a', 0.34], ['b', 0.88]]) {
        const f = Math.round(debut + (scenes[i].duree / VITESSE) * FPS * part);
        await ong.setContent(pageDe(f), { waitUntil: 'load' });
        const dest = path.join(dossier, `scene${i + 1}${nom}.png`);
        await ong.screenshot({ path: dest });
        console.log(path.basename(dest), `(frame ${f})`);
      }
      debut += (scenes[i].duree / VITESSE) * FPS;
    }
    await nav.close();
    console.log('\naperçus dans', dossier);
    return;
  }

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  fs.mkdirSync(SORTIE, { recursive: true });

  console.log(`${scenes.length} scènes — ${DUREE} s — ${TOTAL} images en ${L}x${H}`);
  const navigateur = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu'],
  });
  const onglet = await navigateur.newPage();
  await onglet.setViewport({ width: L, height: H, deviceScaleFactor: 1 });

  const debut = Date.now();
  for (let f = 0; f < TOTAL; f++) {
    await onglet.setContent(pageDe(f), { waitUntil: 'load' });
    await onglet.screenshot({ path: path.join(FRAMES, String(f).padStart(5, '0') + '.png') });
    if (f % 150 === 0 || f === TOTAL - 1) {
      const pct = ((f + 1) / TOTAL * 100).toFixed(0);
      process.stdout.write(`\r  rendu ${pct}% (${f + 1}/${TOTAL})   `);
    }
  }
  await navigateur.close();
  console.log(`\n  images rendues en ${((Date.now() - debut) / 1000 / 60).toFixed(1)} min`);

  const mp4 = path.join(SORTIE, 'worthit-demo.mp4');
  execFileSync(ffmpeg, ['-y', '-framerate', String(FPS), '-i', path.join(FRAMES, '%05d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '19',
    '-movflags', '+faststart', mp4], { stdio: 'pipe' });
  console.log(`  ${path.relative(RACINE, mp4)} — ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(1)} Mo`);

  /* GIF réduit : utile pour un README ou un tweet, là où le MP4 ne se lit pas.
   * Palette calculée sur l'ensemble des images, sinon les dégradés violets se délavent. */
  const gif = path.join(SORTIE, 'worthit-demo.gif');
  const palette = path.join(os.tmpdir(), 'worthit-palette.png');
  // 640 px / 10 i/s : un GIF de démo doit rester sous quelques Mo, sinon il ne se charge
  // ni dans un README ni dans un tweet — et le MP4 reste là pour la qualité.
  const filtre = 'fps=10,scale=640:-1:flags=lanczos';
  execFileSync(ffmpeg, ['-y', '-i', mp4, '-vf', `${filtre},palettegen=stats_mode=diff`, palette], { stdio: 'pipe' });
  execFileSync(ffmpeg, ['-y', '-i', mp4, '-i', palette,
    '-lavfi', `${filtre}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, gif], { stdio: 'pipe' });
  console.log(`  ${path.relative(RACINE, gif)} — ${(fs.statSync(gif).size / 1024 / 1024).toFixed(1)} Mo`);

  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.rmSync(palette, { force: true });
})().catch((e) => { console.error('\nÉCHEC :', e.message); process.exit(1); });
