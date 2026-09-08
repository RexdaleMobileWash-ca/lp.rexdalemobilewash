#!/usr/bin/env node
/**
 * prove-bot-protection.mjs — run the two form endpoints for real and check what
 * they do.
 *
 *     cd site && node bin/prove-bot-protection.mjs
 *
 * The handlers are imported and called directly with a real Request, so what
 * runs is worker/contact.js and worker/quote.js exactly as deployed. Two things
 * are faked and nothing else:
 *
 *   - Resend is a local HTTP server, so a proof run counts sends instead of
 *     mailing the client. env.RESEND_ENDPOINT points the Worker at it; that
 *     variable exists for this file and must never be set in production.
 *   - KV is a Map, so the hourly limit can be exercised without a namespace.
 *
 * Turnstile is NOT faked. The requests go to the real siteverify endpoint using
 * Cloudflare's published test secrets — `1x0…AA` always passes, `2x0…AA` always
 * fails — so the verification path being proved is the one that runs in
 * production. Likewise the MX check talks to real DNS.
 *
 * Exits non-zero if any expectation fails.
 */
import { createServer } from 'node:http';
import { handleContact } from '../worker/contact.js';
import { handleQuote } from '../worker/quote.js';

const TURNSTILE_PASS = '1x0000000000000000000000000000000AA';
const TURNSTILE_FAIL = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const HOST = 'staging-lp-rexdalemobilewash.ash-47a.workers.dev';

/* ---------------------------------------------------------------- mock Resend */

const sends = [];
const resend = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    sends.push({
      idempotencyKey: req.headers['idempotency-key'] || null,
      payload: JSON.parse(raw || '{}'),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `mock-${sends.length}` }));
  });
});
await new Promise((r) => resend.listen(0, '127.0.0.1', r));
const RESEND_ENDPOINT = `http://127.0.0.1:${resend.address().port}/emails`;

/* ------------------------------------------------------------------- fake env */

const kv = new Map();
const makeEnv = (over = {}) => ({
  SITE_NAME: 'Rexdale Mobile Wash',
  CONTACT_FROM: 'Rexdale Mobile Wash <forms@brandingcentres.com>',
  CONTACT_TO: 'dispatch@rexdalemobilewash.ca',
  CONTACT_CC: 'Paolo@tboxstudio.com',
  CONTACT_REPLY_TO: 'dispatch@rexdalemobilewash.ca',
  CONTACT_CONFIRM: 'true',
  RESEND_API_KEY: 'mock-key',
  RESEND_ENDPOINT,
  TURNSTILE_SECRET_KEY: TURNSTILE_PASS,
  FORM_RATE_LIMIT: {
    async get(key, opts) {
      const v = kv.get(key);
      if (v === undefined) return null;
      return opts?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      kv.set(key, value);
    },
  },
  ...over,
});

const waited = [];
const ctx = { waitUntil: (p) => waited.push(p) };

function makeRequest(path, body, { ip = '203.0.113.7' } = {}) {
  const request = new Request(`https://${HOST}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: `https://${HOST}`,
      Referer: `https://${HOST}/`,
      'CF-Connecting-IP': ip,
      'User-Agent': 'prove-bot-protection/1.0',
    },
    body: JSON.stringify(body),
  });
  Object.defineProperty(request, 'cf', {
    value: { country: 'CA', region: 'Ontario', city: 'Toronto', asOrganization: 'Test ISP' },
  });
  return request;
}

/* --------------------------------------------------------------- form payloads */

const GOOD_CONTACT = {
  name: 'Dana Whitfield',
  email: 'dana.whitfield@gmail.com',
  phone: '(416) 555-0184',
  city: 'Etobicoke',
  message: 'Storefront and sidewalk, monthly.',
  website: '',
  form_elapsed_ms: '19400',
  page_url: `https://${HOST}/`,
  'cf-turnstile-response': DUMMY_TOKEN,
};

const GOOD_QUOTE = {
  name: 'Marcus Reilly',
  company: 'Northline Logistics',
  email: 'marcus@gmail.com',
  phone: '416-555-0117',
  property_type: 'Warehouse / Distribution Centre',
  message: 'Loading dock concrete, two bays.',
  placement: 'hero',
  website: '',
  form_elapsed_ms: '31200',
  page_url: `https://${HOST}/pressure-washing/`,
  'cf-turnstile-response': DUMMY_TOKEN,
};

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ipCounter = 0;
/** A fresh IP per case, so one case's rate-limit state never leaks into another. */
const nextIp = () => `203.0.113.${++ipCounter}`;

