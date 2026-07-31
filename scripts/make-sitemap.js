/*
 * Génère public/sitemap.xml depuis les routes déclarées dans public/index.html.
 *
 *   npm run sitemap
 *
 * Écrit à la main, ce fichier se périme sans prévenir : le précédent annonçait encore le
 * 20 juillet alors que le site avait changé plusieurs fois depuis, et il ignorait les
 * versions traduites. Le générer depuis la source évite les deux dérives.
 *
 * Chaque page est déclarée cinq fois — une par langue — et chaque déclaration porte les
 * `hreflang` de ses quatre sœurs. C'est ce qui dit à Google « ce sont des traductions les
 * unes des autres », et non du contenu dupliqué.
 */
const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const SITE = 'https://worthits.com';
const LANGUES = ['en', 'fr', 'es', 'de', 'nl']; // l'anglais vit sur l'adresse nue
/* Pages privées : invisibles sans compte, rien à y référencer. */
const PRIVEES = new Set(['/dashboard', '/parametres', '/boutique', '/connexion']);
/* Les pages légales existent pour être lues au besoin, pas pour attirer du trafic. */
const PRIORITE = { '/': '1.0', '/fonctionnalites': '0.8', '/tarifs': '0.8' };

const html = fs.readFileSync(path.join(RACINE, 'public', 'index.html'), 'utf8');
const bloc = html.slice(html.indexOf('const ROUTES = {'));
const chemins = [...bloc.slice(0, bloc.indexOf('};')).matchAll(/'(\/[a-z-]*)'/g)]
  .map((m) => m[1])
  .filter((c) => !PRIVEES.has(c));
if (!chemins.length) throw new Error('aucune route trouvée dans public/index.html');

const url = (chemin, langue) =>
  SITE + (langue === 'en' ? '' : '/' + langue) + (chemin === '/' ? '/' : chemin);

const aujourdhui = new Date().toISOString().slice(0, 10);
const entrees = [];
for (const chemin of chemins) {
  const alternates = LANGUES
    .map((lg) => `    <xhtml:link rel="alternate" hreflang="${lg}" href="${url(chemin, lg)}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${url(chemin, 'en')}"/>`)
    .join('\n');
  for (const langue of LANGUES) {
    entrees.push(`  <url>
    <loc>${url(chemin, langue)}</loc>
${alternates}
    <lastmod>${aujourdhui}</lastmod>
    <priority>${PRIORITE[chemin] || '0.6'}</priority>
  </url>`);
  }
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entrees.join('\n')}
</urlset>
`;

fs.writeFileSync(path.join(RACINE, 'public', 'sitemap.xml'), xml);
console.log(`public/sitemap.xml — ${chemins.length} pages x ${LANGUES.length} langues = ${entrees.length} adresses, au ${aujourdhui}`);
