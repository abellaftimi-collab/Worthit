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

const crypto = require('crypto');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';         // fournisseur d'email (resend.com)
const RESEND_FROM = process.env.RESEND_FROM || 'Worthit <onboarding@resend.dev>';
const CRON_SECRET = process.env.CRON_SECRET || '';               // protège l'endpoint de récap
const APP_URL = (process.env.APP_URL || 'https://worthit-bi9e.onrender.com').replace(/\/+$/, '');

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
/* Toute route async DOIT passer par un de ces deux emballages.
 * Express 4 ne rattrape pas les promesses rejetées : sans ça, une simple erreur de base
 * laissait la requête sans réponse (le navigateur tourne dans le vide) ET faisait tomber
 * le process entier (Node ≥ 15 transforme une "unhandled rejection" en crash). */
function route(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (err) {
      console.error('[api]', req.method, req.originalUrl, err && err.message);
      if (!res.headersSent) res.status(500).json({ error: 'erreur_serveur' });
    }
  };
}
function requireAuth(handler) {
  return route(async (req, res) => {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'non_authentifie' });
    req.user = user;
    return handler(req, res);
  });
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
    // Un abonnement peut mourir sans passer par "deleted" : impayé, litige, arrêt côté Stripe.
    // Sans ce cas, le Premium restait acquis à vie après un défaut de paiement.
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const actif = ['active', 'trialing', 'past_due'].includes(sub.status);
      const { error } = await supa.from('profiles').update({ is_premium: actif })
        .eq('stripe_subscription_id', sub.id);
      if (error) throw error;
      if (!actif) console.log(`[stripe] premium retiré : abonnement ${sub.id} en statut ${sub.status}`);
    }
    res.json({ received: true });
  } catch (err) {
    // Réponse non-2xx : Stripe réessaiera automatiquement ce webhook plus tard.
    console.error('[webhook]', err.message);
    res.status(500).json({ error: 'webhook_processing_failed' });
  }
});

app.set('trust proxy', 1); // derrière le proxy Render : req.ip = vraie IP client, pas celle du proxy
app.disable('x-powered-by');                       // ne pas annoncer la techno utilisée

/* En-têtes de sécurité, appliqués à tout ce que le serveur renvoie.
 * frame-ancestors 'none' : personne ne peut charger Worthit dans une iframe pour piéger
 * les clics d'un utilisateur connecté (clickjacking sur « Supprimer mon compte »…). */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // Le front est un fichier unique : ses scripts et styles sont en ligne, d'où 'unsafe-inline'.
    // Aucun script tiers n'est autorisé — Supabase est servi depuis /vendor/ par ce serveur.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

/* Supabase servi par nous plutôt que par un CDN tiers : un CDN compromis pourrait exécuter
 * n'importe quel code sur la page où l'utilisateur est connecté. La version suit package.json.
 * Deux façons de le localiser, au cas où le paquet ajouterait un jour un champ "exports"
 * qui interdirait le chemin direct ; un test de fumée vérifie que la route répond bien. */
const SUPABASE_UMD = (() => {
  const essais = [
    () => require.resolve('@supabase/supabase-js/dist/umd/supabase.js'),
    () => path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist', 'umd', 'supabase.js'),
  ];
  for (const essai of essais) {
    try {
      const p = essai();
      if (require('fs').existsSync(p)) return p;
    } catch (e) { /* on essaie la méthode suivante */ }
  }
  return null;
})();
app.get('/vendor/supabase.js', (req, res) => {
  if (!SUPABASE_UMD) return res.status(404).type('text/plain').send('supabase-js introuvable');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.sendFile(SUPABASE_UMD);
});

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
  if (!data) return null;                  // profil pas encore créé : rien à mettre à jour
  for (let essai = 0; essai < 6; essai++) {
    const candidat = String(crypto.randomInt(10000000, 100000000));
    // .select() est indispensable : sans lui, un update qui ne touche AUCUNE ligne ne renvoie
    // pas d'erreur, et on affichait à l'utilisateur un identifiant qui n'existait nulle part.
    const { data: maj, error } = await supa.from('profiles')
      .update({ friend_id: candidat }).eq('id', uid).select('friend_id');
    if (!error && maj && maj.length) return candidat;
    if (!error) return null;               // aucune ligne mise à jour : inutile d'insister
  }
  return null;                             // collisions à répétition : très improbable
}

/* Limiteur de débit générique, en mémoire (un seul process sur Render). */
const compteursDebit = new Map();
function limiterDebit(cle, max, fenetreMs) {
  const now = Date.now();
  const hit = compteursDebit.get(cle);
  if (!hit || now > hit.resetAt) {
    compteursDebit.set(cle, { count: 1, resetAt: now + fenetreMs });
    return true;
  }
  hit.count++;
  return hit.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [cle, hit] of compteursDebit) if (now > hit.resetAt) compteursDebit.delete(cle);
}, 10 * 60 * 1000).unref();

/* Lundi de la semaine en cours, au format YYYY-MM-DD (le tournoi se remet à zéro le lundi). */
function lundiCourant() {
  const d = new Date();
  const jour = (d.getUTCDay() + 6) % 7;    // 0 = lundi
  d.setUTCDate(d.getUTCDate() - jour);
  return d.toISOString().slice(0, 10);
}

const jourUTC = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (offset || 0));
  return d.toISOString().slice(0, 10);
};

/* Le streak avance d'un jour par jour d'activité consécutif, calculé côté serveur pour qu'il
 * ne puisse pas être manipulé depuis le navigateur (comme is_premium avant lui).
 * - même jour que la dernière activité connue -> inchangé
 * - jour suivant -> +1
 * - un jour a été sauté (ou premier jour) -> repart à 1 */
function prochainStreak(streakActuel, derniereActivite) {
  const aujourdhui = jourUTC(0);
  if (derniereActivite === aujourdhui) return { streak: streakActuel || 1, last_active_date: aujourdhui };
  if (derniereActivite === jourUTC(-1)) return { streak: (streakActuel || 0) + 1, last_active_date: aujourdhui };
  return { streak: 1, last_active_date: aujourdhui };
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

/* ---------- garde-fous d'écriture (le client peut envoyer n'importe quoi) ---------- */
const MAX_OBJECTIFS = 20;
const MAX_VICTOIRES = 20;
const texteCourt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const nombrePositif = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1e9) : 0;
};

