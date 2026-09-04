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
 *   From ....... forms@rexdalemobilewash.ca      the client's own domain
 *   Reply-To ... dispatch@rexdalemobilewash.ca   the client's own address
 *
 * The From domain is verified in Resend through records deliberately kept clear
 * of the client's live Microsoft 365 mail: DKIM on the `resend._domainkey`
 * selector, and SPF plus the return path on the `send.` SUBDOMAIN. Their apex
 * SPF (`v=spf1 include:secureserver.net -all`) and their Outlook MX are neither
 * modified nor consulted — SPF authenticates the envelope sender, which is
 * send.rexdalemobilewash.ca, not the From header a person sees.
 *
 * What that does NOT buy: isolation. Form mail and the client's business mail
 * now share one domain reputation, so anything sent in volume from here is felt
 * by their Microsoft 365 mail. Weigh that before raising send rates, and see
 * CONTACT_CONFIRM below, which is the one path that emails a stranger.
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
 * Four forms post here: the two Elementor estimate forms on / (hero, cta) and
 * the two quote forms on /pressure-washing/ (hero, final). They do not carry
 * the same fields — the commercial page asks for company and property type and
 * never asks for a city — so every field is optional at this layer except the
 * three in validate(). A lead that arrives partly filled is still a lead.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/*
 * The honeypot is 'fax', NOT 'company'.
 *
 * It used to be 'company', which was safe only while the sole forms were the
 * two estimate forms. The /pressure-washing/ quote forms ask for the
 * enquirer's company as a REQUIRED field, so under the old name every
 * commercial lead would have been read as a bot and dropped on the floor with
 * a cheerful 202. Renaming it is what makes those forms safe to connect.
 *
 * 'fax' is the right replacement for two reasons: blind form-filling bots fill
 * every text input regardless of name, and no browser or password manager
 * recognises it as an autofill token — so it cannot be populated on a real
 * visitor's behalf. Before changing it again, check the new name against every
 * field name in EstimateForm.astro and pressure-washing.astro.
 */
const HONEYPOT_FIELD = 'fax';

// Caps are generous for a real enquiry and small enough that a payload can not
// be used to blow out the Resend request.
const LIMITS = {
  name: 120,
  email: 200,
  phone: 60,
  city: 120,
  company: 160,
  property_type: 80,
  message: 4000,
};

/*
 * Fail SAFE, not closed. If the honeypot is ever renamed onto a real field
 * again, ignore the honeypot rather than discarding the submission — and say so
 * in the logs. A form that lets spam through is recoverable by reading the
 * mail; a form that silently eats every enquiry is not, and nothing on either
 * end of it looks broken.
 */
const HONEYPOT_USABLE = !Object.hasOwn(LIMITS, HONEYPOT_FIELD);

/*
 * Which form produced the lead. Whoever answers dispatch@ needs to know whether
 * an enquiry came from the home page or from the paid commercial landing page,
 * because the two are answered differently.
 *
 * Mapped through an allowlist rather than printed as sent: the value arrives
 * from the browser, and this one is the only submitted field that ends up
 * describing the message rather than quoting it. An unknown value degrades to
 * the generic label instead of putting attacker-chosen text in that position.
 */
const SOURCES = {
  hero: 'Home page — hero form',
  cta: 'Home page — closing section',
  'pressure-washing-hero': 'Pressure washing LP — quote form',
  'pressure-washing-final': 'Pressure washing LP — closing form',
};
// Object.hasOwn, not a bare lookup: `SOURCES['toString']` inherits a truthy
// function off the prototype, and a submitted source of "toString" would put
// its source text in the email where the form's name belongs.
const sourceLabel = (value) =>
  (Object.hasOwn(SOURCES, value) && SOURCES[value]) || 'Website form';

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

/*
 * Escape, then turn newlines into real break tags.
 *
 * The message blocks below also carry `white-space:pre-wrap`, but that is belt
 * and braces only: CONTACT_TO is a Microsoft 365 mailbox, Outlook for Windows
 * renders HTML with the Word engine, and Word does not implement the CSS
 * `white-space` property at all. Without explicit <br> the line breaks in an
 * enquiry collapse into one run-on paragraph for the one reader who matters.
 */
const breaks = (s) => esc(s).replace(/\n/g, '<br>');

/*
 * A failure a PERSON has to read.
 *
 * The fetch path asks for JSON and renders the message beside the button, so
 * every error used to answer JSON unconditionally. But both pages also post
 * the plain form when scripting is off — and the /pressure-washing/ forms
 * carry `novalidate`, so a browser there will happily submit an empty form and
 * land on the response. Answering that visitor `{"ok":false,…}` as a bare page
 * is not an error message, it is a dead end.
 *
 * Deliberately a hand-written page and not a redirect: there is no error route
 * in a static build to redirect to, and a redirect would lose the reason.
 */