async function run(label, { handler, path, body, env = makeEnv(), ip = nextIp() }) {
  const before = sends.length;
  const res = await handler(makeRequest(path, body, { ip }), env, ctx);
  await Promise.allSettled(waited.splice(0));
  const payload = await res.clone().json().catch(() => ({}));
  return { label, status: res.status, payload, sent: sends.length - before };
}

function expect(result, { status, sent, note }) {
  const ok = result.status === status && result.sent === sent;
  if (!ok) failures += 1;
  const detail = result.payload?.error
    ? ` — "${String(result.payload.error).slice(0, 72)}"`
    : '';
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${result.label}\n` +
      `        expected ${status} / ${sent} email(s), got ` +
      `${result.status} / ${result.sent}${detail}` +
      (note ? `\n        ${note}` : ''),
  );
}

const header = (s) => console.log(`\n=== ${s} ===`);

/* ------------------------------------------------------------- 1. no token */

header('A POST with no Turnstile token is refused, and nothing is sent');

expect(
  await run('/api/contact — no cf-turnstile-response', {
    handler: handleContact,
    path: '/api/contact',
    body: { ...GOOD_CONTACT, 'cf-turnstile-response': '' },
  }),
  { status: 403, sent: 0 },
);

expect(
  await run('/api/quote — no cf-turnstile-response', {
    handler: handleQuote,
    path: '/api/quote',
    body: { ...GOOD_QUOTE, 'cf-turnstile-response': '' },
  }),
  { status: 403, sent: 0 },
);

expect(
  await run('/api/contact — token present but rejected by siteverify', {
    handler: handleContact,
    path: '/api/contact',
    body: GOOD_CONTACT,
    env: makeEnv({ TURNSTILE_SECRET_KEY: TURNSTILE_FAIL }),
  }),
  { status: 403, sent: 0, note: 'real siteverify call, always-fails test secret' },
);

expect(
  await run('/api/contact — TURNSTILE_SECRET_KEY not set (fails closed)', {
    handler: handleContact,
    path: '/api/contact',
    body: GOOD_CONTACT,
    env: makeEnv({ TURNSTILE_SECRET_KEY: '' }),
  }),
  { status: 500, sent: 0 },
);

/* ------------------------------------------------ 2. honeypot and dwell time */

header('Honeypot and dwell time');

const honeypot = await run('/api/contact — honeypot filled', {
  handler: handleContact,
  path: '/api/contact',
  body: { ...GOOD_CONTACT, website: 'http://spam.example' },
});
expect(honeypot, {
  status: 202,
  sent: 0,
  note: 'answered as a success so the bot does not retry',
});
if (honeypot.payload?.ok !== true) {
  failures += 1;
  console.log('FAIL  honeypot response should look like a success to the sender');
}

expect(
  await run('/api/quote — honeypot filled', {
    handler: handleQuote,
    path: '/api/quote',
    body: { ...GOOD_QUOTE, website: 'x' },
  }),
  { status: 202, sent: 0 },
);

expect(
  await run('/api/contact — submitted after 1.2s', {
    handler: handleContact,
    path: '/api/contact',
    body: { ...GOOD_CONTACT, form_elapsed_ms: '1200' },
  }),
  { status: 400, sent: 0 },
);

expect(
  await run('/api/quote — no dwell field at all', {
    handler: handleQuote,
    path: '/api/quote',
    body: { ...GOOD_QUOTE, form_elapsed_ms: undefined },
  }),
  { status: 400, sent: 0 },
);

/* --------------------------------------------------- 3. sanity validation */

header('Server-side sanity validation');

const sanity = [
  ['phone with 5 digits', handleContact, '/api/contact', { ...GOOD_CONTACT, phone: '55501' }],
  ['one-character name', handleContact, '/api/contact', { ...GOOD_CONTACT, name: 'D' }],
  ['placeholder name "asdf"', handleContact, '/api/contact', { ...GOOD_CONTACT, name: 'asdf' }],
  ['placeholder city "test"', handleContact, '/api/contact', { ...GOOD_CONTACT, city: 'test' }],
  [
    'email domain with no MX',
    handleContact,
    '/api/contact',
    { ...GOOD_CONTACT, email: 'someone@nx-domain-that-does-not-exist-9f2a1.ca' },
  ],
  ['one-character company', handleQuote, '/api/quote', { ...GOOD_QUOTE, company: 'N' }],
  ['placeholder company "xxx"', handleQuote, '/api/quote', { ...GOOD_QUOTE, company: 'xxx' }],
  [
    'property type not on the list',
    handleQuote,
    '/api/quote',
    { ...GOOD_QUOTE, property_type: 'Nuclear silo' },
  ],
];

for (const [label, handler, path, body] of sanity) {
  expect(await run(`${path} — ${label}`, { handler, path, body }), {
    status: 400,
    sent: 0,
  });
}

/* --------------------------------------------- 4. a real submission, once */

header('A valid submission still works, and sends exactly once');

const contactIp = nextIp();
const good = await run('/api/contact — complete, valid submission', {
  handler: handleContact,
  path: '/api/contact',
  body: GOOD_CONTACT,
  ip: contactIp,
});
// One notification to the client plus one confirmation to the enquirer, which
// is what CONTACT_CONFIRM=true means in wrangler.jsonc. Two emails, two
// different recipients, neither one duplicated.
expect(good, { status: 202, sent: 2, note: '1 notification + 1 confirmation' });

const lastTwo = sends.slice(-2);
const notification = lastTwo.find((s) => s.payload.to?.[0] === 'dispatch@rexdalemobilewash.ca');
const confirmation = lastTwo.find((s) => s.payload.to?.[0] === GOOD_CONTACT.email);

const check = (ok, message) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
};

check(!!notification, 'exactly one notification, to dispatch@rexdalemobilewash.ca');
check(!!confirmation, 'exactly one confirmation, to the enquirer');
check(
  lastTwo.every((s) => s.idempotencyKey),
  'both carry an Idempotency-Key, so a double invocation cannot double-send',
);
check(
  notification?.payload.from === 'Rexdale Mobile Wash <forms@brandingcentres.com>',
  'From is still the shared sending domain, unchanged',
);

const notifText = notification?.payload.text || '';
for (const field of [
  `Page:     https://${HOST}/`,
  `IP:       ${contactIp}`,
  'Location: Toronto, Ontario, CA',
]) {
  check(notifText.includes(field), `notification records origin — ${field.trim()}`);
}