/* Remplace toutes les lignes d'un utilisateur. En cas d'échec de l'insertion, on remet
 * l'ancienne liste : sans ça, une erreur au milieu laissait l'utilisateur les mains vides. */
async function remplacerLignes(table, uid, lignes) {
  const { data: avant } = await supa.from(table).select('*').eq('user_id', uid);
  const { error: delErr } = await supa.from(table).delete().eq('user_id', uid);
  if (delErr) throw delErr;
  if (!lignes.length) return;
  const { error: insErr } = await supa.from(table).insert(lignes);
  if (insErr) {
    if (avant && avant.length) await supa.from(table).insert(avant);
    throw insErr;
  }
}

app.post('/api/sync', requireAuth(async (req, res) => {
  const uid = req.user.id;
  const { profile, goals, victories } = req.body || {};
  try {
    if (profile) {
      /* Liste blanche stricte : le navigateur ne doit JAMAIS pouvoir s'accorder le Premium
       * (is_premium, premium_until) ni modifier son identifiant public, son parrainage ou son
       * streak (sinon il suffirait d'envoyer {streak: 9999} pour débloquer tous les paliers). */
      const CHAMPS_CLIENT = ['nom', 'status', 'fonction', 'income', 'rent', 'charges', 'weaknesses',
        'impulse_freq', 'saved_total', 'sous', 'block_keywords', 'price_limit', 'lang', 'email_weekly'];
      const base = { id: uid, updated_at: new Date().toISOString() };
      for (const champ of CHAMPS_CLIENT) if (profile[champ] !== undefined) base[champ] = profile[champ];
      // Email dupliqué depuis le jeton (jamais depuis le client) : sert au récap hebdomadaire,
      // pour ne pas dépendre de l'API admin Auth au moment de l'envoi.
      if (req.user.email) base.email = req.user.email;

      const { data: courant } = await supa.from('profiles')
        .select('streak, last_active_date, week_saved, week_start').eq('id', uid).maybeSingle();

      // Streak : un jour d'activité de plus s'ajoute au plus une fois par jour calendaire (UTC).
      Object.assign(base, prochainStreak(courant && courant.streak, courant && courant.last_active_date));

      // Montant + nombre d'achats évités de la semaine (tournoi + récap), horodatés au lundi courant.
      // À la bascule de semaine, l'ancien montant est conservé dans week_saved_prev (badge progression).
      if (profile.week_saved !== undefined || profile.week_count !== undefined) {
        const aujourdhui = lundiCourant();
        if (courant && courant.week_start && courant.week_start !== aujourdhui) {
          base.week_saved_prev = Number(courant.week_saved) || 0;
        }
        if (profile.week_saved !== undefined) base.week_saved = Math.max(0, Number(profile.week_saved) || 0);
        if (profile.week_count !== undefined) base.week_count = Math.max(0, Math.round(Number(profile.week_count) || 0));
        base.week_start = aujourdhui;
      }

      let { error } = await supa.from('profiles').upsert({ ...base, referral_code: uid.slice(0, 8) });
      // Colonnes d'une migration pas encore exécutée : on sauvegarde sans elles plutôt que d'échouer
      // (mieux vaut perdre le streak du jour que casser toute la synchro du profil).
      if (error && /referral_code/.test(error.message)) ({ error } = await supa.from('profiles').upsert(base));
      if (error && /week_saved_prev/.test(error.message)) {
        const { week_saved_prev, ...sansPrev } = base;
        ({ error } = await supa.from('profiles').upsert({ ...sansPrev, referral_code: uid.slice(0, 8) }));
      }
      if (error && /last_active_date|column "streak"/.test(error.message)) {
        const { streak, last_active_date, ...sansStreak } = base;
        ({ error } = await supa.from('profiles').upsert({ ...sansStreak, referral_code: uid.slice(0, 8) }));
      }
      if (error && /week_count|email_weekly|"email"/.test(error.message)) {
        const { week_count, email_weekly, email, ...sansEmail } = base;
        ({ error } = await supa.from('profiles').upsert({ ...sansEmail, referral_code: uid.slice(0, 8) }));
      }
      if (error) throw error;
    }
    if (Array.isArray(goals)) {
      // Nettoyage AVANT toute suppression : une ligne sans nom ou sans montant faisait échouer
      // l'insertion… après que l'ancienne liste ait déjà été effacée (objectifs perdus).
      const propres = goals.slice(0, MAX_OBJECTIFS)
        .map((g) => ({ user_id: uid, name: texteCourt(g && g.name, 80), target: nombrePositif(g && g.target), current: nombrePositif(g && g.current) }))
        .filter((g) => g.name && g.target > 0);
      await remplacerLignes('goals', uid, propres);
    }
    if (Array.isArray(victories)) {
      const propres = victories.slice(0, MAX_VICTOIRES)
        .map((v) => ({ user_id: uid, item: texteCourt(v && v.item, 120), price: nombrePositif(v && v.price),
                       goal_name: texteCourt(v && (v.goal || v.goal_name), 80) || null }))
        .filter((v) => v.item);
      await remplacerLignes('victories', uid, propres);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[sync]', err.message);
    res.status(500).json({ error: 'sync_error', detail: err.message });
  }
}));

/* ================= RGPD : export et suppression =================
 * La politique de confidentialité promet l'accès, l'export et la suppression totale des
 * données à tout moment (droits RGPD) — ces deux routes tiennent cette promesse. */

/* Export complet, lisible, au format JSON téléchargeable. */
app.get('/api/export', requireAuth(async (req, res) => {
  const uid = req.user.id;
  try {
    const [{ data: profile }, { data: goals }, { data: victories }, { data: amities }] = await Promise.all([
      supa.from('profiles').select('*').eq('id', uid).maybeSingle(),
      supa.from('goals').select('*').eq('user_id', uid),
      supa.from('victories').select('*').eq('user_id', uid),
      supa.from('friendships').select('*').or(`requester_id.eq.${uid},addressee_id.eq.${uid}`),
    ]);
    const paquet = {
      export_genere_le: new Date().toISOString(),
      compte: { email: req.user.email, id_utilisateur: uid },
      profil: profile || null,
      objectifs: goals || [],
      victoires: victories || [],
      amities: amities || [],
    };
    res.setHeader('Content-Disposition', 'attachment; filename="worthit-mes-donnees.json"');
    res.json(paquet);
  } catch (err) {
    console.error('[export]', err.message);
    res.status(500).json({ error: 'export_error' });
  }
}));

/* Suppression totale et définitive du compte. */
app.delete('/api/account', requireAuth(async (req, res) => {
  const uid = req.user.id;
  try {
    // Résilie l'abonnement Stripe s'il y en a un : sinon la suppression du compte
    // laisserait un prélèvement récurrent tourner sans compte pour le voir ni l'arrêter.
    if (stripe) {
      const { data: profile } = await supa.from('profiles').select('stripe_subscription_id').eq('id', uid).maybeSingle();
      if (profile && profile.stripe_subscription_id) {
        try { await stripe.subscriptions.cancel(profile.stripe_subscription_id); }
        catch (err) { console.error('[account/delete] annulation Stripe échouée :', err.message); }
      }
    }
    // Les lignes goals/victories/friendships ont "on delete cascade" vers profiles/auth.users :
    // supprimer le compte Auth suffit, mais on nettoie explicitement profiles au cas où
    // la contrainte de cascade manquerait sur une base pas entièrement migrée.
    await supa.from('profiles').delete().eq('id', uid);
    const { error } = await supa.auth.admin.deleteUser(uid);
    if (error) throw error;
    console.log(`[compte] supprimé définitivement : ${uid}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[account/delete]', err.message);
    res.status(500).json({ error: 'delete_error' });
  }
}));

/* ================= RÉCAP HEBDOMADAIRE PAR EMAIL =================
 * Un planificateur externe (GitHub Actions) appelle /api/cron/weekly-recap chaque dimanche.
 * Pour chaque utilisateur ayant économisé cette semaine, on envoie un email récapitulatif.
 * Sans RESEND_API_KEY, l'endpoint tourne en « dry-run » : il dit qui/quoi sans rien envoyer. */

/* Jeton de désinscription : signe l'id utilisateur, pour que le lien marche sans connexion
 * tout en n'étant pas devinable. */
function unsubToken(uid) {
  // HMAC (et non un simple hash) : la clé est une vraie clé, pas un préfixe de message.
  return crypto.createHmac('sha256', CRON_SECRET || SUPABASE_SERVICE_KEY || 'worthit-dev')
    .update('unsub|' + uid).digest('hex').slice(0, 24);
}
function unsubTokenValide(uid, token) {
  const attendu = unsubToken(uid);
  const a = Buffer.from(String(token || '')); const b = Buffer.from(attendu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Preuve de Premium pour l'extension ----------
 * L'extension ne détient pas la session de l'utilisateur : elle ne peut donc pas prouver
 * qu'il est Premium. Le site lui transmet un jeton signé par le serveur, à durée limitée.
 * Un utilisateur qui bascule un drapeau dans son navigateur ne peut PAS le fabriquer. */
const PREMIUM_SECRET = CRON_SECRET || SUPABASE_SERVICE_KEY || 'worthit-dev';
function premiumToken(uid, exp) {
  return crypto.createHmac('sha256', PREMIUM_SECRET).update(String(uid) + '|' + String(exp)).digest('hex').slice(0, 32);
}
function premiumTokenValide(p) {
  if (!p || !p.uid || !p.exp || !p.token) return false;
  if (Date.now() > Number(p.exp)) return false;                 // expiré
  const attendu = premiumToken(p.uid, p.exp);
  // Comparaison à temps constant : évite de fuiter le jeton par mesure de durée.
  const a = Buffer.from(String(p.token)); const b = Buffer.from(attendu);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/api/premium-token', requireAuth(async (req, res) => {
  const { data } = await supa.from('profiles').select('*').eq('id', req.user.id).maybeSingle();
  if (!isPremium(data)) return res.json({ premium: false });
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 jours, renouvelé à chaque visite du site
  res.json({ premium: true, uid: req.user.id, exp, token: premiumToken(req.user.id, exp) });
}));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Logo Worthit en SVG inline. Les clients mail modernes le gèrent ; ceux qui ne le gèrent pas
 * n'afficheront rien de cassé (juste l'espace), le nom « worthit » restant lisible à côté. */
function logoSvg(size) {
  const id = 'wm' + size;
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" style="vertical-align:middle;display:inline-block;">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
    <path fill="url(#${id})" fill-rule="evenodd" d="M50 6a44 44 0 1 1 0 88 44 44 0 0 1 0-88Zm-9 27a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Zm18 0a5 5 0 0 0-5 5v24a5 5 0 0 0 10 0V38a5 5 0 0 0-5-5Z"/>
  </svg>`;
}

async function sendEmail(to, subject, html, entetes) {
  if (!RESEND_API_KEY) return { dryRun: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html, headers: entetes || undefined }),
  });
  if (!r.ok) throw new Error('resend ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return { sent: true };
}

function recapEmailHtml(p, uid) {
  const nom = (p.nom || '').trim();
  const saved = Math.round(Number(p.week_saved) || 0);
  const count = Math.round(Number(p.week_count) || 0);
  const streak = Number(p.streak) || 0;
  const goal = p._goal; // objectif principal, joint en amont
  const unsub = `${APP_URL}/api/unsubscribe?u=${encodeURIComponent(uid)}&t=${unsubToken(uid)}`;
  const ligneObjectif = goal
    ? `<tr><td style="padding:6px 0;color:#b9adcf;font-size:14px;">Objectif « ${esc(goal.name)} »</td><td style="padding:6px 0;color:#fff;font-size:14px;text-align:right;font-weight:600;">${Math.round(goal.current)} / ${Math.round(goal.target)} €</td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f4f2f8;padding:24px 12px;font-family:'Segoe UI',system-ui,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:linear-gradient(165deg,#1a102c,#0c0716);border-radius:20px;overflow:hidden;border:1px solid rgba(167,139,250,.3);">
        <tr><td style="padding:30px 30px 8px;">
          ${logoSvg(20)}
          <span style="color:#fff;font-size:17px;font-weight:800;letter-spacing:-.02em;vertical-align:middle;margin-left:7px;">worthit</span>
        </td></tr>
        <tr><td style="padding:8px 30px 4px;">
          <h1 style="color:#fff;font-size:22px;font-weight:800;margin:0;line-height:1.3;">${nom ? esc(nom) + ', ta' : 'Ta'} semaine 💜</h1>
        </td></tr>
        <tr><td style="padding:14px 30px 0;">
          <div style="background:linear-gradient(135deg,rgba(167,139,250,.18),rgba(124,58,237,.08));border:1px solid rgba(167,139,250,.3);border-radius:16px;padding:22px;text-align:center;">
            <div style="color:#b9adcf;font-size:13px;">Tu as gardé</div>
            <div style="color:#fff;font-size:40px;font-weight:800;letter-spacing:-.02em;margin:4px 0;">${saved} €</div>
            <div style="color:#b9adcf;font-size:13px;">en résistant à ${count} achat${count > 1 ? 's' : ''} cette semaine</div>
          </div>
        </td></tr>
        <tr><td style="padding:18px 30px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:6px 0;color:#b9adcf;font-size:14px;">🔥 Ta série</td><td style="padding:6px 0;color:#fff;font-size:14px;text-align:right;font-weight:600;">${streak} jour${streak > 1 ? 's' : ''}</td></tr>
            ${ligneObjectif}
          </table>
        </td></tr>
        <tr><td style="padding:24px 30px 8px;">
          <a href="${APP_URL}/dashboard" style="display:block;text-align:center;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px;border-radius:13px;">Voir mon tableau de bord</a>
        </td></tr>
        <tr><td style="padding:8px 30px 26px;text-align:center;">
          <span style="color:#6b6480;font-size:11px;">Worthit est du côté de l'acheteur, jamais du vendeur.<br/>
          <a href="${unsub}" style="color:#8a7fb0;">Ne plus recevoir ce récap</a></span>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

app.post('/api/cron/weekly-recap', async (req, res) => {
  if (!CRON_SECRET || req.get('x-cron-secret') !== CRON_SECRET) {
    return res.status(401).json({ error: 'non_autorise' });
  }
  if (!supa) return res.status(400).json({ error: 'supabase_non_configure' });
  // Sans clé Resend = dry-run forcé. Avec clé, on peut quand même simuler avec ?dry=1
  // (pratique pour vérifier qui serait éligible en prod sans envoyer d'email).
  const dryRun = !RESEND_API_KEY || req.query.dry === '1';
  const lundi = lundiCourant();
  try {
    // Uniquement les gens actifs cette semaine et qui n'ont pas déjà reçu ce récap.
    const { data: profils, error } = await supa.from('profiles')
      .select('id, nom, email, week_saved, week_count, streak, week_start, email_weekly, last_recap_sent')
      .eq('week_start', lundi).gt('week_saved', 0);
    if (error) throw error;

    const eligibles = (profils || []).filter((p) => p.email_weekly !== false && p.last_recap_sent !== lundi);
    const resultats = [];
    for (const p of eligibles) {
      // Email lu directement depuis profiles (fiable) ; l'API admin n'est qu'un secours.
      let email = p.email;
      if (!email) { try { const { data: u } = await supa.auth.admin.getUserById(p.id); email = u && u.user && u.user.email; } catch (e) {} }
      if (!email) continue;
      const { data: goals } = await supa.from('goals').select('name, target, current').eq('user_id', p.id).order('created_at').limit(1);
      p._goal = (goals && goals[0]) || null;
      const html = recapEmailHtml(p, p.id);
      try {
        // En dry-run on n'appelle JAMAIS l'envoi (le bug : sendEmail ne regardait que la clé Resend,
        // donc ?dry=1 envoyait quand même). On court-circuite ici, avant tout appel réseau.
        // Les en-têtes RFC 2369/8058 : le bouton « Se désabonner » natif de Gmail/Outlook.
        // Sans eux, l'utilisateur agacé clique « Spam », ce qui abîme la réputation d'envoi.
        const lienUnsub = `${APP_URL}/api/unsubscribe?u=${encodeURIComponent(p.id)}&t=${unsubToken(p.id)}`;
        const entetes = {
          'List-Unsubscribe': `<${lienUnsub}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        };
        const r = dryRun ? { dryRun: true } : await sendEmail(email, `Ta semaine Worthit : ${Math.round(p.week_saved)} € gardés 💜`, html, entetes);
        if (!dryRun) await supa.from('profiles').update({ last_recap_sent: lundi }).eq('id', p.id);
        resultats.push({ email: dryRun ? email : email.replace(/(.).+(@.*)/, '$1***$2'), saved: Math.round(p.week_saved), count: p.week_count, sent: !!r.sent, dryRun: !!r.dryRun });
      } catch (err) {
        console.error('[recap] envoi échoué', p.id, err.message);
        resultats.push({ email: email.replace(/(.).+(@.*)/, '$1***$2'), erreur: err.message });
      }
    }
    res.json({ dryRun, semaine: lundi, eligibles: eligibles.length, resultats });
  } catch (err) {
    console.error('[cron/weekly-recap]', err.message);
    res.status(500).json({ error: 'recap_error', detail: err.message });
  }
});

