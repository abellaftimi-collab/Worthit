/*
 * Worthit — serveur backend
 * - Sert le site (public/)
 * - /api/chat : agent IA Worthy (OpenAI si OPENAI_API_KEY est définie, sinon cerveau local)
 * - /api/create-checkout-session + /api/verify-session : abonnement Stripe Checkout
 * - /api/webhook : webhook Stripe (optionnel en local, recommandé en production)
 *
 * Les clés vivent dans .env (jamais dans le code, jamais côté front).
 */
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_KEY ? require('stripe')(STRIPE_KEY) : null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ---------- petit stockage JSON des abonnés premium (remplace par une vraie BDD en prod) ---------- */
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'premium.json');
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return {}; }
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

/* ---------- webhook Stripe : DOIT être monté avant express.json() (corps brut requis) ---------- */
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(400).send('Stripe non configuré');
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (whSecret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], whSecret);
    } else {
      // Sans secret de webhook (dev local sans Stripe CLI), on fait confiance au corps.
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const cid = session.client_reference_id;
    if (cid) {
      const store = loadStore();
      store[cid] = { since: Date.now(), subscription: session.subscription || null };
      saveStore(store);
      console.log(`[stripe] premium activé pour ${cid}`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const store = loadStore();
    for (const [cid, info] of Object.entries(store)) {
      if (info.subscription === sub.id) { delete store[cid]; console.log(`[stripe] premium retiré pour ${cid}`); }
    }
    saveStore(store);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- statut premium ---------- */
app.get('/api/me', (req, res) => {
  const cid = req.query.cid;
  const store = loadStore();
  res.json({ premium: !!(cid && store[cid]) });
});

/* ---------- Stripe Checkout ---------- */
app.post('/api/create-checkout-session', async (req, res) => {
  const { cid, billing } = req.body || {};
  if (!stripe) return res.json({ demo: true }); // pas de clé : le front reste en mode démo
  try {
    const monthly = billing !== 'annuel';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: cid || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          recurring: { interval: monthly ? 'month' : 'year' },
          unit_amount: monthly ? 299 : 2399, // centimes : 2,99 € / 23,99 €
          product_data: { name: 'Worthit Premium', description: "Agent IA personnalisé, dashboard perso, tournois entre amis" },
        },
      }],
      success_url: `${req.protocol}://${req.get('host')}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe]', err.message);
    res.status(500).json({ error: 'stripe_error' });
  }
});

/* Vérification au retour de Checkout (pratique en local, le webhook reste la source de vérité en prod) */
app.get('/api/verify-session', async (req, res) => {
  if (!stripe) return res.json({ premium: false });
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    const paid = session && (session.payment_status === 'paid' || session.status === 'complete');
    if (paid && session.client_reference_id) {
      const store = loadStore();
      store[session.client_reference_id] = { since: Date.now(), subscription: session.subscription || null };
      saveStore(store);
    }
    res.json({ premium: !!paid });
  } catch (err) {
    console.error('[stripe]', err.message);
    res.status(500).json({ error: 'stripe_error' });
  }
});

/* ---------- agent IA Worthy ---------- */
const SYSTEM_PROMPT = `Tu es Worthy, l'assistant anti-achat-impulsif de l'application Worthit.
Ton rôle : aider l'utilisateur à distinguer besoin réel et envie du moment, sans jamais le juger ni le culpabiliser.
Tu es TOUJOURS du côté de l'acheteur, jamais du vendeur. Tu ne recommandes jamais d'acheter quoi que ce soit.
Style : tutoiement, français, chaleureux mais direct, réponses courtes (3-5 phrases max), une question honnête plutôt qu'un sermon.
Outils rhétoriques : rapporter un prix au budget restant du mois, à l'objectif d'épargne en cours, proposer la pause de 24 h.
Tu reçois le contexte financier de l'utilisateur en JSON : sers-t'en pour donner des chiffres concrets (pourcentage du reste-à-vivre, progression des objectifs, streak).
Le contexte contient aussi sa fonction/métier, ses catégories de faiblesse (faiblesses) et sa fréquence d'achats impulsifs : personnalise tes questions avec.
Si context.langue vaut "en", "es", "de" ou "nl", réponds dans cette langue (en gardant le même ton).`;

/* Cerveau local de secours : les mêmes règles que la démo front, côté serveur */
function localBrain(raw, ctx) {
  ctx = ctx || {};
  const t = String(raw).toLowerCase();
  const left = Number(ctx.reste) || 0;
  const name = ctx.nom || '';
  const goals = Array.isArray(ctx.objectifs) ? ctx.objectifs : [];
  const goal = goals[0];
  const m = String(raw).match(/(\d+[.,]?\d*)\s*€?/);
  if (m && parseFloat(m[1].replace(',', '.')) > 0) {
    const price = parseFloat(m[1].replace(',', '.'));
    const pct = left > 0 ? Math.round((price / left) * 100) : null;
    if (pct === null) return "Ton budget du mois est déjà à zéro… c'est peut-être le signal le plus clair qu'on puisse avoir, non ?";
    if (pct >= 50) return `${price} €, c'est ${pct} % de ce qu'il te reste ce mois-ci (${left} €). Presque la moitié de ta marge.\n\nMa suggestion : on pose une pause de 24 h. Si demain tu y penses encore, on en reparle.`;
    if (pct >= 20) return `Ça représente ${pct} % de ton reste-à-vivre (${left} €).${goal ? ` Ton objectif « ${goal.name} » avancerait plus lentement.` : ''}\n\nQuestion honnête : besoin réel, ou envie du moment ?`;
    return `${price} €, soit ${pct} % de ce qu'il te reste. C'est raisonnable — mais est-ce que tu l'aurais acheté la semaine dernière ? Si la réponse est non, c'est peut-être l'algorithme qui a gagné, pas toi.`;
  }
  if (/budget|reste|argent|combien/.test(t)) return `Ce mois-ci il te reste ${left} € une fois le loyer (${ctx.loyer || 0} €) et les charges (${ctx.charges || 0} €) déduits de tes ${ctx.revenu || 0} €.\n\nEt tu as déjà gardé ${ctx.economise || 0} € en résistant. Pas mal, non ?`;
  if (/motiv|encourag|craquer|envie|dur/.test(t)) return `${name ? name + ', t' : 'T'}a série tient depuis ${ctx.streak || 0} jours. 🔥${goal ? `\n\nChaque euro non dépensé va vers « ${goal.name} » — il en manque ${goal.target - goal.current} €.` : ''}`;
  if (/objectif|épargne|epargne/.test(t) && goals.length) return goals.map(g => `« ${g.name} » : ${g.current} / ${g.target} € (${Math.round((g.current / g.target) * 100)} %)`).join('\n') + '\n\nChaque refus fait avancer ces barres.';
  if (/bonjour|salut|hello|coucou|hey/.test(t)) return `Salut${name ? ' ' + name : ''} ! Une envie d'achat te trotte dans la tête ? Dis-moi quoi et à quel prix, on regarde ensemble ce que ça pèse vraiment.`;
  if (/merci|top|cool|nickel/.test(t)) return "Avec plaisir. Je suis là au moment du doute — c'est exactement mon travail. 💜";
  return "Dis-m'en plus : c'est quoi, et ça coûte combien ? Donne-moi un prix et je te montre ce que ça représente sur ton mois.";
}

app.post('/api/chat', async (req, res) => {
  const { message, history, context } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message manquant' });

  if (!OPENAI_KEY) {
    return res.json({ reply: localBrain(message, context), source: 'local' });
  }
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\nContexte utilisateur (JSON) :\n' + JSON.stringify(context || {}) },
      ...(Array.isArray(history) ? history.slice(-10).map(m => ({
        role: m.who === 'user' ? 'user' : 'assistant',
        content: String(m.text || ''),
      })) : []),
      { role: 'user', content: message },
    ];
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, max_tokens: 350, temperature: 0.7 }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error && data.error.message || ('HTTP ' + r.status));
    res.json({ reply: data.choices[0].message.content, source: 'openai' });
  } catch (err) {
    console.error('[openai]', err.message);
    // L'IA distante a échoué : le cerveau local prend le relais, l'utilisateur n'est jamais bloqué.
    res.json({ reply: localBrain(message, context), source: 'local-fallback' });
  }
});

app.listen(PORT, () => {
  console.log(`Worthit démarré : http://localhost:${PORT}`);
  console.log(`  Stripe : ${stripe ? 'configuré' : 'NON configuré (mode démo — ajoute STRIPE_SECRET_KEY dans .env)'}`);
  console.log(`  OpenAI : ${OPENAI_KEY ? 'configuré (' + OPENAI_MODEL + ')' : 'NON configuré (cerveau local — ajoute OPENAI_API_KEY dans .env)'}`);
});
