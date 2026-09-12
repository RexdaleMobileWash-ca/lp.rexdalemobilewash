/**
 * POST /api/contact — the estimate form endpoint.
 *
 * Runs on the Worker at request time. It is deliberately NOT an Astro page:
 * the site builds with output 'static', so anything under src/pages is
 * prerendered to a file and would accept nothing. Putting the route here also
 * keeps the noindex wrapper in worker/index.js intact, which the
 * @astrojs/cloudflare adapter would have replaced.
 *
 * ADDRESSING — this is the part worth not "improving" casually:
 *
 *   From ....... forms@brandingcentres.com   the SHARED sending domain
 *   Reply-To ... dispatch@rexdalemobilewash.ca   the client's own address
 *
 * rexdalemobilewash.ca is NEVER used as a sending domain. That is what makes
 * it impossible for this endpoint to touch the client's existing Microsoft 365
 * mail reputation — no SPF, DKIM or DMARC record of theirs is involved.
 *
 * The visitor's address never goes in From. To a receiving mail server that is
 * forgery, and it is the fastest way to land every notification in spam. The
 * visitor's address goes in the body, as a mailto: link.
 *
 * The API key is env.RESEND_API_KEY, a Worker SECRET. A key added under Build
 * settings instead is present while the build runs and absent when this code
 * executes: the build passes and the form 500s in production. Set it with
 * `wrangler secret put RESEND_API_KEY`, never in wrangler.jsonc vars.
 *
 * SPAM — four layers, in the order a submission meets them:
 *
 *   1. Origin check      a foreign Origin header is refused outright
 *   2. Honeypot          a filled hidden field gets 202 and no email
 *   3. Per-IP rate limit 8/min, permissive by construction (see below)
 *   4. reCAPTCHA v3      a score from Google, thresholded here
 *
 * env.RECAPTCHA_SECRET is the second Worker SECRET and carries the same trap as
 * the first: it belongs to ONE Worker, so staging and production each need
 * their own `wrangler secret put RECAPTCHA_SECRET`. It is the SECRET half of
 * the pair; the public site key is baked into the pages by
 * src/lib/recaptcha.ts, which is also where the evidence that this key pair is
 * v3 rather than v2 is written down.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SITEVERIFY_ENDPOINT = 'https://www.google.com/recaptcha/api/siteverify';

/**
 * reCAPTCHA v3 score below which a submission is refused.
 *
 * v3 does not return pass/fail — it returns 0.0 (almost certainly a bot) to 1.0
 * (almost certainly a person) and the site decides. 0.5 is Google's documented
 * default and is the right starting point for a form nobody has traffic data
 * for yet. Override per environment with the RECAPTCHA_MIN_SCORE var.
 *
 * Raise it only against evidence. Every tenth of a point costs real enquiries:
 * a first-time visitor on a VPN or a locked-down corporate network scores low
 * for reasons that have nothing to do with being a bot, and this form's whole
 * purpose is that those people reach the client. The Worker logs the score of
 * every submission it sees, pass or fail, so the decision can be made from the
 * observability logs rather than guessed at.
 */
const DEFAULT_MIN_SCORE = 0.5;

// Caps are generous for a real enquiry and small enough that a payload can not
// be used to blow out the Resend request.
//
// `organization`, `property_type` and `source` are optional and come from the
// /pressure-washing/ commercial forms; the Elementor-replica forms send neither.
// Everything here is stripped of control characters by clean(), which is what
// keeps a value safe to interpolate into the subject header.
const LIMITS = {
  name: 120,
  email: 200,
  phone: 60,
  city: 120,
  organization: 160,
  property_type: 80,
  source: 60,
  message: 4000,
};

/**
 * Honeypot field names. Real people never see these, so anything that arrives
 * filled in is a bot.
 *
 * There are two because the two form families were built at different times and
 * name their trap differently — the Elementor-replica forms
 * (`EstimateForm.astro`) use `company`, the commercial LP forms use `botcheck`.
 *
 * `company` being a trap is the reason the commercial forms send their real
 * company name as `organization`. Wiring their visible, REQUIRED "Company *"
 * field to `company` would have made every genuine commercial lead look like a
 * bot: 202, no email, no error anywhere, and nobody the wiser until someone
 * asked why the quote requests stopped.
 */