function pageUnsub(titre, msg, bouton) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titre)} — Worthit</title><body style="margin:0;background:#0c0716;color:#fff;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;"><div style="max-width:380px;padding:30px;">${logoSvg(18)} <span style="font-weight:800;vertical-align:middle;">worthit</span><h1 style="font-size:20px;margin:18px 0 8px;">${esc(titre)}</h1><p style="color:#b9adcf;font-size:14px;line-height:1.6;">${esc(msg)}</p>${bouton || ''}<p style="margin-top:18px;"><a href="${APP_URL}" style="color:#a78bfa;font-size:13px;">Retour à Worthit</a></p></div></body>`;
}

/* Le lien du mail n'agit PAS tout seul : il ouvre une page de confirmation.
 * Les antivirus et les aperçus de messagerie (Gmail, Outlook…) visitent les liens des emails
 * pour les analyser — avec une désinscription en GET, ils désabonnaient les gens à leur insu. */
app.get('/api/unsubscribe', route(async (req, res) => {
  const uid = String(req.query.u || '');
  const token = String(req.query.t || '');
  if (!supa || !uid || !unsubTokenValide(uid, token)) {
    return res.status(400).send(pageUnsub('Lien invalide', "Ce lien de désinscription n'est pas valide ou a expiré."));
  }
  const action = `/api/unsubscribe?u=${encodeURIComponent(uid)}&t=${encodeURIComponent(token)}`;
  res.send(pageUnsub('Ne plus recevoir le récap ?', 'Un clic pour confirmer. Tu pourras le réactiver quand tu veux depuis tes Paramètres.',
    `<form method="post" action="${esc(action)}"><button type="submit" style="margin-top:18px;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;border:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:13px;cursor:pointer;">Confirmer la désinscription</button></form>`));
}));

/* L'action réelle. Sert aussi la désinscription « en un clic » RFC 8058 des clients mail,
 * qui envoient un POST sur cette même URL. */
app.post('/api/unsubscribe', route(async (req, res) => {
  const uid = String(req.query.u || (req.body && req.body.u) || '');
  const token = String(req.query.t || (req.body && req.body.t) || '');
  if (!supa || !uid || !unsubTokenValide(uid, token)) {
    return res.status(400).send(pageUnsub('Lien invalide', "Ce lien de désinscription n'est pas valide ou a expiré."));
  }
  const { error } = await supa.from('profiles').update({ email_weekly: false }).eq('id', uid);
  if (error) throw error;
  res.send(pageUnsub('Désinscription confirmée', 'Tu ne recevras plus le récap hebdomadaire. Tu peux le réactiver à tout moment depuis tes Paramètres.'));
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

/* Amélioration par rapport à la semaine précédente, pour le badge « Plus grosse progression ».
 * Sans semaine précédente connue, la progression n'est pas mesurable (pas un badge à 0 par défaut). */
function progressionSemaine(profile) {
  if (!profile || profile.week_start !== lundiCourant()) return null;
  const precedent = profile.week_saved_prev;
  if (precedent === null || precedent === undefined) return null;
  return (Number(profile.week_saved) || 0) - Number(precedent);
}

/* Les trois badges promis sur la page Fonctionnalités, calculés sur le vrai classement.
 * En cas d'égalité, le premier de la liste (déjà triée par montant) l'emporte.
 * PAS_DE_GAGNANT (et non null) : le champ "lien" de "moi" vaut déjà null, donc "personne
 * n'a de badge" et "c'est moi qui l'ai" seraient sinon indiscernables côté client. */
const PAS_DE_GAGNANT = '(aucun)';
function calculerBadges(classement) {
  const meilleur = (fn) => classement.reduce((top, u) => {
    const v = fn(u);
    return (v !== null && (!top || v > top.valeur)) ? { id: u.lien, valeur: v } : top;
  }, null);
  // Cherche le maximum explicitement plutôt que de supposer que "classement" est déjà trié
  // par montant : plus robuste si cette fonction est un jour appelée sur une liste non triée.
  const topEconomie = meilleur(u => u.semaine > 0 ? u.semaine : null);
  const topProgression = meilleur(u => u.progression);
  const topSerie = meilleur(u => u.streak > 0 ? u.streak : null);
  return {
    topEconomieId: topEconomie ? topEconomie.id : PAS_DE_GAGNANT,
    topProgressionId: (topProgression && topProgression.valeur > 0) ? topProgression.id : PAS_DE_GAGNANT,
    topSerieId: topSerie ? topSerie.id : PAS_DE_GAGNANT,
  };
}

async function amitiesDe(uid) {
  const { data, error } = await supa.from('friendships')
    .select('*').or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
  if (error) throw error;
  return data || [];
}

async function profilsPar(ids) {
  if (!ids.length) return {};
  let { data, error } = await supa.from('profiles')
    .select('id, nom, friend_id, streak, week_saved, week_start, week_saved_prev, saved_total').in('id', ids);
  // Migration des badges pas encore exécutée : le classement reste utilisable, juste sans
  // le badge "Plus grosse progression" (progressionSemaine gère déjà l'absence du champ).
  if (error && /week_saved_prev/.test(error.message)) {
    ({ data, error } = await supa.from('profiles')
      .select('id, nom, friend_id, streak, week_saved, week_start, saved_total').in('id', ids));
  }
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
               streak: p.streak || 0, semaine: montantSemaine(p), progression: progressionSemaine(p) };
    };

    const acceptes = liens.filter((l) => l.status === 'accepted');
    let classement = [
      ...acceptes.map(vue),
      { lien: null, nom: (moi && moi.nom) || 'Toi', friendId: monId, streak: (moi && moi.streak) || 0,
        semaine: montantSemaine(moi), progression: progressionSemaine(moi), moi: true },
    ].sort((a, b) => b.semaine - a.semaine).map((u, i) => ({ ...u, rang: i + 1 }));

    // Les trois badges hebdomadaires : des CODES stables, pas des libellés en français —
    // c'est au client de les traduire selon la langue de qui regarde (t('badge.topEconomie')…).
    const badges = calculerBadges(classement);
    classement = classement.map(u => ({
      ...u,
      badges: [
        u.lien === badges.topEconomieId ? 'top_economie' : null,
        u.lien === badges.topProgressionId ? 'top_progression' : null,
        u.lien === badges.topSerieId ? 'top_serie' : null,
      ].filter(Boolean),
    }));

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
  // Sans plafond, on pouvait balayer les identifiants à 8 chiffres pour cartographier les comptes.
  // 20 essais / 10 min : très au-dessus d'un usage normal, très en dessous d'un balayage utile.
  if (!limiterDebit('ami:' + uid, 20, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'trop_de_demandes' });
  }
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

    // Celui qui a envoyé la demande (en utilisant l'identifiant de l'autre) est celui qui
    // rejoint : c'est lui le bénéficiaire. Celui qui accepte (le propriétaire de l'identifiant
    // partagé) est l'offreur — c'est son quota de semaines offertes qui est entamé.
    const offerte = await offrirSemaine(uid, f.requester_id);
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
    // Déjà abonné : ouvrir un second Checkout créerait un DEUXIÈME abonnement payant sur la
    // même carte. Le bouton est masqué côté front, mais un double-clic ou un lien direct suffisait.
    if (profile && profile.stripe_subscription_id && profile.is_premium) {
      return res.status(409).json({ error: 'deja_abonne' });
    }
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
          unit_amount: monthly ? 499 : 3999, // centimes : 4,99 € / 39,99 €
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

/* ================= ABONNEMENT : ÉTAT ET RÉSILIATION =================
 * Les CGU promettent « résiliable à tout moment depuis tes Paramètres » et la page d'accueil
 * affiche « Annulable en un clic ». Avant ces routes, le bouton « Repasser en Gratuit » ne
 * faisait que changer un drapeau dans le navigateur : l'abonnement Stripe continuait à
 * prélever. C'est ici que la promesse devient vraie. */

/* Traduit un abonnement Stripe en quelques champs simples pour le front. */
function vueAbonnement(sub) {
  if (!sub) return null;
  const article = sub.items && sub.items.data && sub.items.data[0];
  // current_period_end a migré de l'abonnement vers ses articles dans les versions récentes
  // de l'API Stripe : on lit les deux, sinon la date de fin disparaîtrait à la prochaine
  // montée de version du SDK, et l'utilisateur ne saurait plus jusqu'à quand il a payé.
  const fin = sub.cancel_at || sub.current_period_end || (article && article.current_period_end) || null;
  return {
    id: sub.id,
    statut: sub.status,                                    // active, trialing, past_due, canceled…
    resiliationProgrammee: !!sub.cancel_at_period_end,
    finLe: fin ? new Date(fin * 1000).toISOString() : null,
    interval: (sub.items && sub.items.data[0] && sub.items.data[0].plan && sub.items.data[0].plan.interval) || null,
  };
}

async function abonnementDe(uid) {
  const { data: profile } = await supa.from('profiles')
    .select('stripe_subscription_id, is_premium, premium_until').eq('id', uid).maybeSingle();
  if (!profile || !profile.stripe_subscription_id || !stripe) return { profile, sub: null };
  try {
    return { profile, sub: await stripe.subscriptions.retrieve(profile.stripe_subscription_id) };
  } catch (err) {
    // Abonnement introuvable côté Stripe (compte de test nettoyé, clé changée…) : on ne casse
    // pas la page Paramètres pour autant, on répond « pas d'abonnement suivi ».
    console.error('[abonnement] introuvable chez Stripe :', err.message);
    return { profile, sub: null };
  }
}

/* État de l'abonnement, affiché dans les Paramètres (appelé seulement à l'ouverture de la page). */
app.get('/api/subscription', requireAuth(async (req, res) => {
  const { profile, sub } = await abonnementDe(req.user.id);
  res.json({
    premium: isPremium(profile),
    premiumUntil: (profile && profile.premium_until) || null,   // semaine offerte (sans Stripe)
    abonnement: vueAbonnement(sub),
  });
}));

/* Résiliation : on garde le Premium jusqu'à la fin de la période DÉJÀ PAYÉE, comme les CGU
 * l'annoncent, puis Stripe envoie customer.subscription.deleted qui retire le Premium. */
app.post('/api/subscription/cancel', requireAuth(async (req, res) => {
  const { profile, sub } = await abonnementDe(req.user.id);
  if (!sub) {
    // Pas d'abonnement payant (semaine offerte, mode démo) : rien à résilier chez Stripe.
    return res.json({ ok: true, sansAbonnement: true, premium: isPremium(profile) });
  }
  if (sub.status === 'canceled') return res.json({ ok: true, abonnement: vueAbonnement(sub) });
  const maj = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  console.log(`[abonnement] résiliation programmée pour ${req.user.id} (${sub.id})`);
  res.json({ ok: true, abonnement: vueAbonnement(maj) });
}));

/* Se raviser avant la fin de période : on relance le même abonnement, sans repasser en caisse. */
app.post('/api/subscription/resume', requireAuth(async (req, res) => {
  const { sub } = await abonnementDe(req.user.id);
  if (!sub || sub.status === 'canceled') return res.status(404).json({ error: 'aucun_abonnement' });
  const maj = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
  res.json({ ok: true, abonnement: vueAbonnement(maj) });
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
/* Le cerveau local parle les mêmes 5 langues que le site : il répond quand OpenAI est
 * indisponible ou le quota atteint, et un utilisateur allemand ne doit pas se retrouver
 * avec du français à ce moment-là. La langue arrive dans context.langue. */
const PHRASES = {
  fr: {
    zero: "Ton budget du mois est déjà à zéro… c'est peut-être le signal le plus clair qu'on puisse avoir, non ?",
    half: (p, pct, left) => `${p} €, c'est ${pct} % de ce qu'il te reste ce mois-ci (${left} €). Presque la moitié de ta marge.\n\nMa suggestion : on pose une pause de 24 h. Si demain tu y penses encore, on en reparle.`,
    fifth: (pct, left, g) => `Ça représente ${pct} % de ton reste-à-vivre (${left} €).${g ? ` Ton objectif « ${g} » avancerait plus lentement.` : ''}\n\nQuestion honnête : besoin réel, ou envie du moment ?`,
    small: (p, pct) => `${p} €, soit ${pct} % de ce qu'il te reste. C'est raisonnable — mais est-ce que tu l'aurais acheté la semaine dernière ? Si la réponse est non, c'est peut-être l'algorithme qui a gagné, pas toi.`,
    budget: (l, r, c, i, e) => `Ce mois-ci il te reste ${l} € une fois le loyer (${r} €) et les charges (${c} €) déduits de tes ${i} €.\n\nEt tu as déjà gardé ${e} € en résistant. Pas mal, non ?`,
    motiv: (n, s, g, reste) => `${n ? n + ', t' : 'T'}a série tient depuis ${s} jours. 🔥${g ? `\n\nChaque euro non dépensé va vers « ${g} » — il en manque ${reste} €.` : ''}`,
    goalsTail: '\n\nChaque refus fait avancer ces barres.',
    hello: (n) => `Salut${n ? ' ' + n : ''} ! Une envie d'achat te trotte dans la tête ? Dis-moi quoi et à quel prix, on regarde ensemble ce que ça pèse vraiment.`,
    thanks: "Avec plaisir. Je suis là au moment du doute — c'est exactement mon travail. 💜",
    fallback: "Dis-m'en plus : c'est quoi, et ça coûte combien ? Donne-moi un prix et je te montre ce que ça représente sur ton mois.",
  },
  en: {
    zero: "Your budget for the month is already at zero… that might be the clearest signal you'll ever get, no?",
    half: (p, pct, left) => `€${p} is ${pct}% of what you have left this month (€${left}). Almost half your headroom.\n\nMy suggestion: let's put a 24 h pause on it. If you still want it tomorrow, we'll talk again.`,
    fifth: (pct, left, g) => `That's ${pct}% of your spending money (€${left}).${g ? ` Your goal “${g}” would move more slowly.` : ''}\n\nHonest question: real need, or passing urge?`,
    small: (p, pct) => `€${p}, so ${pct}% of what you have left. That's reasonable — but would you have bought it last week? If not, maybe the algorithm won, not you.`,
    budget: (l, r, c, i, e) => `This month you have €${l} left once rent (€${r}) and bills (€${c}) are taken out of your €${i}.\n\nAnd you've already kept €${e} by resisting. Not bad, right?`,
    motiv: (n, s, g, reste) => `${n ? n + ', y' : 'Y'}our streak has held for ${s} days. 🔥${g ? `\n\nEvery euro not spent goes towards “${g}” — €${reste} to go.` : ''}`,
    goalsTail: '\n\nEvery refusal pushes those bars forward.',
    hello: (n) => `Hi${n ? ' ' + n : ''}! Got a purchase on your mind? Tell me what it is and how much, and we'll look at what it really costs you.`,
    thanks: "My pleasure. I'm here for the moment of doubt — that's exactly my job. 💜",
    fallback: "Tell me more: what is it, and how much does it cost? Give me a price and I'll show you what it means for your month.",
  },
  es: {
    zero: "Tu presupuesto del mes ya está a cero… puede que sea la señal más clara que existe, ¿no?",
    half: (p, pct, left) => `${p} € es el ${pct} % de lo que te queda este mes (${left} €). Casi la mitad de tu margen.\n\nMi sugerencia: ponemos una pausa de 24 h. Si mañana sigues pensando en ello, lo hablamos.`,
    fifth: (pct, left, g) => `Eso representa el ${pct} % de tu dinero disponible (${left} €).${g ? ` Tu objetivo «${g}» avanzaría más despacio.` : ''}\n\nPregunta honesta: ¿necesidad real o antojo del momento?`,
    small: (p, pct) => `${p} €, o sea el ${pct} % de lo que te queda. Es razonable, pero ¿lo habrías comprado la semana pasada? Si la respuesta es no, quizá ganó el algoritmo, no tú.`,
    budget: (l, r, c, i, e) => `Este mes te quedan ${l} € una vez descontados el alquiler (${r} €) y los gastos (${c} €) de tus ${i} €.\n\nY ya has guardado ${e} € resistiendo. Nada mal, ¿no?`,
    motiv: (n, s, g, reste) => `${n ? n + ', t' : 'T'}u racha aguanta desde hace ${s} días. 🔥${g ? `\n\nCada euro no gastado va a «${g}»: faltan ${reste} €.` : ''}`,
    goalsTail: '\n\nCada negativa hace avanzar esas barras.',
    hello: (n) => `¡Hola${n ? ' ' + n : ''}! ¿Tienes una compra rondándote la cabeza? Dime qué es y a qué precio y miramos juntos cuánto pesa de verdad.`,
    thanks: "Un placer. Estoy aquí para el momento de duda: es exactamente mi trabajo. 💜",
    fallback: "Cuéntame más: ¿qué es y cuánto cuesta? Dame un precio y te enseño lo que supone en tu mes.",
  },
  de: {
    zero: "Dein Monatsbudget steht schon auf null … das ist vielleicht das klarste Signal überhaupt, oder?",
    half: (p, pct, left) => `${p} € sind ${pct} % von dem, was dir diesen Monat bleibt (${left} €). Fast die Hälfte deines Spielraums.\n\nMein Vorschlag: 24 Stunden Pause. Wenn du morgen noch daran denkst, reden wir weiter.`,
    fifth: (pct, left, g) => `Das sind ${pct} % deines verfügbaren Geldes (${left} €).${g ? ` Dein Ziel „${g}“ käme langsamer voran.` : ''}\n\nEhrliche Frage: echter Bedarf oder Lust des Moments?`,
    small: (p, pct) => `${p} €, also ${pct} % von dem, was dir bleibt. Das ist vertretbar — aber hättest du es letzte Woche gekauft? Wenn nein, hat vielleicht der Algorithmus gewonnen, nicht du.`,
    budget: (l, r, c, i, e) => `Diesen Monat bleiben dir ${l} €, wenn Miete (${r} €) und Fixkosten (${c} €) von deinen ${i} € abgezogen sind.\n\nUnd du hast schon ${e} € behalten, indem du widerstanden hast. Nicht schlecht, oder?`,
    motiv: (n, s, g, reste) => `${n ? n + ', d' : 'D'}eine Serie hält seit ${s} Tagen. 🔥${g ? `\n\nJeder nicht ausgegebene Euro geht an „${g}“ — es fehlen noch ${reste} €.` : ''}`,
    goalsTail: '\n\nJede Absage bringt diese Balken voran.',
    hello: (n) => `Hallo${n ? ' ' + n : ''}! Geht dir ein Kauf durch den Kopf? Sag mir was und zu welchem Preis, dann schauen wir, was es wirklich wiegt.`,
    thanks: "Sehr gern. Ich bin für den Moment des Zweifels da — genau das ist mein Job. 💜",
    fallback: "Erzähl mir mehr: Was ist es, und was kostet es? Nenn mir einen Preis, und ich zeige dir, was das für deinen Monat bedeutet.",
  },
  nl: {
    zero: "Je budget voor deze maand staat al op nul… dat is misschien wel het duidelijkste signaal dat er bestaat, niet?",
    half: (p, pct, left) => `€ ${p} is ${pct} % van wat je deze maand overhoudt (€ ${left}). Bijna de helft van je ruimte.\n\nMijn voorstel: 24 uur pauze. Denk je er morgen nog aan, dan praten we verder.`,
    fifth: (pct, left, g) => `Dat is ${pct} % van je besteedbare geld (€ ${left}).${g ? ` Je doel ‘${g}’ zou trager vooruitgaan.` : ''}\n\nEerlijke vraag: echte behoefte of opwelling?`,
    small: (p, pct) => `€ ${p}, oftewel ${pct} % van wat je overhoudt. Dat is redelijk — maar had je het vorige week gekocht? Zo niet, dan won misschien het algoritme, niet jij.`,
    budget: (l, r, c, i, e) => `Deze maand hou je € ${l} over als huur (€ ${r}) en vaste lasten (€ ${c}) van je € ${i} af zijn.\n\nEn je hebt al € ${e} bewaard door te weerstaan. Niet slecht, toch?`,
    motiv: (n, s, g, reste) => `${n ? n + ', j' : 'J'}e reeks houdt het al ${s} dagen vol. 🔥${g ? `\n\nElke niet-uitgegeven euro gaat naar ‘${g}’ — er is nog € ${reste} nodig.` : ''}`,
    goalsTail: '\n\nElke weigering duwt die balken vooruit.',
    hello: (n) => `Hoi${n ? ' ' + n : ''}! Zit er een aankoop in je hoofd? Zeg me wat en voor hoeveel, dan kijken we samen wat het echt weegt.`,
    thanks: "Graag gedaan. Ik ben er op het moment van twijfel — dat is precies mijn werk. 💜",
    fallback: "Vertel me meer: wat is het en wat kost het? Geef me een prijs en ik laat zien wat dat betekent voor je maand.",
  },
};

