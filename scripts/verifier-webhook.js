/*
 * Vérifie qu'un webhook Stripe signé est bien accepté par le serveur de production.
 *
 *   node scripts/verifier-webhook.js [url]
 *
 * À quoi ça sert : une destination Stripe peut pointer vers la bonne adresse et écouter les
 * bons événements, et pourtant tout rejeter — si la clé de signature enregistrée côté
 * serveur n'est pas celle de la destination. Stripe ne permet pas d'envoyer un événement de
 * test sur une destination live, et un vrai paiement coûte une carte et un remboursement.
 * Ce script fabrique donc l'événement lui-même, le signe avec la clé, et regarde la réponse.
 *
 * La clé est demandée au clavier et n'est jamais écrite nulle part : ni dans un fichier, ni
 * dans un argument de ligne de commande (qui resterait dans l'historique du terminal).
 *
 * L'événement envoyé est délibérément inoffensif : c'est un checkout.session.completed SANS
 * client_reference_id. Le serveur le reconnaît, ne modifie aucun compte, et répond
 * simplement qu'il l'a reçu — exactement le chemin qu'on veut valider.
 */
const readline = require('readline');
const stripe = require('stripe')('sk_test_inutilise_ici'); // seule la signature nous intéresse

const URL = process.argv[2] || 'https://worthits.com/api/webhook';

const corps = JSON.stringify({
  id: 'evt_verification_locale',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_verification_locale', object: 'checkout.session', client_reference_id: null } },
});

function demander(question) {
  return new Promise((resoudre) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // On masque la frappe : la clé ne doit pas rester lisible à l'écran.
    const ecrire = rl._writeToOutput;
    rl._writeToOutput = function (s) { if (s.includes(question)) ecrire.call(rl, s); };
    rl.question(question, (reponse) => { rl.close(); console.log(); resoudre(reponse.trim()); });
  });
}

(async () => {
  const secret = await demander('Clé de signature Stripe (whsec_…, la frappe reste invisible) : ');
  if (!secret.startsWith('whsec_')) {
    console.error('\nCette clé ne commence pas par « whsec_ ». C\'est la clé de signature de la');
    console.error('destination qu\'il faut, pas la clé API du compte.');
    process.exit(1);
  }

  const signature = stripe.webhooks.generateTestHeaderString({ payload: corps, secret });
  console.log(`Envoi d'un événement signé à ${URL}\n`);

  let reponse;
  try {
    reponse = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: corps,
    });
  } catch (e) {
    console.error('Serveur injoignable :', e.message);
    process.exit(1);
  }

  const texte = (await reponse.text()).trim();
  console.log(`HTTP ${reponse.status}  ${texte}\n`);

  if (reponse.status === 200) {
    console.log('✓ La clé du serveur est la bonne. La chaîne complète fonctionne :');
    console.log('  Stripe signe → le serveur vérifie → il traite. Un vrai paiement passera.');
  } else if (/No signatures found/i.test(texte)) {
    console.log('✗ Le serveur n\'a pas la même clé que celle saisie ici.');
    console.log('  Recopie la clé de la destination Stripe dans STRIPE_WEBHOOK_SECRET sur');
    console.log('  Render, attends la fin du redéploiement (1 à 3 min), puis relance.');
  } else if (/Webhook non configuré/i.test(texte)) {
    console.log('✗ STRIPE_WEBHOOK_SECRET est absent des variables du serveur.');
  } else {
    console.log('✗ Réponse inattendue — voir ci-dessus.');
  }
})();
