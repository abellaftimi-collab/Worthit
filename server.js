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
// Surchargeable pour les tests, ou pour viser une API compatible OpenAI.
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

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
  // Sans secret, impossible de vérifier que l'événement vient bien de Stripe : n'importe qui
  // pourrait poster un faux « checkout.session.completed » et s'offrir le Premium. On refuse.
  if (!whSecret) {
    console.error('[webhook] rejeté : STRIPE_WEBHOOK_SECRET absent du .env');
    return res.status(500).send('Webhook non configuré');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], whSecret);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  if (!supa) return res.json({ received: true });
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (userId) {
        const { error: updErr } = await supa.from('profiles').update({
          is_premium: true,
          stripe_customer_id: session.customer || null,
          stripe_subscription_id: session.subscription || null,
        }).eq('id', userId);
        if (updErr) throw updErr;
        console.log(`[stripe] premium activé pour ${userId}`);

        // Parrainage : ce paiement consomme le code de parrainage (le cas échéant) et/ou les semaines en réserve.
        const { data: paidProfile, error: selErr } = await supa.from('profiles')
          .select('referred_by, referral_reward_given, pending_referral_days')
          .eq('id', userId).maybeSingle();
        if (selErr) throw selErr;
        if (paidProfile) {
          const updates = {};
          if (paidProfile.referred_by && !paidProfile.referral_reward_given) {
            updates.referral_reward_given = true;
            const { data: referrer, error: refErr } = await supa.from('profiles')
              .select('id, pending_referral_days')
              .eq('referral_code', paidProfile.referred_by).maybeSingle();
            if (refErr) throw refErr;
            if (referrer) {
              const { error: bankErr } = await supa.from('profiles')
                .update({ pending_referral_days: (referrer.pending_referral_days || 0) + 1 })
                .eq('id', referrer.id);
              if (bankErr) throw bankErr;
              console.log(`[parrainage] +1 semaine en réserve pour ${referrer.id} (a parrainé ${userId})`);
            }
          }
          if (paidProfile.pending_referral_days > 0) updates.pending_referral_days = 0;
          if (Object.keys(updates).length) {
            const { error: upd2Err } = await supa.from('profiles').update(updates).eq('id', userId);
            if (upd2Err) throw upd2Err;
          }
        }
      }
    }
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { error } = await supa.from('profiles').update({ is_premium: false }).eq('stripe_subscription_id', sub.id);
      if (error) throw error;
      console.log(`[stripe] premium retiré (abonnement ${sub.id})`);
    }
    res.json({ received: true });
  } catch (err) {
    // Réponse non-2xx : Stripe réessaiera automatiquement ce webhook plus tard.
    console.error('[webhook]', err.message);
    res.status(500).json({ error: 'webhook_processing_failed' });
  }
});

app.set('trust proxy', 1); // derrière le proxy Render : req.ip = vraie IP client, pas celle du proxy
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Premium : abonnement Stripe OU semaine offerte encore valable ---------- */
function isPremium(profile) {
  if (!profile) return false;
  if (profile.is_premium) return true;
  return !!(profile.premium_until && new Date(profile.premium_until) > new Date());
}

/* Identifiant public à 8 chiffres, celui qu'on donne à un ami pour être ajouté. */
async function ensureFriendId(uid) {
  const { data } = await supa.from('profiles').select('friend_id').eq('id', uid).maybeSingle();
  if (data && data.friend_id) return data.friend_id;
  for (let essai = 0; essai < 6; essai++) {
    const candidat = String(Math.floor(10000000 + Math.random() * 90000000));
    const { error } = await supa.from('profiles').update({ friend_id: candidat }).eq('id', uid);
    if (!error) return candidat;           // collision improbable : on retente
  }
  return null;
}

/* Lundi de la semaine en cours, au format YYYY-MM-DD (le tournoi se remet à zéro le lundi). */
function lundiCourant() {
  const d = new Date();
  const jour = (d.getUTCDay() + 6) % 7;    // 0 = lundi
  d.setUTCDate(d.getUTCDate() - jour);
  return d.toISOString().slice(0, 10);
}

app.get('/api/me', requireAuth(async (req, res) => {
  const { data } = await supa.from('profiles').select('*').eq('id', req.user.id).maybeSingle();
  res.json({
    premium: isPremium(data),
    premiumUntil: (data && data.premium_until) || null,
    friendId: (data && data.friend_id) || await ensureFriendId(req.user.id),
  });
}));