function localBrain(raw, ctx) {
  ctx = ctx || {};
  const p = PHRASES[ctx.langue] || PHRASES.fr;
  const t = String(raw).toLowerCase();
  const left = Number(ctx.reste) || 0;
  const name = ctx.nom || '';
  const goals = Array.isArray(ctx.objectifs) ? ctx.objectifs : [];
  const goal = goals[0];
  const m = String(raw).match(/(\d+[.,]?\d*)\s*€?/);
  if (m && parseFloat(m[1].replace(',', '.')) > 0) {
    const price = parseFloat(m[1].replace(',', '.'));
    const pct = left > 0 ? Math.round((price / left) * 100) : null;
    if (pct === null) return p.zero;
    if (pct >= 50) return p.half(price, pct, left);
    if (pct >= 20) return p.fifth(pct, left, goal && goal.name);
    return p.small(price, pct);
  }
  if (/budget|reste|argent|combien|money|left|dinero|geld|budget/.test(t)) {
    return p.budget(left, ctx.loyer || 0, ctx.charges || 0, ctx.revenu || 0, ctx.economise || 0);
  }
  if (/motiv|encourag|craquer|envie|dur|urge|tempted|ánimo|animo|versuch|verleid/.test(t)) {
    return p.motiv(name, ctx.streak || 0, goal && goal.name, goal ? goal.target - goal.current : 0);
  }
  if (/objectif|épargne|epargne|goal|saving|objetivo|ahorro|ziel|sparen|doel/.test(t) && goals.length) {
    return goals.map(g => `« ${g.name} » : ${g.current} / ${g.target} € (${Math.round((g.current / g.target) * 100)} %)`).join('\n') + p.goalsTail;
  }
  if (/bonjour|salut|hello|coucou|hey|hi|hola|hallo|hoi/.test(t)) return p.hello(name);
  if (/merci|top|cool|nickel|thanks|thank you|gracias|danke|bedankt/.test(t)) return p.thanks;
  return p.fallback;
}

