/*
 * Ce que l'extension considère — ou non — comme une intention d'achat.
 *
 *   npm test
 *
 * Les listes de mots ne sont pas recopiées ici : elles sont extraites de
 * extension/content.js à l'exécution. Un test qui dupliquerait le vocabulaire finirait par
 * valider sa propre copie pendant que l'extension dérive de son côté.
 *
 * Origine de ces cas : un jeu de carrière footballistique proposait le choix « Y aller et
 * régler ça en face ». Le mot « régler » suffisait à ouvrir une pause anti-achat en plein
 * milieu d'une partie. Un faux positif sur un site sans rapport n'est pas un détail
 * cosmétique : c'est la première chose que voit un examinateur du Chrome Web Store.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

/* Extrait un tableau de chaînes déclaré en tête de content.js. */
function listeDe(nom) {
  const debut = source.indexOf(`const ${nom} = [`);
  assert.notStrictEqual(debut, -1, `${nom} introuvable dans extension/content.js`);
  const ouvre = source.indexOf('[', debut);
  const ferme = source.indexOf('];', ouvre);
  const bloc = source.slice(ouvre + 1, ferme);
  // Les entrées sont des littéraux simples, une ou plusieurs par ligne, commentaires ignorés.
  return bloc.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^'.*'$/.test(s))
    .map((s) => s.slice(1, -1));
}

const LETTRE = 'A-Za-zÀ-ÖØ-öø-ÿ';
const motsEn = (liste) => new RegExp(
  '(?:^|[^' + LETTRE + '])(?:' + liste.join('|') + ')(?:[^' + LETTRE + ']|$)', 'i');

const FORTS = motsEn(listeDe('MOTS_FORTS'));
const FAIBLES = motsEn(listeDe('MOTS_FAIBLES'));
const reconnu = (libelle) => FORTS.test(libelle) || FAIBLES.test(libelle);

test('les formulations de paiement sans ambiguïté sont reconnues seules', () => {
  for (const libelle of [
    'Ajouter au panier', 'Passer commande', 'Payer maintenant', 'Procéder au paiement',
    'Add to cart', 'Buy now', 'Checkout', 'Place your order',
    'In den Warenkorb', 'Finalizar compra', 'Afrekenen',
  ]) {
    assert.ok(FORTS.test(libelle), `« ${libelle} » devrait être un mot fort`);
  }
});

test('un verbe d\'achat seul reste reconnu, mais au niveau faible', () => {
  // Ces libellés doivent être vus — c'est estActionDachat() qui exigera ensuite un prix.
  for (const libelle of ['Acheter', 'Buy', 'Comprar', 'Kaufen']) {
    assert.ok(FAIBLES.test(libelle), `« ${libelle} » devrait être un mot faible`);
    assert.ok(!FORTS.test(libelle), `« ${libelle} » ne doit PAS déclencher seul`);
  }
});

test('une phrase ordinaire d\'interface ne parle pas d\'achat', () => {
  for (const libelle of [
    // Le cas d'origine, et ses cousins : « régler » en français veut d'abord dire résoudre.
    'Y aller et régler ça en face',
    'Régler ce différend une bonne fois',
    'Régler les paramètres du compte',
    'Régler le volume',
    'Décliner et répondre sur le terrain',
    'Continuer la partie',
    'Voir les statistiques',
  ]) {
    assert.ok(!reconnu(libelle), `« ${libelle} » ne devrait rien déclencher`);
  }
});

/* Ces verbes-là restent volontairement dans les mots faibles : un bouton d'hôtel dit
 * « Réserver », un loueur dit « Louer ». On ne peut pas les retirer du vocabulaire sans
 * rendre l'extension aveugle sur ces sites. Ce qui les rend inoffensifs ailleurs, c'est
 * estActionDachat() : un mot faible exige en plus un prix à proximité. Le test vérifie
 * donc seulement qu'ils ne franchissent jamais le niveau fort, qui déclenche seul. */
test('les verbes ambigus ne déclenchent jamais à eux seuls', () => {
  for (const libelle of [
    'Réserver ce sujet pour plus tard', 'Commander la manœuvre',
    'Louer les mérites de quelqu\'un', 'Order the list',
  ]) {
    assert.ok(!FORTS.test(libelle), `« ${libelle} » ne doit pas être un mot fort`);
  }
});

test('« régler » ne compte que suivi de ce qu\'on règle', () => {
  for (const libelle of ['Régler ma commande', 'Régler mon achat', 'Régler le montant']) {
    assert.ok(FORTS.test(libelle), `« ${libelle} » est bien un paiement`);
  }
});

/* ------------------------------------------------------------------------------------
 * Le second garde-fou : ce qui fait qu'un mot faible déclenche, ou non.
 *
 * estActionDachat() vit dans une IIFE truffée d'API navigateur, impossible à charger telle
 * quelle. On en extrait donc le texte source et on l'exécute sur un DOM minimal : le test
 * porte bien sur le code livré, pas sur une réécriture qui pourrait en diverger.
 * ---------------------------------------------------------------------------------- */
function extraire(nom) {
  const debut = source.indexOf(`function ${nom}(`);
  assert.notStrictEqual(debut, -1, `${nom} introuvable`);
  let profondeur = 0, i = source.indexOf('{', debut);
  const ouvre = i;
  do {
    if (source[i] === '{') profondeur++;
    else if (source[i] === '}') profondeur--;
    i++;
  } while (profondeur > 0 && i < source.length);
  return source.slice(debut, i);
}

const CHECKOUT_PATHS_SRC = source.match(/const CHECKOUT_PATHS = \/.*\/i;/)[0];
const estActionDachat = new Function('document', 'location', `
  ${CHECKOUT_PATHS_SRC}
  ${extraire('prixJusteACote')}
  ${extraire('estActionDachat')}
  return estActionDachat;
`)({ body: Symbol('body') }, { href: 'https://exemple.com/page' });

/* Élément factice : juste ce que la fonction consulte. */
const faux = ({ tag = 'BUTTON', type = '', href = null, texte = '', parent = null }) => ({
  tagName: tag, type, innerText: texte, parentElement: parent,
  getAttribute: (n) => (n === 'href' ? href : null),
  closest: () => null, // jamais dans une barre de navigation, ici
});

test('un bouton ne prouve plus à lui seul qu\'on achète', () => {
  // Le cas du jeu : un bouton, un verbe ambigu, et aucun prix autour.
  const bouton = faux({ texte: 'Y aller et régler ça en face' });
  assert.strictEqual(estActionDachat(bouton), false);
});

test('un bouton avec un prix juste à côté reste une action d\'achat', () => {
  const carte = faux({ tag: 'DIV', texte: 'Sneakers édition limitée 149 €' });
  const bouton = faux({ texte: 'Acheter', parent: carte });
  assert.strictEqual(estActionDachat(bouton), true);
});

test('un lien de catalogue n\'est pas une action d\'achat', () => {
  // Le fameux onglet « Buy » d'un site immobilier : un lien, sans chemin de paiement.
  const lien = faux({ tag: 'A', href: '/homes/for_sale/', texte: 'Buy' });
  assert.strictEqual(estActionDachat(lien), false);
});

test('un lien qui mène au panier suffit, prix ou pas', () => {
  const lien = faux({ tag: 'A', href: '/checkout', texte: 'Commander' });
  assert.strictEqual(estActionDachat(lien), true);
});
