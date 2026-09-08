/**
 * guard.js — the bot-protection layers every form endpoint runs before it is
 * allowed to send anything.
 *
 * Four layers, all server-side, all enforced before the first Resend call:
 *
 *   1. Cloudflare Turnstile   token verified against siteverify
 *   2. Honeypot + dwell time  a field people never see, and a 3s floor
 *   3. Sanity validation      phone digits, email MX, length, placeholders
 *   4. Per-IP rate limit      3 accepted submissions per hour, per form
 *
 * NOTHING here trusts the browser for a verdict. The client-side script exists
 * only to make the widget invisible and the errors legible; every decision that
 * matters is taken in this file, from the request the Worker actually received.
 *
 * The one layer that is genuinely unforgeable is Turnstile. The honeypot and
 * the dwell timer are cheap filters measured by the client and therefore
 * forgeable by anyone who bothers — they are worth having because most form
 * spam does not bother, not because they are proof of anything. That is stated
 * here so nobody later mistakes them for the load-bearing layer and drops
 * Turnstile.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DOH = 'https://cloudflare-dns.com/dns-query';

/** Dwell floor. A person cannot read, type and submit a quote form faster. */
export const MIN_DWELL_MS = 3000;

/** Per-form, per-IP cap on submissions that actually send. */
export const RATE_LIMIT = { max: 3, windowMs: 60 * 60 * 1000 };

/**
 * Values that arrive instead of an answer. Compared after normalising: lower
 * case, punctuation and whitespace stripped. Kept short on purpose — a list
 * that guesses at real answers costs the client leads.
 */
const PLACEHOLDERS = new Set([
  'x', 'xx', 'xxx', 'xxxx', 'test', 'tests', 'testing', 'testtest', 'atest',
  'asdf', 'asdfasdf', 'asd', 'sdf', 'sdfsdf', 'fdsa', 'qwerty', 'qwer',
  'abc', 'abcd', 'abcde', 'aaa', 'aaaa', 'aa', 'bbb', 'zzz',
  'none', 'na', 'nil', 'null', 'undefined', 'nothing', 'nope',
  'sample', 'demo', 'example', 'foo', 'bar', 'foobar',
  'johndoe', 'janedoe', 'firstname', 'lastname', 'yourname', 'fullname',
  'fname', 'lname', 'yourcompany', 'mycompany', 'companyname',
  '123', '1234', '12345', '123456', '1111', '0000',
]);

const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** "aaaa", "....", "1111" — one character repeated is never a real answer. */
const isRepeatedChar = (s) => {
  const t = String(s).trim();
  return t.length >= 2 && /^(.)\1*$/.test(t);
};

export const isPlaceholder = (value) => {
  const n = normalise(value);
  if (!n) return false;
  return PLACEHOLDERS.has(n) || isRepeatedChar(value.trim());
};

export const digitsOf = (value) => String(value).replace(/[^0-9]/g, '');

/**
 * Everything about where a submission came from, in one object. Every field
 * comes from the edge or from a value we re-derive here — none of it is taken
 * on the browser's word, apart from `page`, which is checked to be one of our
 * own URLs before it is used.
 */
export function originOf(request, body) {
  const url = new URL(request.url);
  const cf = request.cf || {};

  // The page the form was on. Prefer the form's own hidden field (survives a
  // referrer policy that strips the header), fall back to Referer. Either way
  // it has to be a URL on this host, or it is dropped: this string ends up in
  // an email the client clicks.
  let page = '';
  for (const candidate of [body?.page_url, request.headers.get('Referer')]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(String(candidate));
      if (parsed.host === url.host && /^https?:$/.test(parsed.protocol)) {
        page = parsed.toString();
        break;
      }
    } catch {
      /* not a URL — ignore it */
    }
  }

  return {
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    country: cf.country || '',
    region: cf.region || '',
    city: cf.city || '',
    asOrganization: cf.asOrganization || '',
    page: page || `${url.origin}/`,
    host: url.host,
    userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
    at: new Date().toISOString(),
  };
}