/* ---------- synchro profil complet : GET pour charger, POST pour sauvegarder ---------- */
app.get('/api/sync', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const [{ data: profile }, { data: goals }, { data: victories }] = await Promise.all([
    supa.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supa.from('goals').select('*').eq('user_id', uid).order('created_at'),
    supa.from('victories').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20),
  ]);
  if (profile && !profile.friend_id) profile.friend_id = await ensureFriendId(uid);
  res.json({
    profile: profile || null, goals: goals || [], victories: victories || [],
    premium: isPremium(profile), friendId: profile ? profile.friend_id : null,
  });
}));

app.post('/api/sync', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const { profile, goals, victories } = req.body || {};
  try {
    if (profile) {
      /* Liste blanche stricte : le navigateur ne doit JAMAIS pouvoir s'accorder le Premium
       * (is_premium, premium_until) ni modifier son identifiant public ou son parrainage. */
      const CHAMPS_CLIENT = ['nom', 'status', 'fonction', 'income', 'rent', 'charges', 'weaknesses',
        'impulse_freq', 'streak', 'saved_total', 'sous', 'block_keywords', 'price_limit', 'lang'];
      const base = { id: uid, updated_at: new Date().toISOString() };
      for (const champ of CHAMPS_CLIENT) if (profile[champ] !== undefined) base[champ] = profile[champ];
      // Montant de la semaine (tournoi) : horodaté au lundi courant pour la remise à zéro.
      if (profile.week_saved !== undefined) {
        base.week_saved = Math.max(0, Number(profile.week_saved) || 0);
        base.week_start = lundiCourant();
      }
      let { error } = await supa.from('profiles').upsert({ ...base, referral_code: uid.slice(0, 8) });
      // Migration parrainage pas encore exécutée : on sauvegarde sans la colonne plutôt que d'échouer.
      if (error && /referral_code/.test(error.message)) ({ error } = await supa.from('profiles').upsert(base));
      if (error) throw error;
    }
    if (Array.isArray(goals)) {
      const { error: delErr } = await supa.from('goals').delete().eq('user_id', uid);
      if (delErr) throw delErr;
      if (goals.length) {
        const { error: insErr } = await supa.from('goals').insert(goals.map(g => ({
          user_id: uid, name: g.name, target: g.target, current: g.current || 0,
        })));
        if (insErr) throw insErr;
      }
    }
    if (Array.isArray(victories)) {
      const { error: delErr2 } = await supa.from('victories').delete().eq('user_id', uid);
      if (delErr2) throw delErr2;
      if (victories.length) {
        const { error: insErr2 } = await supa.from('victories').insert(victories.slice(0, 20).map(v => ({
          user_id: uid, item: v.item, price: v.price, goal_name: v.goal || v.goal_name || null,
        })));
        if (insErr2) throw insErr2;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sync]', err.message);
    res.status(500).json({ error: 'sync_error', detail: err.message });
  }
}));

/* ================= AMIS & TOURNOI =================
 * Amitié en deux temps : une demande, puis une acceptation. Personne n'apparaît
 * dans le classement de quelqu'un sans y avoir consenti. */

const MAX_SEMAINES_OFFERTES = 3;   // combien de semaines Premium un utilisateur peut offrir
const DUREE_SEMAINE_MS = 7 * 24 * 60 * 60 * 1000;

/* Le montant hebdo n'est valable que pour la semaine en cours : sinon le classement
 * afficherait encore les scores de la semaine dernière. */
function montantSemaine(profile) {
  if (!profile || profile.week_start !== lundiCourant()) return 0;
  return Number(profile.week_saved) || 0;
}

async function amitiesDe(uid) {
  const { data, error } = await supa.from('friendships')
    .select('*').or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
  if (error) throw error;
  return data || [];
}

async function profilsPar(ids) {
  if (!ids.length) return {};
  const { data, error } = await supa.from('profiles')
    .select('id, nom, friend_id, streak, week_saved, week_start, saved_total').in('id', ids);
  if (error) throw error;
  const map = {};
  for (const p of data || []) map[p.id] = p;
  return map;
}

