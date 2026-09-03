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
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Caps are generous for a real enquiry and small enough that a payload can not
// be used to blow out the Resend request.
const LIMITS = { name: 120, email: 200, phone: 60, city: 120, message: 4000 };

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
    `Email: ${v.email}`,
    `Phone: ${v.phone}`,
    v.city ? `City:  ${v.city}` : null,
    '',
    v.message ? `Message:\n${v.message}` : null,
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

  // Honeypot. Real people never see this field, so anything in it is a bot.
  // Answer 202 rather than an error: a bot told it failed simply retries.
  if (String(body.company ?? '').trim()) {
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
  // real-world form spam than this does. The enforcing layer — a WAF rate
  // limiting rule, and Turnstile — needs a Cloudflare ZONE to attach to, so it
  // cannot exist while this is served from workers.dev; add it when the Worker
  // gets a custom domain.
  if (env.CONTACT_RATE_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.CONTACT_RATE_LIMIT.limit({ key: ip });
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
