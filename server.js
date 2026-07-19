/*
 * Worthit — serveur backend
 * - Sert le site (public/)
 * - Supabase : comptes utilisateurs (Auth) + base de données (profils, objectifs, victoires)
 * - /api/chat : agent IA Worthy (OpenAI si OPENAI_API_KEY est définie, sinon cerveau local)
 * - /api/create-checkout-session + /api/verify-session : abonnement Stripe Checkout
 * - /api/webhook : webhook Stripe (optionnel en local, recommandé en production)
 *
 * Les clés vivent dans .env (jamais dans le code, jamais côté front, sauf l'anon key Supabase
 * qui est conçue pour être publique et protégée par les policies RLS de la base).
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_KEY ? require('stripe')(STRIPE_KEY) : null;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

/* ---------- identifie l'utilisateur connecté depuis le header Authorization: Bearer <token> ---------- */
async function getUser(req) {
  if (!supa) return null;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supa.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}
function requireAuth(handler) {
  return async (req, res) => {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'non_authentifie' });
    req.user = user;
    return handler(req, res);
  };
}

/* ---------- webhook Stripe : DOIT être monté avant express.json() (corps brut requis) ---------- */
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).send('Stripe non configuré');
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (whSecret) {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], whSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (!supa) return res.json({ received: true });
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    if (userId) {
      await supa.from('profiles').update({
        is_premium: true,
        stripe_customer_id: session.customer || null,
        stripe_subscription_id: session.subscription || null,
      }).eq('id', userId);
      console.log(`[stripe] premium activé pour ${userId}`);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await supa.from('profiles').update({ is_premium: false }).eq('stripe_subscription_id', sub.id);
    console.log(`[stripe] premium retiré (abonnement ${sub.id})`);
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- statut premium (public, sans auth : lecture seule via id) ---------- */
app.get('/api/me', requireAuth(async (req, res) => {
  const { data } = await supa.from('profiles').select('is_premium').eq('id', req.user.id).single();
  res.json({ premium: !!(data && data.is_premium) });
}));

/* ---------- synchro profil complet : GET pour charger, POST pour sauvegarder ---------- */
app.get('/api/sync', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const [{ data: profile }, { data: goals }, { data: victories }] = await Promise.all([
    supa.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supa.from('goals').select('*').eq('user_id', uid).order('created_at'),
    supa.from('victories').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20),
  ]);
  res.json({ profile: profile || null, goals: goals || [], victories: victories || [] });
}));

app.post('/api/sync', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const { profile, goals, victories } = req.body || {};
  try {
    if (profile) {
      await supa.from('profiles').upsert({ id: uid, ...profile, updated_at: new Date().toISOString() });
    }
    if (Array.isArray(goals)) {
      await supa.from('goals').delete().eq('user_id', uid);
      if (goals.length) {
        await supa.from('goals').insert(goals.map(g => ({
          user_id: uid, name: g.name, target: g.target, current: g.current || 0,
        })));
      }
    }
    if (Array.isArray(victories)) {
      await supa.from('victories').delete().eq('user_id', uid);
      if (victories.length) {
        await supa.from('victories').insert(victories.slice(0, 20).map(v => ({
          user_id: uid, item: v.item, price: v.price, goal_name: v.goal || v.goal_name || null,
        })));
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sync]', err.message);
    res.status(500).json({ error: 'sync_error' });
  }
}));

/* ---------- Stripe Checkout (nécessite un compte connecté) ---------- */
app.post('/api/create-checkout-session', requireAuth(async (req, res) => {
  const { billing } = req.body || {};
  if (!stripe) return res.json({ demo: true }); // pas de clé : le front reste en mode démo
  try {
    const monthly = billing !== 'annuel';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: req.user.id,
      customer_email: req.user.email,
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
}));

/* Vérification au retour de Checkout (pratique en local, le webhook reste la source de vérité en prod) */
app.get('/api/verify-session', requireAuth(async (req, res) => {
  if (!stripe) return res.json({ premium: false });
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    const paid = session && (session.payment_status === 'paid' || session.status === 'complete');
    if (paid && session.client_reference_id === req.user.id) {
      await supa.from('profiles').update({
        is_premium: true,
        stripe_customer_id: session.customer || null,
        stripe_subscription_id: session.subscription || null,
      }).eq('id', req.user.id);
    }
    res.json({ premium: !!paid });
  } catch (err) {
    console.error('[stripe]', err.message);
    res.status(500).json({ error: 'stripe_error' });
  }
}));

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
  console.log(`  Supabase : ${supa ? 'configuré (comptes + base de données réels)' : 'NON configuré (ajoute SUPABASE_URL/SUPABASE_SERVICE_KEY dans .env)'}`);
  console.log(`  Stripe : ${stripe ? 'configuré' : 'NON configuré (mode démo — ajoute STRIPE_SECRET_KEY dans .env)'}`);
  console.log(`  OpenAI : ${OPENAI_KEY ? 'configuré (' + OPENAI_MODEL + ')' : 'NON configuré (cerveau local — ajoute OPENAI_API_KEY dans .env)'}`);
});