const HONEYPOTS = ['company', 'botcheck'];

/**
 * Where the reCAPTCHA token arrives. `recaptcha_token` is what this site's
 * forms post (RECAPTCHA_FIELD in src/lib/recaptcha.ts); `g-recaptcha-response`
 * is the name Google's own widget uses, accepted so a hand-built form — or a
 * v2 widget, if this ever becomes one — verifies without a Worker change.
 *
 * Tokens are around 500-2000 characters. The cap is there so a payload cannot
 * be used to blow out the request to Google, for the same reason LIMITS exists.
 */
const TOKEN_FIELDS = ['recaptcha_token', 'g-recaptcha-response'];
const TOKEN_MAX = 4000;

// Deliberately loose. Address validity is proven by mail being answered, not
// by a regex, and an over-strict pattern silently drops real enquiries.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Read either a JSON body or a urlencoded form post into a plain object. */
async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) {
    try {
      const parsed = await request.json();
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (
    type.includes('application/x-www-form-urlencoded') ||
    type.includes('multipart/form-data')
  ) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }
  return null;
}

function clean(body) {
  const out = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    out[field] = String(body[field] ?? '')
      // Strip control characters: invisible in the email, and a bare CR/LF in a
      // value that reaches a header is a header-injection vector.
      .replace(/[\u0000-\u001F\u007F]/g, field === 'message' ? '\n' : ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  }
  return out;
}

function validate(v) {
  const errors = {};
  if (!v.name) errors.name = 'Please enter your name.';
  if (!v.email) errors.email = 'Please enter your email address.';
  else if (!EMAIL_RE.test(v.email)) errors.email = 'That email address looks wrong.';
  if (!v.phone) errors.phone = 'Please enter a phone number.';
  return errors;
}

/** Pull the token out of the raw body, whichever of the two names carries it. */
function readToken(body) {
  for (const field of TOKEN_FIELDS) {
    const value = String(body[field] ?? '').trim();
    if (value) return value.slice(0, TOKEN_MAX);
  }
  return '';
}

/**
 * Verify a reCAPTCHA v3 token with Google.
 *
 * Returns { ok, reason, score } — `ok:false` means refuse the submission.
 *
 * THREE DECISIONS WORTH KNOWING, because each one trades spam against real
 * enquiries and the wrong default loses the client leads silently:
 *
 * 1. NO SECRET CONFIGURED -> ALLOW.
 *    RECAPTCHA_SECRET is a Worker secret, and a secret belongs to ONE Worker:
 *    a Worker created fresh, or a second environment, starts without it — the
 *    exact trap RESEND_API_KEY documents further up. If a missing secret
 *    blocked submissions, the first deploy to a Worker that has not had the
 *    secret set would reject every enquiry on the site with no visible cause.
 *    So it degrades to what protected the form before reCAPTCHA existed (the
 *    honeypot, the Origin check and the per-IP rate limit) and says so loudly
 *    in the logs. This branch is a deploy state, not something a submitter can
 *    reach for.
 *
 * 2. GOOGLE UNREACHABLE -> ALLOW.
 *    If siteverify times out or answers with something that is not JSON, the
 *    submission goes through. An outage at Google must not take the client's
 *    lead form down with it, and a caller cannot force this branch — they can
 *    only make their own token invalid, which is case 3.
 *
 * 3. TOKEN MISSING, REJECTED, OR SCORED TOO LOW -> REFUSE.
 *    A missing token is the ordinary signature of a script posting straight to
 *    /api/contact, which is most of what this endpoint is here to stop. It also
 *    means a visitor with JavaScript disabled can no longer submit: v3 is
 *    JavaScript, there is no no-JS path through it, and a form that accepted
 *    tokenless posts would be exactly as open as it was before.
 *
 * The `action` the token carries is logged but NOT enforced. Google suggests
 * checking it, and here it would buy nothing: both forms post to this one
 * endpoint and get identical treatment, so a token "replayed" from one form to
 * the other has gained nothing. What enforcing it WOULD buy is a silent failure
 * the day someone adds a third form and forgets to add its action to the list.
 */
