/**
 * Staging worker for lp.rexdalemobilewash.ca.
 *
 * Two jobs:
 *   1. POST /api/estimate — takes the estimate form and mails it through
 *      Mailgun. Everything else falls through to the static-asset binding.
 *   2. A noindex header on every response. That header is unconditional and
 *      deliberate: this worker is the STAGING deployment and must never be
 *      indexed alongside the real site. If this config is ever reused for
 *      production, remove the header first.
 *
 * `run_worker_first: true` in wrangler.jsonc is what makes the POST route
 * reachable at all — without it a request matching a static asset never
 * invokes the worker.
 */

const FORM_PATH = '/api/estimate';

/** Fallback recipient, overridable with the FORM_TO secret. */
const DEFAULT_TO = 'dispatch@rexdalemobilewash.ca';

/** Longest value we will accept per field, to keep a mail body sane. */
const LIMITS = { name: 120, email: 200, phone: 60, city: 120, message: 4000 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === FORM_PATH || url.pathname === `${FORM_PATH}/`) {
      return withNoindex(await handleEstimate(request, env));
    }

    const asset = await env.ASSETS.fetch(request);
    return withNoindex(new Response(asset.body, asset));
  },
};

function withNoindex(res) {
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}

/* ------------------------------------------------------------------ route */

async function handleEstimate(request, env) {
  if (request.method !== 'POST') {
    return reply(request, 405, 'Method not allowed.', { Allow: 'POST' });
  }

  const config = readConfig(env);
  if (!config.ok) {
    // Deployed but not yet provisioned. Say so plainly rather than pretending
    // the enquiry was sent — a dropped enquiry is worse than a visible error.
    console.error(`estimate form not configured: missing ${config.missing.join(', ')}`);
    return reply(
      request,
      503,
      'The form is not connected yet — please call (416) 244-6497.'
    );
  }

  let fields;
  try {
    fields = await readFields(request);
  } catch {
    return reply(request, 400, 'Could not read that submission.');
  }

  // Honeypot: a real browser leaves it empty because it is hidden. Answer 200
  // so a bot sees success and does not retry with the field cleared.
  if (fields._gotcha) {
    return reply(request, 200, 'Thanks — we will be in touch shortly.');
  }

  // Set by JS on page load. Absent when JS is off, so only checked when present.
  const elapsed = Number(fields._ts) ? Date.now() - Number(fields._ts) : null;
  if (elapsed !== null && elapsed >= 0 && elapsed < 2000) {
    return reply(request, 200, 'Thanks — we will be in touch shortly.');
  }

  const invalid = validate(fields);
  if (invalid) return reply(request, 400, invalid);

  try {
    await sendViaMailgun(config, fields, request);
  } catch (err) {
    console.error('mailgun send failed:', err && err.message ? err.message : err);
    return reply(
      request,
      502,
      'We could not send that just now — please call (416) 244-6497.'
    );
  }

  return reply(request, 200, 'Thanks — we will be in touch shortly.');
}

/* ----------------------------------------------------------------- config */

/**
 * Secrets, all set with `wrangler secret put` — never in wrangler.jsonc.
 *   MAILGUN_API_KEY        required
 *   MAILGUN_DOMAIN         required, the Mailgun sending domain
 *   FORM_FROM              optional, defaults to the domain's postmaster
 *   FORM_TO                optional, defaults to DEFAULT_TO
 *   MAILGUN_REGION         optional, 'eu' routes to api.eu.mailgun.net
 */
function readConfig(env) {
  const missing = [];
  if (!env.MAILGUN_API_KEY) missing.push('MAILGUN_API_KEY');
  if (!env.MAILGUN_DOMAIN) missing.push('MAILGUN_DOMAIN');
  if (missing.length) return { ok: false, missing };

  const host =
    String(env.MAILGUN_REGION || '').toLowerCase() === 'eu'
      ? 'api.eu.mailgun.net'
      : 'api.mailgun.net';

  return {
    ok: true,
    endpoint: `https://${host}/v3/${encodeURIComponent(env.MAILGUN_DOMAIN)}/messages`,
    apiKey: env.MAILGUN_API_KEY,
    from: env.FORM_FROM || `Rexdale Mobile Wash Website <postmaster@${env.MAILGUN_DOMAIN}>`,
    to: env.FORM_TO || DEFAULT_TO,
  };
}

/* ------------------------------------------------------------------ input */

async function readFields(request) {
  const type = request.headers.get('content-type') || '';
  const raw = type.includes('application/json')
    ? await request.json()
    : Object.fromEntries(await request.formData());

  const pick = (key) => String(raw[key] ?? '').trim();
  return {
    name: pick('name'),
    email: pick('email'),
    phone: pick('phone'),
    city: pick('city'),
    message: pick('message'),
    source: pick('source') || 'unknown',
    _gotcha: pick('_gotcha'),
    _ts: pick('_ts'),
  };
}

function validate(f) {
  if (!f.name) return 'Please enter your name.';
  if (!f.email) return 'Please enter your email address.';
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(f.email)) {
    return 'That email address does not look right.';
  }
  if (!f.phone) return 'Please enter a phone number.';

  for (const [key, max] of Object.entries(LIMITS)) {
    if (f[key].length > max) return `That ${key} is too long.`;
  }
  // Header injection guard: these three land in a Reply-To or a Subject.
  if (/[\r\n]/.test(f.name + f.email + f.phone)) return 'Please remove line breaks.';
  return null;
}

/* ------------------------------------------------------------------- send */

async function sendViaMailgun(config, f, request) {
  const cf = request.cf || {};
  const meta = [
    ['Form', f.source],
    ['IP', request.headers.get('cf-connecting-ip') || 'unknown'],
    ['Country', cf.country || 'unknown'],
    ['Received', new Date().toISOString()],
  ];

  const text = [
    `Name:    ${f.name}`,
    `Email:   ${f.email}`,
    `Phone:   ${f.phone}`,
    `City:    ${f.city || '—'}`,
    '',
    'Message:',
    f.message || '(none)',
    '',
    '—',
    ...meta.map(([k, v]) => `${k}: ${v}`),
  ].join('\n');

  const body = new URLSearchParams({
    from: config.from,
    to: config.to,
    subject: `New estimate request — ${f.name}${f.city ? ` (${f.city})` : ''}`,
    text,
    'h:Reply-To': f.email,
    'o:tag': 'estimate-form',
  });

  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`api:${config.apiKey}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`mailgun ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
}

/* ---------------------------------------------------------------- respond */

/**
 * Three shapes for the same outcome:
 *   - JSON, when the page submitted over fetch.
 *   - a 303 to /thank-you on success without JS. 303 so the browser re-issues
 *     as GET and Back does not re-submit.
 *   - a self-contained HTML page on failure without JS, because a static site
 *     has nowhere to render a flash message.
 */
function reply(request, status, message, headers = {}) {
  const ok = status >= 200 && status < 300;

  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok, message }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    });
  }

  if (ok) {
    return new Response(null, { status: 303, headers: { Location: '/thank-you', ...headers } });
  }

  return new Response(errorPage(message), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
  });
}

function wantsJson(request) {
  return (request.headers.get('accept') || '').includes('application/json');
}

function errorPage(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>We could not send that — Rexdale Mobile Wash</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #164E83; color: #fff; padding: 40px 20px;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 1.75rem; margin: 0 0 0.75em; color: #D4E4ED; }
  p { font-size: 1rem; line-height: 1.6; margin: 0 0 1.5em; }
  a { color: #D4E4ED; }
</style>
</head>
<body>
<main>
  <h1>We could not send that</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Back to the form</a></p>
</main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