/** One line per rejection, structured so it can be grepped or piped. */
export function logRejection(form, reason, origin, detail) {
  console.warn(
    'form-reject ' +
      JSON.stringify({
        evt: 'form-reject',
        form,
        reason,
        ip: origin.ip,
        country: origin.country,
        city: origin.city,
        page: origin.page,
        ts: origin.at,
        ...(detail ? { detail } : {}),
      }),
  );
}

/** The mirror of the above, so an accepted send is greppable the same way. */
export function logAccepted(form, origin, detail) {
  console.log(
    'form-accept ' +
      JSON.stringify({
        evt: 'form-accept',
        form,
        ip: origin.ip,
        country: origin.country,
        city: origin.city,
        page: origin.page,
        ts: origin.at,
        ...(detail ? { detail } : {}),
      }),
  );
}

/* ------------------------------------------------------------------ *
 * 1. Turnstile
 * ------------------------------------------------------------------ */

/**
 * Verify the widget token against siteverify.
 *
 * Fails CLOSED, including when TURNSTILE_SECRET_KEY is missing. An endpoint
 * that quietly waves submissions through because a secret was never set is the
 * failure mode this whole change exists to remove — so a missing secret is a
 * loud 500, exactly like a missing RESEND_API_KEY, not a silent bypass.
 *
 * Returns { ok } or { ok:false, status, error, reason }.
 */
export async function verifyTurnstile(request, body, env, origin, form) {
  if (!env.TURNSTILE_SECRET_KEY) {
    // TODO(setup): wrangler secret put TURNSTILE_SECRET_KEY
    console.error(
      'guard: TURNSTILE_SECRET_KEY missing at runtime — every submission is ' +
        'being refused. Set it with `wrangler secret put TURNSTILE_SECRET_KEY`. ' +
        'A Build variable does not work: it is absent when this code runs.',
    );
    logRejection(form, 'turnstile-not-configured', origin);
    return {
      ok: false,
      status: 500,
      reason: 'turnstile-not-configured',
      error: 'The form is not configured. Please call us on (416) 244-6497.',
    };
  }

  const token = String(body['cf-turnstile-response'] ?? '').trim();
  if (!token) {
    logRejection(form, 'turnstile-missing-token', origin);
    return {
      ok: false,
      status: 403,
      reason: 'turnstile-missing-token',
      error:
        'The security check did not complete. Please reload the page and try ' +
        'again, or call us on (416) 244-6497.',
    };
  }

  let data;
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: origin.ip === 'unknown' ? undefined : origin.ip,
        // Lets Cloudflare answer a retried verification consistently rather
        // than treating the second attempt as a replayed token.
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(6000),
    });
    data = await res.json();
  } catch (err) {
    // Siteverify is unreachable. Fail closed: an outage that turns the form
    // into an open relay is worse than an outage that turns it off.
    logRejection(form, 'turnstile-unreachable', origin, err.message);
    return {
      ok: false,
      status: 503,
      reason: 'turnstile-unreachable',
      error:
        'We could not complete the security check just now. Please try again ' +
        'in a moment, or call us on (416) 244-6497.',
    };
  }

  if (!data?.success) {
    const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : [];
    logRejection(form, 'turnstile-failed', origin, codes.join(',') || 'unknown');

    // The mistake this catches is a real one: a widget whose allowed-hostname
    // list does not include the hostname the site is actually served on fails
    // with nothing in the response that says so.
    if (codes.includes('invalid-input-response')) {
      console.error(
        `guard: turnstile rejected a token on host ${origin.host}. If this is ` +
          'every submission rather than one, check that this hostname is in ' +
          "the widget's allowed hostnames in the Cloudflare dashboard.",
      );
    }

    return {
      ok: false,
      status: 403,
      reason: 'turnstile-failed',
      error:
        'The security check did not pass. Please reload the page and try ' +
        'again, or call us on (416) 244-6497.',
    };
  }

  if (data.hostname && data.hostname !== origin.host) {
    console.warn(
      `guard: turnstile token was issued for ${data.hostname} but arrived on ` +
        `${origin.host}.`,
    );
  }

  return { ok: true, challengeTs: data.challenge_ts || '' };
}