async function verifyRecaptcha(env, token, ip) {
  if (!env.RECAPTCHA_SECRET) {
    console.warn(
      'contact: RECAPTCHA_SECRET not set — submission accepted without verification. ' +
        'Set it with `wrangler secret put RECAPTCHA_SECRET` on THIS environment.',
    );
    return { ok: true, reason: 'unconfigured' };
  }

  if (!token) return { ok: false, reason: 'missing-token' };

  let data;
  try {
    const res = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.RECAPTCHA_SECRET,
        response: token,
        // Google treats remoteip as optional and advisory. CF-Connecting-IP is
        // the real client address at the edge; the Worker's own address is not.
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    data = await res.json();
  } catch (err) {
    console.error('contact: siteverify unreachable, allowing —', err.message);
    return { ok: true, reason: 'verifier-unavailable' };
  }

  const score = typeof data.score === 'number' ? data.score : null;

  if (!data.success) {
    // `invalid-input-secret` here means the secret does not match the site key
    // the pages are built with — check src/lib/recaptcha.ts against the key
    // pair in the reCAPTCHA admin console before blaming the submission.
    console.warn(
      'contact: reCAPTCHA rejected —',
      (data['error-codes'] || []).join(',') || 'no error code',
    );
    return { ok: false, reason: 'rejected', score };
  }

  const min = Number(env.RECAPTCHA_MIN_SCORE ?? DEFAULT_MIN_SCORE);
  const threshold = Number.isFinite(min) ? min : DEFAULT_MIN_SCORE;

  // Logged on every submission, not just failures: the only honest way to pick
  // a threshold later is to see what real enquiries actually score here.
  console.log(
    `contact: reCAPTCHA score=${score === null ? 'n/a' : score} action=${
      data.action || 'n/a'
    } threshold=${threshold}`,
  );

  // A v2 token has no score. `success` is the whole answer there, so a null
  // score passes rather than being compared against a threshold that means
  // nothing for it.
  if (score !== null && score < threshold) {
    return { ok: false, reason: 'low-score', score };
  }

  return { ok: true, reason: 'verified', score };
}

