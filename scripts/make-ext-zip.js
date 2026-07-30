/*
 * Empaquette extension/ dans public/worthit-extension.zip — le fichier téléchargé depuis le
 * site ET celui téléversé sur le Chrome Web Store.
 *
 *   npm run ext-zip
 *
 * Deux différences volontaires avec le dossier de développement :
 *
 * 1. `http://localhost:3000/*` disparaît des host_permissions. Il ne sert qu'à tester
 *    l'extension contre le serveur local ; dans une version publiée, c'est une permission
 *    inutile — donc un motif d'examen supplémentaire chez Google, et un avertissement de
 *    plus à l'installation. Le dossier extension/ le garde : on continue d'y charger
 *    l'extension décompressée pour développer.
 * 2. SAFARI.md ne part pas : c'est une note de travail, pas du code livré.
 *
 * L'archive est construite par bsdtar (fourni avec Windows 10+) ou par zip (Unix), et NON
 * par Compress-Archive de PowerShell 5.1 : celui-ci écrit les chemins internes avec des
 * antislashs (« _locales\fr\messages.json »), ce que le format ZIP ne prévoit pas. Chrome
 * peut alors lire un fichier au nom bizarre au lieu d'un dossier _locales — et l'extension
 * perd son nom et sa description traduits.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RACINE = path.join(__dirname, '..');
const SOURCE = path.join(RACINE, 'extension');
const SORTIE = path.join(RACINE, 'public', 'worthit-extension.zip');
const EXCLUS = new Set(['SAFARI.md']);

/* Copie récursive, en sautant les fichiers exclus et tout ce qui commence par un point. */
function copier(de, vers) {
  fs.mkdirSync(vers, { recursive: true });
  for (const entree of fs.readdirSync(de, { withFileTypes: true })) {
    if (entree.name.startsWith('.') || EXCLUS.has(entree.name)) continue;
    const a = path.join(de, entree.name), b = path.join(vers, entree.name);
    if (entree.isDirectory()) copier(a, b);
    else fs.copyFileSync(a, b);
  }
}

const etape = fs.mkdtempSync(path.join(os.tmpdir(), 'worthit-ext-'));
copier(SOURCE, etape);

const manifeste = JSON.parse(fs.readFileSync(path.join(etape, 'manifest.json'), 'utf8'));
const avant = manifeste.host_permissions || [];
manifeste.host_permissions = avant.filter((h) => !/^https?:\/\/localhost/.test(h));
fs.writeFileSync(path.join(etape, 'manifest.json'), JSON.stringify(manifeste, null, 2) + '\n');

/* Le zip doit contenir manifest.json à SA racine, pas un dossier qui le contient : on
 * archive donc le contenu du dossier d'étape, jamais le dossier lui-même. */
const noms = fs.readdirSync(etape);
const zippeurs = [
  { cmd: 'C:/Windows/System32/tar.exe', args: ['-a', '-c', '-f', SORTIE, ...noms] },
  { cmd: 'tar', args: ['-a', '-c', '-f', SORTIE, ...noms] },
  { cmd: 'zip', args: ['-q', '-r', '-X', SORTIE, ...noms] },
];

fs.rmSync(SORTIE, { force: true });
let fait = null;
for (const z of zippeurs) {
  try {
    execFileSync(z.cmd, z.args, { cwd: etape, stdio: 'pipe' });
    if (fs.existsSync(SORTIE)) { fait = z.cmd; break; }
  } catch (e) { /* on essaie le suivant */ }
}
fs.rmSync(etape, { recursive: true, force: true });

if (!fait) {
  console.error("Aucun outil d'archivage trouvé (bsdtar ou zip). Installe l'un des deux.");
  process.exit(1);
}

const poids = (fs.statSync(SORTIE).size / 1024).toFixed(0);
console.log(`public/worthit-extension.zip — version ${manifeste.version}, ${noms.length} entrées, ${poids} Ko`);
if (avant.length !== manifeste.host_permissions.length) {
  console.log('host_permissions publiées :', manifeste.host_permissions.join(', '));
}
