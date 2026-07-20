/*
 * Tests de fumée : on démarre un vrai serveur et on tape sur les routes.
 * Aucune dépendance, aucun appel réseau sortant (l'API OpenAI est remplacée par un stub local).
 *
 *   npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHAT_MAX_AI = 15; // doit rester aligné avec server.js

let server, stub, BASE, stubCalls = 0;

/* Faux endpoint OpenAI : évite tout appel réseau réel et rend le quota testable. */
function startStub() {
  return new Promise(resolve => {
    stub = http.createServer((req, res) => {
      stubCalls++;
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'réponse stub' } }] }));
      });
    }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${stub.address().port}`));
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      fetch(url).then(resolve).catch(err => {
        if (Date.now() > deadline) return reject(new Error('serveur non démarré : ' + err.message));
        setTimeout(attempt, 150);
      });
    })();
  });
}

before(async () => {
  const stubUrl = await startStub();
  const port = 3100 + Math.floor(Math.random() * 800);
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      // Clé Stripe factice : suffit à instancier le SDK, aucun appel réseau dans ces tests.
      STRIPE_SECRET_KEY: 'sk_test_factice',
      STRIPE_WEBHOOK_SECRET: '',       // volontairement absent : on teste le refus
      OPENAI_API_KEY: 'sk-factice',
      OPENAI_BASE_URL: stubUrl,
      SUPABASE_URL: '',
      SUPABASE_SERVICE_KEY: '',
    },
    stdio: 'ignore',
  });
  await waitForServer(BASE + '/');
});

after(() => {
  if (server) server.kill();
  if (stub) stub.close();
});

/* ---------------- le site se sert ---------------- */

test('la page d\'accueil répond en HTML', async () => {
  const r = await fetch(BASE + '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /Achète moins/);
  assert.match(html, /og:image/, 'les meta de partage doivent être présentes');
});

test('les URLs réelles renvoient l\'app (fallback SPA)', async () => {
  for (const route of ['/tarifs', '/a-propos', '/confidentialite', '/tournois']) {
    const r = await fetch(BASE + route);
    assert.strictEqual(r.status, 200, `${route} devrait répondre 200`);
    assert.match(await r.text(), /<title>Worthit/);
  }
});

test('les fichiers SEO et icônes sont servis', async () => {
  for (const [file, type] of [
    ['/robots.txt', /text\/plain/],
    ['/sitemap.xml', /xml/],
    ['/favicon.svg', /svg/],
    ['/og.png', /image\/png/],
    ['/apple-touch-icon.png', /image\/png/],
  ]) {
    const r = await fetch(BASE + file);
    assert.strictEqual(r.status, 200, `${file} devrait exister`);
    assert.match(r.headers.get('content-type'), type, `${file} : mauvais type`);
  }
});

test('un fichier inexistant renvoie bien 404, pas la page d\'accueil', async () => {
  const r = await fetch(BASE + '/nexiste-pas.png');
  assert.strictEqual(r.status, 404);
});

/* ---------------- sécurité ---------------- */

test('le webhook Stripe refuse un événement non signé', async () => {
  // Sans STRIPE_WEBHOOK_SECRET, accepter ce corps reviendrait à offrir le Premium à qui le demande.
  const r = await fetch(BASE + '/api/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'utilisateur-pirate', customer: 'cus_x' } },
    }),
  });
  assert.strictEqual(r.status, 500, 'un webhook non vérifiable doit être rejeté');
});

test('les routes privées exigent une authentification', async () => {
  const routes = [
    ['GET', '/api/me'],
    ['GET', '/api/sync'],
    ['POST', '/api/sync'],
    ['POST', '/api/create-checkout-session'],
    ['GET', '/api/verify-session?session_id=cs_test'],
  ];
  for (const [method, route] of routes) {
    const r = await fetch(BASE + route, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.strictEqual(r.status, 401, `${method} ${route} devrait répondre 401`);
  }
});

/* ---------------- agent Worthy ---------------- */

test('le chat répond et valide son entrée', async () => {
  const ask = (body) => fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  const ok = await ask({ message: 'Je veux des sneakers à 149 €', context: { reste: 440 } });
  assert.strictEqual(ok.status, 200);
  assert.ok((await ok.json()).reply.length > 0, 'une réponse non vide est attendue');

  assert.strictEqual((await ask({})).status, 400, 'message manquant → 400');
  assert.strictEqual((await ask({ message: 'x'.repeat(2001) })).status, 400, 'message trop long → 400');
});

test('le quota IA bascule sur le cerveau local au lieu de laisser filer la facture', async () => {
  const ask = () => fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Motive-moi', context: { reste: 300, streak: 4 } }),
  }).then(r => r.json());

  const before = stubCalls;
  let sawQuota = false;
  // Le test précédent a déjà consommé une unité de quota : on couvre largement la fenêtre.
  for (let i = 0; i < CHAT_MAX_AI + 3; i++) {
    const { reply, source } = await ask();
    assert.ok(reply && reply.length > 0, 'l\'utilisateur ne doit jamais rester sans réponse');
    if (source === 'local-quota') sawQuota = true;
  }
  assert.ok(sawQuota, 'le quota aurait dû se déclencher');
  assert.ok(stubCalls - before <= CHAT_MAX_AI,
    `pas plus de ${CHAT_MAX_AI} appels à l'IA par fenêtre (observé : ${stubCalls - before})`);
});