/* ------------------------------------------------------------------ *
 * 2. Honeypot + dwell time
 * ------------------------------------------------------------------ */

/**
 * The honeypot field is named `website` on every form here. It has to be a name
 * no real form on this site uses — the pressure-washing quote form has a real,
 * required `company` field, so `company` (the old honeypot name on the estimate
 * form) could not stay.
 *
 * A hit answers 202/303 — a success, as far as the sender can tell. Telling a
 * bot it failed only teaches it to retry with the field left blank.
 */
export const HONEYPOT_FIELD = 'website';

export function honeypotTripped(body) {
  return Boolean(String(body[HONEYPOT_FIELD] ?? '').trim());
}

/**
 * Dwell time. The browser records when the form was rendered and sends how many
 * milliseconds elapsed; elapsed rather than a wall-clock timestamp so a visitor
 * whose clock is wrong is not rejected for it.
 *
 * Forgeable, and meant to be understood that way — see the file header.
 */
export function checkDwell(body) {
  const raw = body.form_elapsed_ms;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, reason: 'dwell-missing' };
  }
  const elapsed = Number(raw);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return { ok: false, reason: 'dwell-malformed' };
  }
  if (elapsed < MIN_DWELL_MS) {
    return { ok: false, reason: 'dwell-too-fast', detail: `${Math.round(elapsed)}ms` };
  }
  return { ok: true, elapsed };
}

export const DWELL_ERROR =
  'That went through faster than we can accept. Please take a moment and ' +
  'submit again.';

/* ------------------------------------------------------------------ *
 * 3. Sanity validation
 * ------------------------------------------------------------------ */

// Deliberately loose. Address validity is proven by mail being answered, not by
// a regex, and an over-strict pattern silently drops real enquiries. The MX
// lookup below is what actually establishes the domain can receive mail.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Does this email domain accept mail?
 *
 * MX first. A domain with no MX but an A/AAAA record still receives mail —
 * RFC 5321 §5.1 makes the address record an implicit MX — so that counts, and
 * treating it as a failure would reject real small-business addresses.
 *
 * Fails OPEN on a DNS error or timeout: a DoH hiccup must never cost a lead.
 * Only an authoritative "this domain does not exist" or "this domain publishes
 * no way to receive mail" is a rejection.
 */
export async function domainAcceptsMail(domain) {
  const ask = async (type) => {
    const res = await fetch(
      `${DOH}?name=${encodeURIComponent(domain)}&type=${type}`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(2500),
        cf: { cacheTtl: 1800, cacheEverything: true },
      },
    );
    if (!res.ok) throw new Error(`DoH ${type} responded ${res.status}`);
    return res.json();
  };

  try {
    const mx = await ask('MX');
    if (mx.Status === 3) return { ok: false, reason: 'email-domain-nxdomain' };
    if (mx.Status !== 0) return { ok: true, soft: `MX status ${mx.Status}` };
    if ((mx.Answer || []).some((a) => a.type === 15)) return { ok: true };

    // No MX. Implicit-MX fallback before giving up on the address.
    const [a, aaaa] = await Promise.all([ask('A'), ask('AAAA')]);
    const hasAddress =
      (a.Answer || []).some((r) => r.type === 1) ||
      (aaaa.Answer || []).some((r) => r.type === 28);
    return hasAddress ? { ok: true } : { ok: false, reason: 'email-domain-no-mx' };
  } catch (err) {
    return { ok: true, soft: err.message };
  }
}