const errorPage = (status, message, errors, backHref) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>We could not send your request</title>
<style>
  body{margin:0;background:#164E83;color:#fff;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
       display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .b{max-width:34rem;text-align:center}
  h1{font-size:1.6rem;margin:0 0 .6em;color:#D4E4ED}
  ul{text-align:left;display:inline-block;margin:0 0 1.2em;padding-left:1.2em}
  a{color:#fff}
  .go{display:inline-block;margin-top:.6em;background:#D4E4ED;color:#164E83;text-decoration:none;
      font-weight:600;padding:12px 22px;border-radius:3px}
</style>
</head>
<body><div class="b">
<h1>We could not send your request</h1>
<p>${esc(message)}</p>
${
  errors && Object.keys(errors).length
    ? `<ul>${Object.values(errors)
        .map((e) => `<li>${esc(e)}</li>`)
        .join('')}</ul>`
    : ''
}
<p>You can also call us on <a href="tel:4162446497">(416)&nbsp;244-6497</a>.</p>
<a class="go" href="${esc(backHref)}">Back to the form</a>
</div></body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
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
    // Guarded exactly like the JSON branch above. A multipart header with no
    // boundary, or a body that does not match the one it declares, makes
    // formData() reject — and an unguarded reject here escapes the Worker and
    // replaces the 415 below with a Cloudflare error page.
    try {
      const form = await request.formData();
      return Object.fromEntries(form.entries());
    } catch {
      return null;
    }
  }
  return null;
}

function clean(body) {
  const out = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    out[field] = String(body[field] ?? '')
      // Normalise line endings FIRST. A urlencoded form post puts CRLF on the
      // wire, and the per-character strip below would turn that pair into two
      // newlines — so every single line break became a blank line, and a real
      // paragraph break collapsed to the same thing. Single and double breaks
      // were indistinguishable in the email.
      .replace(/\r\n?/g, '\n')
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
        ${row('Company', esc(v.company))}
        ${row('Email', `<a href="mailto:${esc(v.email)}" style="color:#164E83">${esc(v.email)}</a>`)}
        ${row('Phone', `<a href="tel:${esc(v.phone.replace(/[^0-9+]/g, ''))}" style="color:#164E83">${esc(v.phone)}</a>`)}
        ${row('City', esc(v.city))}
        ${row('Property type', esc(v.property_type))}
      </table>
      ${
        v.message
          ? `<p style="margin:18px 0 6px;color:#5b6b7a;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">Message</p>
             <div style="white-space:pre-wrap;color:#111;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f9;border-radius:4px;padding:12px 14px">${breaks(v.message)}</div>`
          : ''
      }
      <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid #e6edf2;color:#8a97a3;font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
        ${esc(sourceLabel(meta.source))}${meta.city ? ` · ${esc(meta.city)}` : ''}${meta.country ? `, ${esc(meta.country)}` : ''}<br>
        Reply to this message and it goes to ${esc(env.CONTACT_REPLY_TO)}. To answer the
        enquirer directly, use ${esc(v.email)}.
      </p>
    </div>
  </div>
</div>`;

  const text = [
    `New estimate request — ${env.SITE_NAME || 'Rexdale Mobile Wash'}`,
    sourceLabel(meta.source),
    '',
    `Name:     ${v.name}`,
    v.company ? `Company:  ${v.company}` : null,
    `Email:    ${v.email}`,
    `Phone:    ${v.phone}`,
    v.city ? `City:     ${v.city}` : null,
    v.property_type ? `Property: ${v.property_type}` : null,
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
    // The commercial forms collect a company and no city, the estimate forms
    // the reverse — so the parenthetical takes whichever one arrived.
    subject: `New estimate request — ${v.name}${
      v.company || v.city ? ` (${v.company || v.city})` : ''
    }`,
    html,
    text,
  };
}

/*
 * The visitor's own acknowledgement, sent when CONTACT_CONFIRM is 'true'.
 *
 * KNOWN RISK, left in deliberately: this is the only mail here addressed to
 * someone we have not vetted, at an address they chose, quoting text they
 * wrote. That shape is a relay — someone can use the form to send their own
 * words to a third party over our verified domain — and since From moved to
 * rexdalemobilewash.ca, the reputation it would spend is the client's business
 * domain, not a shared one. The honeypot and the per-IP rate limit blunt it;
 * neither closes it.
 *
 * The fix, if it is ever wanted, is one line: drop `v.message` from `summary`
 * so the acknowledgement only ever repeats fields the client already holds.
 * That loses the "what you sent us" quote-back, which is why it is a decision
 * and not a silent change.
 */
function confirmationEmail(env, v) {
  const site = env.SITE_NAME || 'Rexdale Mobile Wash';
  // With no message, echo back the details they did give rather than an empty
  // box — the commercial forms can be submitted with the textarea untouched.
  const summary =
    v.message ||
    [v.company, v.property_type, v.phone, v.city].filter(Boolean).join(' · ');
  const html = `<div style="background:#f4f7f9;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:6px;border:1px solid #d4e4ed;padding:24px">
    <p style="margin:0 0 14px;color:#164E83;font:600 18px/1.3 -apple-system,Segoe UI,Roboto,sans-serif">Thanks for getting in touch</p>
    <p style="margin:0 0 14px;color:#111;font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif">
      Hi ${esc(v.name)}, we have your request and one of our team will get back to
      you shortly. If it is urgent, call us on
      <a href="tel:4162446497" style="color:#164E83">(416) 244-6497</a>.
    </p>
    <p style="margin:0 0 6px;color:#5b6b7a;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">What you sent us</p>
    <div style="white-space:pre-wrap;color:#111;font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f9;border-radius:4px;padding:12px 14px">${breaks(
      summary,
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
${summary}

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
    err.code = body?.name;
    throw err;
  }
  return body;
}

export async function handleContact(request, env, ctx) {
  const wantsJson = (request.headers.get('Accept') || '').includes('application/json');

  /*
   * Where "Back to the form" points on the HTML error page. Taken from the
   * Referer so the visitor returns to the page they were actually on — the
   * home page and the pressure-washing LP both post here — but ONLY when it is
   * same-host. A Referer is attacker-supplied; echoing it into an href
   * unchecked is an open redirect on our own domain.
   */
  let backHref = '/';
  try {
    const referer = new URL(request.headers.get('Referer') || '');
    if (referer.host === new URL(request.url).host) backHref = referer.pathname;
  } catch {
    // No Referer, or an unparseable one. '/' is the right answer either way.
  }

  /** Answer the fetch with JSON, and a plain browser form post with a page. */
  const fail = (status, message, errors) =>
    wantsJson
      ? json(status, { ok: false, error: message, ...(errors ? { errors } : {}) })
      : errorPage(status, message, errors, backHref);

  if (request.method !== 'POST') {
    return fail(405, 'Use POST.');
  }

  /*
   * A browser form post always carries Origin. A missing Origin is a
   * non-browser client (the deploy proof uses curl) and is allowed; a foreign
   * one is not.
   *
   * Parsed defensively. `Origin: null` is a legal header a browser sends
   * whenever the submitting document has an opaque origin — a sandboxed iframe,
   * a CSP sandbox directive, some privacy extensions — and `new URL('null')`
   * THROWS. Unguarded, that exception escapes the fetch handler and Cloudflare
   * serves its own 1101 error page: no lead, and nothing that looks like this
   * endpoint's contract. An unparseable Origin takes a decided branch instead.
   */
  const origin = request.headers.get('Origin');
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== new URL(request.url).host) {
      return fail(403, 'Cross-origin submissions are not accepted.');
    }
  }

  const body = await readBody(request);
  if (!body) {
    return fail(415, 'Send JSON or a urlencoded form body.');
  }

  // Honeypot. Real people never see this field, so anything in it is a bot.
  // Answer 202 rather than an error: a bot told it failed simply retries.
  // See HONEYPOT_FIELD above for why this is not 'company'.
  if (!HONEYPOT_USABLE) {
    console.error(
      `contact: honeypot "${HONEYPOT_FIELD}" is also a real field — honeypot disabled`,
    );
  }
  if (HONEYPOT_USABLE && String(body[HONEYPOT_FIELD] ?? '').trim()) {
    // The ONLY branch that answers success without sending mail — both pages
    // show their thank-you state and fire generate_lead on it. Leave a trace,
    // or a form-fill extension writing a real visitor's fax number into the
    // hidden field is indistinguishable from bot noise and silently costs a
    // lead, which is the failure this whole endpoint is written to avoid.
    console.log(
      'contact: honeypot tripped — source=%s name=%s email=%s phone=%s',
      sourceLabel(String(body.source ?? '')),
      body.name ? 'y' : 'n',
      body.email ? 'y' : 'n',
      body.phone ? 'y' : 'n',
    );
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
      return fail(
        429,
        'Too many submissions from this connection. Please try again shortly.',
      );
    }
  }

  const values = clean(body);
  const errors = validate(values);
  if (Object.keys(errors).length) {
    return fail(400, 'Please check the form.', errors);
  }

  if (!env.RESEND_API_KEY) {
    // Almost always means the key was added as a build variable, not a secret.
    console.error('contact: RESEND_API_KEY missing at runtime');
    return fail(500, 'The form is not configured. Please call us.');
  }

  const meta = {
    city: request.cf?.city,
    country: request.cf?.country,
    source: String(body.source ?? ''),
  };

  let sent;
  try {
    sent = await sendEmail(env, notificationEmail(env, values, meta));
  } catch (err) {
    // Log the class as well as the text: a 403 from Resend means the key or
    // the sending domain is wrong (a config break someone must fix), while a
    // 429 or a 5xx is transient. Collapsed into one line they are
    // indistinguishable in the tail, and the visitor-facing message is the
    // same either way.
    console.error(
      'contact: notification failed —',
      err.status ?? '-',
      err.code ?? '-',
      err.message,
    );
    return fail(502, 'We could not send your request. Please call (416) 244-6497.');
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