/* Quota IA par IP : /api/chat est public (la démo doit marcher sans compte), donc sans garde-fou
 * n'importe qui peut faire tourner la facture OpenAI. Au-delà du quota on ne bloque pas
 * l'utilisateur — le cerveau local répond, gratuitement. */
const CHAT_WINDOW_MS = 5 * 60 * 1000;
const CHAT_MAX_AI = 15;          // visiteur anonyme : quota volontairement serré
const CHAT_MAX_AI_PREMIUM = 60;  // Premium PROUVÉ par jeton signé : quota confortable
const MAX_MESSAGE_LEN = 2000;
const chatHits = new Map();      // clé -> { count, resetAt }

function aiQuotaAvailable(cle, plafond) {
  const now = Date.now();
  const hit = chatHits.get(cle);
  if (!hit || now > hit.resetAt) {
    chatHits.set(cle, { count: 1, resetAt: now + CHAT_WINDOW_MS });
    return true;
  }
  hit.count++;
  return hit.count <= plafond;
}
// purge des entrées expirées pour que la Map ne grossisse pas indéfiniment
setInterval(() => {
  const now = Date.now();
  for (const [ip, hit] of chatHits) if (now > hit.resetAt) chatHits.delete(ip);
}, CHAT_WINDOW_MS).unref();