export const EMAIL_MX_ERROR =
  "That email domain isn't accepting mail, so we would have no way to reply. " +
  'Please check the address.';

/* ------------------------------------------------------------------ *
 * 4. Per-IP rate limit
 * ------------------------------------------------------------------ */

/**
 * Three accepted submissions per hour, per form, per IP, in KV.
 *
 * Counted on the way OUT, not on the way in: `check` reads, `record` writes,
 * and `record` is called only once a submission has actually sent. A real
 * person who fumbles validation three times is therefore not locked out of the
 * form, while nobody can make it send more than three emails in an hour.
 *
 * The flood brake for requests that never reach the send — malformed payloads,
 * failed Turnstile — is the Workers rate-limiting binding in wrangler.jsonc,
 * which is per-colo and much cheaper. The two are complementary; neither
 * replaces the other.
 *
 * Fails OPEN if the KV binding is absent, and says so loudly. The binding is
 * declared in wrangler.jsonc; a missing one means the namespace id was never
 * filled in.
 */
const rateKey = (form, ip) => `rl:${form}:${ip}`;

export async function checkRateLimit(env, form, origin) {
  if (!env.FORM_RATE_LIMIT) {
    // TODO(setup): create the KV namespace and put its id in wrangler.jsonc.
    console.error(
      'guard: FORM_RATE_LIMIT KV binding missing — the hourly per-IP limit is ' +
        'not being enforced. Create the namespace and set its id in ' +
        'wrangler.jsonc.',
    );
    return { ok: true, unenforced: true };
  }

  const now = Date.now();
  let hits = [];
  try {
    const stored = await env.FORM_RATE_LIMIT.get(rateKey(form, origin.ip), {
      type: 'json',
    });
    if (Array.isArray(stored)) hits = stored;
  } catch (err) {
    console.error('guard: KV read failed —', err.message);
    return { ok: true, unenforced: true };
  }

  const recent = hits.filter(
    (t) => typeof t === 'number' && now - t < RATE_LIMIT.windowMs,
  );
  if (recent.length >= RATE_LIMIT.max) {
    return { ok: false, reason: 'rate-limited', count: recent.length };
  }
  return { ok: true, recent };
}

export async function recordSubmission(env, form, origin, recent = []) {
  if (!env.FORM_RATE_LIMIT) return;
  const now = Date.now();
  const kept = [
    ...recent.filter((t) => now - t < RATE_LIMIT.windowMs),
    now,
  ].slice(-RATE_LIMIT.max);
  try {
    await env.FORM_RATE_LIMIT.put(rateKey(form, origin.ip), JSON.stringify(kept), {
      // A little past the window so the last entry is still there to expire.
      expirationTtl: Math.ceil(RATE_LIMIT.windowMs / 1000) + 300,
    });
  } catch (err) {
    console.error('guard: KV write failed —', err.message);
  }
}

export const RATE_LIMIT_ERROR =
  'We have already had a few requests from this connection in the last hour. ' +
  'Please call us on (416) 244-6497 and we will take the details over the phone.';

/**
 * The per-colo brake declared in wrangler.jsonc. Applied to every request that
 * gets as far as having a body, including ones that will be rejected, so a
 * flood of deliberately malformed payloads is capped too.
 *
 * Cloudflare documents this binding as "permissive, eventually consistent, and
 * intentionally designed to not be used as an accurate accounting system" — it
 * is counted per data centre, so a caller spread across colos gets a multiple
 * of the configured limit. It is a brake on the naive case, not a guarantee.
 */
export async function checkBurstLimit(env, origin) {
  if (!env.CONTACT_RATE_LIMIT) return { ok: true };
  const { success } = await env.CONTACT_RATE_LIMIT.limit({ key: origin.ip });
  return success ? { ok: true } : { ok: false, reason: 'burst-limited' };
}

export const BURST_LIMIT_ERROR =
  'Too many submissions from this connection. Please try again shortly.';
