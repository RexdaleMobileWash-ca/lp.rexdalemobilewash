/**
 * POST /api/contact — the estimate form endpoint (components/EstimateForm.astro,
 * rendered twice on the home page: the hero panel and the closing CTA).
 *
 * Runs on the Worker at request time. It is deliberately NOT an Astro page:
 * the site builds with output 'static', so anything under src/pages is
 * prerendered to a file and would accept nothing. Putting the route here also
 * keeps the noindex wrapper in worker/index.js intact, which the
 * @astrojs/cloudflare adapter would have replaced.
 *
 * Addressing and the Resend call live in mail.js; the bot-protection layers
 * live in guard.js. Read guard.js before changing the order of anything below:
 * the sequence is chosen so that a bot spends its budget on the cheap checks
 * and never reaches an outbound call, and so that nothing sends before all four
 * layers have passed.
 *
 * The API key is env.RESEND_API_KEY and the Turnstile secret is
 * env.TURNSTILE_SECRET_KEY. Both are Worker SECRETS. A key added under Build
 * settings instead is present while the build runs and absent when this code
 * executes: the build passes and the form 500s in production. Set them with
 * `wrangler secret put`, never in wrangler.jsonc vars.
 */

import {
  BURST_LIMIT_ERROR,
  DWELL_ERROR,
  EMAIL_MX_ERROR,
  EMAIL_RE,
  RATE_LIMIT_ERROR,
  checkBurstLimit,
  checkDwell,
  checkRateLimit,
  digitsOf,
  domainAcceptsMail,
  honeypotTripped,
  isPlaceholder,
  logAccepted,
  logRejection,
  originOf,
  recordSubmission,
  verifyTurnstile,
} from './guard.js';
import { esc, idempotencyKey, originHtml, originText, sendEmail } from './mail.js';

const FORM_ID = 'estimate';

// Caps are generous for a real enquiry and small enough that a payload can not
// be used to blow out the Resend request.
const LIMITS = { name: 120, email: 200, phone: 60, city: 120, message: 4000 };

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

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

/**
 * Layer 3 for this form. Every message here is written to be read by a person
 * who typed something slightly wrong, because most of the people who see one
 * will be exactly that.
 */
async function validate(v) {
  const errors = {};

  if (!v.name) errors.name = 'Please enter your name.';
  else if (v.name.length < 2) errors.name = 'Please enter your full name.';
  else if (isPlaceholder(v.name)) errors.name = 'Please enter your real name.';

  if (!v.email) errors.email = 'Please enter your email address.';
  else if (!EMAIL_RE.test(v.email)) errors.email = 'That email address looks wrong.';

  if (!v.phone) errors.phone = 'Please enter a phone number.';
  else if (digitsOf(v.phone).length < 7)
    errors.phone = 'That phone number is too short — please include the area code.';

  if (v.city && (v.city.length < 2 || isPlaceholder(v.city)))
    errors.city = 'Please enter a real city, or leave it blank.';

  if (v.message && isPlaceholder(v.message))
    errors.message = 'Please tell us a little about the job, or leave it blank.';

  // The MX lookup is a network call, so it runs only once the address is at
  // least shaped like one and nothing else has already failed.
  if (!Object.keys(errors).length) {
    const domain = v.email.split('@').pop();
    const mx = await domainAcceptsMail(domain);
    if (!mx.ok) return { errors: { email: EMAIL_MX_ERROR }, reason: mx.reason };
  }

  return { errors };
}