app.post('/api/chat', route(async (req, res) => {
  const { message, history, context, premiumAuth } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message manquant' });
  if (message.length > MAX_MESSAGE_LEN) return res.status(400).json({ error: 'message_trop_long' });

  if (!OPENAI_KEY) {
    return res.json({ reply: localBrain(message, context), source: 'local' });
  }
  /* Premium prouvé par jeton signé serveur : quota par compte (pas par IP) et plus large.
   * Sans jeton valide, on retombe sur le quota anonyme, quoi que prétende le navigateur. */
  const estPremium = premiumTokenValide(premiumAuth);
  const cle = estPremium ? 'u:' + premiumAuth.uid : 'ip:' + req.ip;
  if (!aiQuotaAvailable(cle, estPremium ? CHAT_MAX_AI_PREMIUM : CHAT_MAX_AI)) {
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
}));

/* ---------- fallback SPA : /tarifs, /a-propos… renvoient l'app (le routing se fait côté client) ---------- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next(); // fichier réellement introuvable : vrai 404
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* Une route d'API qui n'existe pas doit répondre en JSON : le front fait r.json() sur
 * toutes ses réponses et se prenait une page HTML d'erreur en pleine figure. */
app.use('/api', (req, res) => res.status(404).json({ error: 'route_inconnue' }));

/* Filet de sécurité final : une erreur qui a échappé à tout le reste ne doit pas fuiter
 * de trace d'exécution vers le navigateur. */
app.use((err, req, res, next) => {
  console.error('[erreur]', req.method, req.originalUrl, err && err.message);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'erreur_serveur' });
  res.status(500).type('text/plain').send('Erreur serveur');
});

// Une promesse rejetée sans surveillance faisait tomber tout le serveur (Node ≥ 15).
// On la journalise et on reste debout : les utilisateurs connectés ne sont pas éjectés.
process.on('unhandledRejection', (raison) => {
  console.error('[unhandledRejection]', (raison && raison.stack) || raison);
});
// Une exception non rattrapée laisse le process dans un état incertain : on note et on sort
// proprement, Render relance aussitôt un serveur sain.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && err.stack) || err);
  process.exit(1);
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
  console.log(`  Récap email : ${RESEND_API_KEY ? 'configuré (Resend)' : 'dry-run (ajoute RESEND_API_KEY pour envoyer réellement)'}${CRON_SECRET ? '' : ' — ⚠ CRON_SECRET absent : /api/cron/weekly-recap refuse tout appel'}`);
});