function notificationEmail(env, v, meta) {
  const row = (label, value) =>
    value
      ? `<tr>
           <td style="padding:6px 14px 6px 0;color:#5b6b7a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;vertical-align:top;white-space:nowrap">${esc(label)}</td>
           <td style="padding:6px 0;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">${value}</td>
         </tr>`
      : '';

  const html = `<div style="background:#f4f7f9;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #d4e4ed">
    <div style="background:#164E83;padding:16px 22px">
      <p style="margin:0;color:#fff;font:600 16px/1.3 -apple-system,Segoe UI,Roboto,sans-serif">
        New estimate request
      </p>
      <p style="margin:2px 0 0;color:#d4e4ed;font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif">
        ${esc(env.SITE_NAME || 'Rexdale Mobile Wash')}
      </p>
    </div>
    <div style="padding:20px 22px">
      <table style="border-collapse:collapse;width:100%">
        ${row('Name', esc(v.name))}
        ${row('Company', esc(v.organization))}
        ${row('Email', `<a href="mailto:${esc(v.email)}" style="color:#164E83">${esc(v.email)}</a>`)}
        ${row('Phone', `<a href="tel:${esc(v.phone.replace(/[^0-9+]/g, ''))}" style="color:#164E83">${esc(v.phone)}</a>`)}
        ${row('City', esc(v.city))}
        ${row('Property type', esc(v.property_type))}
        ${row('Form', esc(v.source))}
      </table>
      ${
        v.message
          ? `<p style="margin:18px 0 6px;color:#5b6b7a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">Message</p>
             <div style="white-space:pre-wrap;color:#111;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f9;border-radius:4px;padding:12px 14px">${esc(v.message)}</div>`
          : ''
      }
      <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e6edf2;color:#8a97a3;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
        Sent from the ${esc(env.SITE_NAME || 'Rexdale Mobile Wash')} website form${meta.city ? ` · ${esc(meta.city)}` : ''}${meta.country ? `, ${esc(meta.country)}` : ''}<br>
        Reply to this message and it goes to ${esc(env.CONTACT_REPLY_TO)}. To answer the
        enquirer directly, use ${esc(v.email)}.
      </p>
    </div>
  </div>
</div>`;

  const text = [
    `New estimate request — ${env.SITE_NAME || 'Rexdale Mobile Wash'}`,
    '',
    `Name:  ${v.name}`,
    v.organization ? `Company: ${v.organization}` : null,
    `Email: ${v.email}`,
    `Phone: ${v.phone}`,
    v.city ? `City:  ${v.city}` : null,
    v.property_type ? `Property type: ${v.property_type}` : null,
    v.source ? `Form:  ${v.source}` : null,
    '',
    v.message ? `Message:\n${v.message}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');

  // No Cc. Notifications go to the client and nowhere else — TBOX Studio is not
  // copied on enquiries. This was `cc: [env.CONTACT_CC]` and was removed on
  // request; do not reinstate it without being asked, and note that removing the
  // var alone is not enough, because a var can be set on the Worker outside this
  // repo.
  return {
    from: env.CONTACT_FROM,
    to: [env.CONTACT_TO],
    reply_to: [env.CONTACT_REPLY_TO],
    // `source` is in the subject so commercial-LP quote requests are separable
    // from the main landing page's enquiries in the inbox, without opening
    // either one. Control characters are already stripped by clean(), which is
    // what stops a crafted value breaking out into a second header.
    subject: `New estimate request — ${v.name}${v.city ? ` (${v.city})` : ''}${
      v.source ? ` [${v.source}]` : ''
    }`,
    html,
    text,
  };
}

/**
 * What to echo back when the enquirer left the message box empty. The
 * commercial forms make property type required and the message optional, so for
 * those it is the most useful thing they actually told us.
 */
const summary = (v) =>
  [v.phone, v.property_type, v.city].filter(Boolean).join(' · ');

function confirmationEmail(env, v) {
  const site = env.SITE_NAME || 'Rexdale Mobile Wash';
  const html = `<div style="background:#f4f7f9;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;border:1px solid #d4e4ed;padding:24px">
    <p style="margin:0 0 14px;color:#164E83;font:600 18px/1.3 -apple-system,Segoe UI,Roboto,sans-serif">Thanks for getting in touch</p>
    <p style="margin:0 0 14px;color:#111;font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif">
      Hi ${esc(v.name)}, we have your request and one of our team will get back to
      you shortly. If it is urgent, call us on
      <a href="tel:4162446497" style="color:#164E83">(416) 244-6497</a>.
    </p>
    <p style="margin:0 0 6px;color:#5b6b7a;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">What you sent us</p>
    <div style="white-space:pre-wrap;color:#111;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f9;border-radius:4px;padding:12px 14px">${esc(
      v.message || summary(v),
    )}</div>
    <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e6edf2;color:#8a97a3;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
      ${esc(site)} · this is an automatic confirmation, but replies reach a real person.
    </p>
  </div>
</div>`;

  const text = `Hi ${v.name},

Thanks for getting in touch with ${site}. We have your request and one of our
team will get back to you shortly. If it is urgent, call (416) 244-6497.

What you sent us:
${v.message || summary(v)}

— ${site}`;

  return {
    from: env.CONTACT_FROM,
    to: [v.email],
    reply_to: [env.CONTACT_REPLY_TO],
    subject: `We got your request — ${site}`,
    html,
    text,
  };
}

async function sendEmail(env, payload) {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || `Resend responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function handleContact(request, env, ctx) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Use POST.' });
  }

  // A browser form post always carries Origin. A missing Origin is a non-browser
  // client (the deploy proof uses curl) and is allowed; a foreign one is not.
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json(403, { ok: false, error: 'Cross-origin submissions are not accepted.' });
  }

  const wantsJson = (request.headers.get('Accept') || '').includes('application/json');

  const body = await readBody(request);
  if (!body) {
    return json(415, { ok: false, error: 'Send JSON or a urlencoded form body.' });
  }

  // Honeypot. Answer 202 rather than an error: a bot told it failed simply
  // retries. See HONEYPOTS for why there are two names.
  if (HONEYPOTS.some((field) => String(body[field] ?? '').trim())) {
    return wantsJson
      ? json(202, { ok: true })
      : Response.redirect(new URL('/thank-you', request.url).toString(), 303);
  }

  // Per-IP rate limit. Without it a public form is a spam relay that sends on
  // our verified domain — the reputation being spent would be ours.
  //
  // This sits BEFORE validation on purpose, so a flood of deliberately malformed
  // payloads is capped too, not just the ones that would send. The limit is set
  // high enough (8/min) that a real person fumbling the form never reaches it.
  //
  // Know what this is and is not. Cloudflare's rate limiting binding is counted
  // PER DATA CENTRE and is documented as "permissive, eventually consistent,
  // and intentionally designed to not be used as an accurate accounting
  // system". A caller spread across colos gets a multiple of this limit. It is
  // a brake on the naive case, not a guarantee. The honeypot above stops more
  // real-world form spam than this does, and the reCAPTCHA check below stops
  // more than either — this stays because it is the only layer that caps cost
  // before any outbound request is made, and it is the one that still applies
  // to a caller holding a valid token.
  //
  // A WAF rate limiting rule at the zone would be strictly better and is now
  // possible (the Worker has a custom domain), but it is configured in the
  // Cloudflare dashboard rather than here.
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (env.CONTACT_RATE_LIMIT) {
    const { success } = await env.CONTACT_RATE_LIMIT.limit({ key: ip || 'unknown' });
    if (!success) {
      return json(429, {
        ok: false,
        error: 'Too many submissions from this connection. Please try again shortly.',
      });
    }
  }

  const values = clean(body);
  const errors = validate(values);
  if (Object.keys(errors).length) {
    return json(400, { ok: false, error: 'Please check the form.', errors });
  }

  // AFTER validation, so a flood of malformed payloads costs a request to
  // Google for each one — the rate limit above caps that, but not spending it
  // at all is better. A visitor who fails validation is told about the field
  // and submits again; the second submit mints a fresh token, so nothing is
  // lost by having skipped the check on the first.
  const check = await verifyRecaptcha(env, readToken(body), ip);
  if (!check.ok) {
    return json(403, {
      ok: false,
      // Deliberately not "you look like a bot". The people who read this are
      // the false positives — everyone else is a script that does not read.
      error:
        'We could not verify this submission. Please try again, or call (416) 244-6497 and we will take the details over the phone.',
      // For the deploy proof and the logs. It tells an operator whether the
      // secret is wrong, the token never arrived, or the score was simply low.
      reason: check.reason,
    });
  }

  if (!env.RESEND_API_KEY) {
    // Almost always means the key was added as a build variable, not a secret.
    console.error('contact: RESEND_API_KEY missing at runtime');
    return json(500, { ok: false, error: 'The form is not configured. Please call us.' });
  }

  const meta = { city: request.cf?.city, country: request.cf?.country };

  let sent;
  try {
    sent = await sendEmail(env, notificationEmail(env, values, meta));
  } catch (err) {
    console.error('contact: notification failed —', err.message);
    return json(502, {
      ok: false,
      error: 'We could not send your request. Please call (416) 244-6497.',
    });
  }

  // Best effort, and after the notification has already succeeded: a bounced
  // confirmation must never cost the client a real lead.
  if (env.CONTACT_CONFIRM === 'true') {
    ctx.waitUntil(
      sendEmail(env, confirmationEmail(env, values)).catch((err) =>
        console.error('contact: confirmation failed —', err.message),
      ),
    );
  }

  return wantsJson
    ? json(202, { ok: true, id: sent.id })
    : Response.redirect(new URL('/thank-you', request.url).toString(), 303);
}
