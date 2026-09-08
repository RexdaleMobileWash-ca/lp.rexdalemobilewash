/**
 * POST /api/quote — the two quote forms on /pressure-washing/ (the hero panel
 * and the closing CTA band).
 *
 * WHY THIS ROUTE EXISTS AT ALL. Until now those two forms posted straight from
 * the browser to https://api.web3forms.com/submit with an access key pasted
 * into the page. Nothing about that could be protected server-side: there was
 * no server of ours in the path. Turnstile verification, a dwell check, an MX
 * lookup and a per-IP limit all have to happen somewhere we control, so the
 * forms now post here and this Worker sends through Resend, exactly as
 * /api/contact does.
 *
 * That also retires a dead endpoint: the access key in the page was the empty
 * string, so both forms refused every submission in the browser and no quote
 * request from that page has ever reached anyone.
 *
 * Addressing (From on the shared sending domain, Reply-To on the client's) is
 * unchanged and lives in mail.js. The bot-protection layers live in guard.js.
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

const FORM_ID = 'quote';

const LIMITS = {
  name: 120,
  company: 160,
  email: 200,
  phone: 60,
  property_type: 80,
  message: 4000,
};

// The select on the page. Anything else is a hand-built payload, not a browser.
const PROPERTY_TYPES = new Set([
  'Industrial / Manufacturing Facility',
  'Warehouse / Distribution Centre',
  'Food & Beverage Processing',
  'Commercial or Office Building',
  'Condo / Apartment Building',
  'Other',
]);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

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
      .replace(/[\u0000-\u001F\u007F]/g, field === 'message' ? '\n' : ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, max);
  }
  // Which of the two forms on the page it was. Cosmetic — it names the form in
  // the notification — so an unexpected value is flattened rather than refused.
  out.placement = body.placement === 'final' ? 'final' : 'hero';
  return out;
}

async function validate(v) {
  const errors = {};

  if (!v.name) errors.name = 'Please enter your name.';
  else if (v.name.length < 2) errors.name = 'Please enter your full name.';
  else if (isPlaceholder(v.name)) errors.name = 'Please enter your real name.';

  if (!v.company) errors.company = 'Please enter your company.';
  else if (v.company.length < 2) errors.company = 'Please enter your full company name.';
  else if (isPlaceholder(v.company)) errors.company = 'Please enter your real company name.';

  if (!v.email) errors.email = 'Please enter your email address.';
  else if (!EMAIL_RE.test(v.email)) errors.email = 'That email address looks wrong.';

  if (!v.phone) errors.phone = 'Please enter a phone number.';
  else if (digitsOf(v.phone).length < 7)
    errors.phone = 'That phone number is too short — please include the area code.';

  if (!v.property_type) errors.property_type = 'Please choose a property type.';
  else if (!PROPERTY_TYPES.has(v.property_type))
    errors.property_type = 'Please choose a property type from the list.';

  if (v.message && isPlaceholder(v.message))
    errors.message = 'Please tell us a little about the job, or leave it blank.';

  if (!Object.keys(errors).length) {
    const domain = v.email.split('@').pop();
    const mx = await domainAcceptsMail(domain);
    if (!mx.ok) return { errors: { email: EMAIL_MX_ERROR }, reason: mx.reason };
  }

  return { errors };
}

function notificationEmail(env, v, origin, formLabel) {
  const row = (label, value) =>
    value
      ? `<tr>
           <td style="padding:6px 14px 6px 0;color:#5b6b7a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;vertical-align:top;white-space:nowrap">${esc(label)}</td>
           <td style="padding:6px 0;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">${value}</td>
         </tr>`
      : '';

  const html = `<div style="background:#f4f7f9;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #d4e4ed">
    <div style="background:#0A4C8A;padding:16px 22px">
      <p style="margin:0;color:#fff;font:600 16px/1.3 -apple-system,Segoe UI,Roboto,sans-serif">
        New quote request — pressure washing
      </p>
      <p style="margin:2px 0 0;color:#d4e4ed;font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif">
        ${esc(env.SITE_NAME || 'Rexdale Mobile Wash')}
      </p>
    </div>
    <div style="padding:20px 22px">
      <table style="border-collapse:collapse;width:100%">
        ${row('Name', esc(v.name))}
        ${row('Company', esc(v.company))}
        ${row('Email', `<a href="mailto:${esc(v.email)}" style="color:#0A4C8A">${esc(v.email)}</a>`)}
        ${row('Phone', `<a href="tel:${esc(v.phone.replace(/[^0-9+]/g, ''))}" style="color:#0A4C8A">${esc(v.phone)}</a>`)}
        ${row('Property', esc(v.property_type))}
      </table>
      ${
        v.message
          ? `<p style="margin:18px 0 6px;color:#5b6b7a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">What needs cleaning</p>
             <div style="white-space:pre-wrap;color:#111;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f9;border-radius:4px;padding:12px 14px">${esc(v.message)}</div>`
          : ''
      }
      <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e6edf2;color:#8a97a3;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
        Reply to this message and it goes to ${esc(env.CONTACT_REPLY_TO)}. To answer the
        enquirer directly, use ${esc(v.email)}.
      </p>
      ${originHtml(formLabel, origin)}
    </div>
  </div>
</div>`;

  const text = [
    `New quote request — pressure washing — ${env.SITE_NAME || 'Rexdale Mobile Wash'}`,
    '',
    `Name:     ${v.name}`,
    `Company:  ${v.company}`,
    `Email:    ${v.email}`,
    `Phone:    ${v.phone}`,
    `Property: ${v.property_type}`,
    '',
    v.message ? `What needs cleaning:\n${v.message}` : null,
    originText(formLabel, origin),
  ]
    .filter((line) => line !== null)
    .join('\n');

  return {
    from: env.CONTACT_FROM,
    to: [env.CONTACT_TO],
    ...(env.CONTACT_CC ? { cc: [env.CONTACT_CC] } : {}),
    reply_to: [env.CONTACT_REPLY_TO],
    subject: `New quote request — ${v.name} (${v.company})`,
    html,
    text,
  };
}

export async function handleQuote(request, env, ctx) {
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'Use POST.' });
  }

  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json(403, { ok: false, error: 'Cross-origin submissions are not accepted.' });
  }

  const body = await readBody(request);
  if (!body) {
    return json(415, { ok: false, error: 'Send JSON or a urlencoded form body.' });
  }

  const from = originOf(request, body);

  // --- Layer 2a: honeypot. A success, as far as the sender can tell. -------
  if (honeypotTripped(body)) {
    logRejection(FORM_ID, 'honeypot', from);
    return json(202, { ok: true });
  }

  // --- Layer 2b: dwell time -----------------------------------------------
  const dwell = checkDwell(body);
  if (!dwell.ok) {
    logRejection(FORM_ID, dwell.reason, from, dwell.detail);
    return json(400, { ok: false, error: DWELL_ERROR });
  }

  // --- Burst brake --------------------------------------------------------
  const burst = await checkBurstLimit(env, from);
  if (!burst.ok) {
    logRejection(FORM_ID, burst.reason, from);
    return json(429, { ok: false, error: BURST_LIMIT_ERROR });
  }

  // --- Layer 4: hourly per-IP limit ---------------------------------------
  const rate = await checkRateLimit(env, FORM_ID, from);
  if (!rate.ok) {
    logRejection(FORM_ID, rate.reason, from, `${rate.count} in the last hour`);
    return json(429, { ok: false, error: RATE_LIMIT_ERROR });
  }

  // --- Layer 1: Turnstile -------------------------------------------------
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
    console.error('quote: RESEND_API_KEY missing at runtime');
    return json(500, { ok: false, error: 'The form is not configured. Please call us.' });
  }

  const formLabel =
    values.placement === 'final'
      ? 'Quote form (pressure washing — closing CTA)'
      : 'Quote form (pressure washing — hero)';

  let sent;
  try {
    sent = await sendEmail(
      env,
      notificationEmail(env, values, from, formLabel),
      await idempotencyKey(FORM_ID, 'notify', from, `${values.email}|${values.message}`),
    );
  } catch (err) {
    console.error('quote: notification failed —', err.message);
    return json(502, {
      ok: false,
      error: 'We could not send your request. Please call 1 (416) 244-6497.',
    });
  }

  await recordSubmission(env, FORM_ID, from, rate.recent);
  logAccepted(FORM_ID, from, sent.id);

  // No confirmation email: the Web3Forms flow this replaces sent none, and
  // adding one is a content decision for the client, not a side effect of
  // moving the endpoint.
  return json(202, { ok: true, id: sent.id });
}