const quoteIp = nextIp();
const goodQuote = await run('/api/quote — complete, valid submission', {
  handler: handleQuote,
  path: '/api/quote',
  body: GOOD_QUOTE,
  ip: quoteIp,
});
expect(goodQuote, { status: 202, sent: 1, note: 'one notification, no confirmation' });

const quoteMail = sends.at(-1);
check(
  quoteMail?.payload.subject === 'New quote request — Marcus Reilly (Northline Logistics)',
  'quote notification subject names the enquirer and company',
);
check(
  (quoteMail?.payload.text || '').includes(`IP:       ${quoteIp}`),
  'quote notification records the submitting IP',
);
check(
  (quoteMail?.payload.text || '').includes('pressure washing — hero'),
  'quote notification names which of the two forms it was',
);

/* --------------------------------------------------------- 5. rate limit */

header('Per-IP rate limit: 3 accepted submissions per hour, per form');

const floodEnv = makeEnv();
const floodIp = nextIp();
const outcomes = [];
for (let i = 1; i <= 4; i += 1) {
  const before = sends.length;
  const res = await handleContact(
    makeRequest('/api/contact', { ...GOOD_CONTACT, message: `Attempt ${i}` }, { ip: floodIp }),
    floodEnv,
    ctx,
  );
  await Promise.allSettled(waited.splice(0));
  outcomes.push({ status: res.status, sent: sends.length - before });
}

const accepted = outcomes.filter((o) => o.status === 202).length;
const blocked = outcomes.filter((o) => o.status === 429).length;
check(accepted === 3, `first three submissions accepted (got ${accepted})`);
check(blocked === 1, `fourth submission refused with 429 (got ${blocked})`);
check(
  outcomes[3].sent === 0,
  'the refused submission sent nothing at all (0 emails)',
);

/* -------------------------------------------------------------------- end */

resend.close();
console.log(
  `\n${failures === 0 ? 'All expectations met.' : `${failures} expectation(s) FAILED.`}`,
);
process.exit(failures === 0 ? 0 : 1);