/* Vue complète : mon identifiant, mes amis, les demandes, et le classement de la semaine. */
app.get('/api/friends', requireAuth(async (req, res) => {
  const uid = req.user.id;
  try {
    const { data: moi } = await supa.from('profiles').select('*').eq('id', uid).maybeSingle();
    const monId = (moi && moi.friend_id) || await ensureFriendId(uid);

    const liens = await amitiesDe(uid);
    const autreId = (l) => (l.requester_id === uid ? l.addressee_id : l.requester_id);
    const profils = await profilsPar([...new Set(liens.map(autreId))]);
    const vue = (l) => {
      const p = profils[autreId(l)] || {};
      return { lien: l.id, nom: p.nom || 'Sans nom', friendId: p.friend_id || null,
               streak: p.streak || 0, semaine: montantSemaine(p) };
    };

    const acceptes = liens.filter((l) => l.status === 'accepted');
    const classement = [
      ...acceptes.map(vue),
      { lien: null, nom: (moi && moi.nom) || 'Toi', friendId: monId,
        streak: (moi && moi.streak) || 0, semaine: montantSemaine(moi), moi: true },
    ].sort((a, b) => b.semaine - a.semaine).map((u, i) => ({ ...u, rang: i + 1 }));

    res.json({
      monId,
      semainesOffertesRestantes: Math.max(0, MAX_SEMAINES_OFFERTES - ((moi && moi.free_weeks_sent) || 0)),
      premiumJusquA: (moi && moi.premium_until) || null,
      amis: acceptes.map(vue),
      demandesRecues: liens.filter((l) => l.status === 'pending' && l.addressee_id === uid).map(vue),
      demandesEnvoyees: liens.filter((l) => l.status === 'pending' && l.requester_id === uid).map(vue),
      classement,
    });
  } catch (err) {
    console.error('[friends]', err.message);
    res.status(500).json({ error: 'friends_error' });
  }
}));

/* Envoyer une demande à partir de l'identifiant à 8 chiffres. */
app.post('/api/friends/request', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const code = String((req.body && req.body.friendId) || '').trim();
  if (!/^\d{8}$/.test(code)) return res.status(400).json({ error: 'identifiant_invalide' });
  try {
    const { data: cible } = await supa.from('profiles').select('id, nom').eq('friend_id', code).maybeSingle();
    if (!cible) return res.status(404).json({ error: 'introuvable' });
    if (cible.id === uid) return res.status(400).json({ error: 'soi_meme' });

    const existant = (await amitiesDe(uid))
      .find((l) => l.requester_id === cible.id || l.addressee_id === cible.id);
    if (existant) {
      return res.status(409).json({ error: existant.status === 'accepted' ? 'deja_ami' : 'demande_en_cours' });
    }
    const { error } = await supa.from('friendships')
      .insert({ requester_id: uid, addressee_id: cible.id, status: 'pending' });
    if (error) throw error;
    res.json({ ok: true, nom: cible.nom || 'Sans nom' });
  } catch (err) {
    console.error('[friends/request]', err.message);
    res.status(500).json({ error: 'friends_error' });
  }
}));

/* Accepter une demande reçue. C'est ici que la semaine Premium peut être offerte. */
app.post('/api/friends/accept', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const lien = String((req.body && req.body.lien) || '');
  try {
    const { data: f } = await supa.from('friendships').select('*').eq('id', lien).maybeSingle();
    // Seul le destinataire peut accepter : on ne s'ajoute pas soi-même chez les autres.
    if (!f || f.addressee_id !== uid || f.status !== 'pending') {
      return res.status(404).json({ error: 'demande_introuvable' });
    }
    const { error } = await supa.from('friendships').update({ status: 'accepted' }).eq('id', lien);
    if (error) throw error;

    const offerte = await offrirSemaine(f.requester_id, uid);
    res.json({ ok: true, semaineOfferte: offerte });
  } catch (err) {
    console.error('[friends/accept]', err.message);
    res.status(500).json({ error: 'friends_error' });
  }
}));

/* Refuser une demande, ou retirer un ami. */
app.post('/api/friends/remove', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const lien = String((req.body && req.body.lien) || '');
  try {
    const { data: f } = await supa.from('friendships').select('*').eq('id', lien).maybeSingle();
    if (!f || (f.requester_id !== uid && f.addressee_id !== uid)) {
      return res.status(404).json({ error: 'introuvable' });
    }
    const { error } = await supa.from('friendships').delete().eq('id', lien);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[friends/remove]', err.message);
    res.status(500).json({ error: 'friends_error' });
  }
}));

/* Offre 7 jours de Premium au nouvel ami, sans carte bancaire.
 * Garde-fous : une seule fois par bénéficiaire, et un quota par offreur. */
async function offrirSemaine(offreurId, beneficiaireId) {
  const { data: beneficiaire } = await supa.from('profiles')
    .select('is_premium, premium_until, free_week_received').eq('id', beneficiaireId).maybeSingle();
  if (!beneficiaire || beneficiaire.free_week_received || isPremium(beneficiaire)) return false;

  const { data: offreur } = await supa.from('profiles')
    .select('free_weeks_sent').eq('id', offreurId).maybeSingle();
  const dejaOffertes = (offreur && offreur.free_weeks_sent) || 0;
  if (dejaOffertes >= MAX_SEMAINES_OFFERTES) return false;

  const { error } = await supa.from('profiles').update({
    premium_until: new Date(Date.now() + DUREE_SEMAINE_MS).toISOString(),
    free_week_received: true,
  }).eq('id', beneficiaireId);
  if (error) throw error;
  await supa.from('profiles').update({ free_weeks_sent: dejaOffertes + 1 }).eq('id', offreurId);
  console.log(`[amis] semaine Premium offerte à ${beneficiaireId} par ${offreurId}`);
  return true;
}