function notificationEmail(env, v, origin) {
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
        ${row('Email', `<a href="mailto:${esc(v.email)}" style="color:#164E83">${esc(v.email)}</a>`)}
        ${row('Phone', `<a href="tel:${esc(v.phone.replace(/[^0-9+]/g, ''))}" style="color:#164E83">${esc(v.phone)}</a>`)}
        ${row('City', esc(v.city))}
      </table>
      ${
        v.message
          ? `<p style="margin:18px 0 6px;color:#5b6b7a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">Message</p>
             <div style="white-space:pre-wrap;color:#111;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f9;border-radius:4px;padding:12px 14px">${esc(v.message)}</div>`
          : ''
      }
      <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e6edf2;color:#8a97a3;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
        Sent from the ${esc(env.SITE_NAME || 'Rexdale Mobile Wash')} website form.<br>
        Reply to this message and it goes to ${esc(env.CONTACT_REPLY_TO)}. To answer the
        enquirer directly, use ${esc(v.email)}.
      </p>
      ${originHtml('Estimate form (home page)', origin)}
    </div>
  </div>
</div>`;

  const text = [
    `New estimate request — ${env.SITE_NAME || 'Rexdale Mobile Wash'}`,
    '',
    `Name:  ${v.name}`,
    `Email: ${v.email}`,
    `Phone: ${v.phone}`,
    v.city ? `City:  ${v.city}` : null,
    '',
    v.message ? `Message:\n${v.message}` : null,
    originText('Estimate form (home page)', origin),
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    from: env.CONTACT_FROM,
    to: [env.CONTACT_TO],
    ...(env.CONTACT_CC ? { cc: [env.CONTACT_CC] } : {}),
    reply_to: [env.CONTACT_REPLY_TO],
    subject: `New estimate request — ${v.name}${v.city ? ` (${v.city})` : ''}`,
    html,
    text,
  };
}

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
      v.message || `${v.phone}${v.city ? ` · ${v.city}` : ''}`,
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
${v.message || `${v.phone}${v.city ? ` · ${v.city}` : ''}`}

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
  const ok = () =>
    wantsJson
      ? json(202, { ok: true })
      : Response.redirect(new URL('/thank-you', request.url).toString(), 303);

  const body = await readBody(request);
  if (!body) {
    return json(415, { ok: false, error: 'Send JSON or a urlencoded form body.' });
  }

  const from = originOf(request, body);

  // --- Layer 2a: honeypot. Answered as a success on purpose. ---------------
  if (honeypotTripped(body)) {
    logRejection(FORM_ID, 'honeypot', from);
    return ok();
  }

  // --- Layer 2b: dwell time -----------------------------------------------
  const dwell = checkDwell(body);
  if (!dwell.ok) {
    logRejection(FORM_ID, dwell.reason, from, dwell.detail);
    return json(400, { ok: false, error: DWELL_ERROR });
  }

  // --- Burst brake: caps garbage that will never send, before any outbound
  //     call is made on its behalf. ----------------------------------------
  const burst = await checkBurstLimit(env, from);
  if (!burst.ok) {
    logRejection(FORM_ID, burst.reason, from);
    return json(429, { ok: false, error: BURST_LIMIT_ERROR });
  }

  // --- Layer 4: hourly per-IP limit, read before anything is sent ----------
  const rate = await checkRateLimit(env, FORM_ID, from);
  if (!rate.ok) {
    logRejection(FORM_ID, rate.reason, from, `${rate.count} in the last hour`);
    return json(429, { ok: false, error: RATE_LIMIT_ERROR });
  }

  // --- Layer 1: Turnstile. Fails closed, including on a missing secret. ----
  const turnstile = await verifyTurnstile(request, body, env, from, FORM_ID);
  if (!turnstile.ok) {
    return json(turnstile.status, { ok: false, error: turnstile.error });
  }

  // --- Layer 3: sanity validation -----------------------------------------
  const values = clean(body);
  const { errors, reason } = await validate(values);
  if (Object.keys(errors).length) {
    logRejection(FORM_ID, reason || 'validation', from, Object.keys(errors).join(','));
    return json(400, { ok: false, error: 'Please check the form.', errors });
  }

  if (!env.RESEND_API_KEY) {
    // Almost always means the key was added as a build variable, not a secret.
    console.error('contact: RESEND_API_KEY missing at runtime');
    return json(500, { ok: false, error: 'The form is not configured. Please call us.' });
  }

  let sent;
  try {
    sent = await sendEmail(
      env,
      notificationEmail(env, values, from),
      await idempotencyKey(FORM_ID, 'notify', from, `${values.email}|${values.message}`),
    );
  } catch (err) {
    console.error('contact: notification failed —', err.message);
    return json(502, {
      ok: false,
      error: 'We could not send your request. Please call (416) 244-6497.',
    });
  }

  // Counted only now: the limit is on submissions that actually send, so a
  // visitor who fumbles validation is not locked out of the form.
  await recordSubmission(env, FORM_ID, from, rate.recent);
  logAccepted(FORM_ID, from, sent.id);

  // Best effort, and after the notification has already succeeded: a bounced
  // confirmation must never cost the client a real lead.
  if (env.CONTACT_CONFIRM === 'true') {
    ctx.waitUntil(
      (async () => {
        try {
          await sendEmail(
            env,
            confirmationEmail(env, values),
            await idempotencyKey(FORM_ID, 'confirm', from, values.email),
          );
        } catch (err) {
          console.error('contact: confirmation failed —', err.message);
        }
      })(),
    );
  }

  return wantsJson ? json(202, { ok: true, id: sent.id }) : ok();
}