/* ---------- Stripe Checkout (nécessite un compte connecté) ---------- */
app.post('/api/create-checkout-session', requireAuth(async (req, res) => {
  const { billing, refCode } = req.body || {};
  if (!stripe) return res.json({ demo: true }); // pas de clé : le front reste en mode démo
  try {
    const ownCode = req.user.id.slice(0, 8);
    let trialDays = 0;
    const { data: profile } = await supa.from('profiles').select('*').eq('id', req.user.id).maybeSingle();
    if (profile) {
      // Premier code de parrainage fourni par cet utilisateur : on l'enregistre définitivement.
      if (refCode && !profile.referred_by && String(refCode).toLowerCase() !== ownCode) {
        const code = String(refCode).toLowerCase();
        const { error: refUpdErr } = await supa.from('profiles').update({ referred_by: code }).eq('id', req.user.id);
        if (!refUpdErr) profile.referred_by = code;
      }
      // Semaine offerte pour avoir été parrainé (une seule fois), + semaines mises en réserve pour avoir parrainé d'autres.
      if (profile.referred_by && !profile.referral_reward_given) trialDays += 7;
      if (profile.pending_referral_days > 0) trialDays += profile.pending_referral_days * 7;
    }
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
      ...(trialDays > 0 ? { subscription_data: { trial_period_days: trialDays } } : {}),
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

/* Quota IA par IP : /api/chat est public (la démo doit marcher sans compte), donc sans garde-fou
 * n'importe qui peut faire tourner la facture OpenAI. Au-delà du quota on ne bloque pas
 * l'utilisateur — le cerveau local répond, gratuitement. */
const CHAT_WINDOW_MS = 5 * 60 * 1000;
const CHAT_MAX_AI = 15;          // appels OpenAI autorisés par IP et par fenêtre
const MAX_MESSAGE_LEN = 2000;
const chatHits = new Map();      // ip -> { count, resetAt }

function aiQuotaAvailable(ip) {
  const now = Date.now();
  const hit = chatHits.get(ip);
  if (!hit || now > hit.resetAt) {
    chatHits.set(ip, { count: 1, resetAt: now + CHAT_WINDOW_MS });
    return true;
  }
  hit.count++;
  return hit.count <= CHAT_MAX_AI;
}
// purge des entrées expirées pour que la Map ne grossisse pas indéfiniment
setInterval(() => {
  const now = Date.now();
  for (const [ip, hit] of chatHits) if (now > hit.resetAt) chatHits.delete(ip);
}, CHAT_WINDOW_MS).unref();

app.post('/api/chat', async (req, res) => {
  const { message, history, context } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message manquant' });
  if (message.length > MAX_MESSAGE_LEN) return res.status(400).json({ error: 'message_trop_long' });

  if (!OPENAI_KEY) {
    return res.json({ reply: localBrain(message, context), source: 'local' });
  }
  if (!aiQuotaAvailable(req.ip)) {
    return res.json({ reply: localBrain(message, context), source: 'local-quota' });
  }
  try {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\nContexte utilisateur (JSON) :\n' + JSON.stringify(context || {}) },
      ...(Array.isArray(history) ? history.slice(-10).map(m => ({
        role: m.who === 'user' ? 'user' : 'assistant',
        content: String(m.text || '').slice(0, MAX_MESSAGE_LEN),
      })) : []),
      { role: 'user', content: message },
    ];
    const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
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

/* ---------- fallback SPA : /tarifs, /a-propos… renvoient l'app (le routing se fait côté client) ---------- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next(); // fichier réellement introuvable : vrai 404
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Worthit démarré : http://localhost:${PORT}`);
  console.log(`  Supabase : ${supa ? 'configuré (comptes + base de données réels)' : 'NON configuré (ajoute SUPABASE_URL/SUPABASE_SERVICE_KEY dans .env)'}`);
  console.log(`  Stripe : ${stripe ? 'configuré' : 'NON configuré (mode démo — ajoute STRIPE_SECRET_KEY dans .env)'}`);
  if (stripe && !process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('  ⚠ Webhook : STRIPE_WEBHOOK_SECRET absent — /api/webhook refuse tout appel.');
    console.warn('    En local : `stripe listen --forward-to localhost:3000/api/webhook` puis colle le whsec_… dans .env');
  }
  console.log(`  OpenAI : ${OPENAI_KEY ? 'configuré (' + OPENAI_MODEL + ')' : 'NON configuré (cerveau local — ajoute OPENAI_API_KEY dans .env)'}`);
});
