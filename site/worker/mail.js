/**
 * mail.js — the Resend call, and the origin block that now goes on the bottom
 * of every notification.
 *
 * ADDRESSING — the part worth not "improving" casually:
 *
 *   From ....... forms@brandingcentres.com   the SHARED sending domain
 *   Reply-To ... dispatch@rexdalemobilewash.ca   the client's own address
 *
 * rexdalemobilewash.ca is NEVER used as a sending domain. That is what makes it
 * impossible for these endpoints to touch the client's existing Microsoft 365
 * mail reputation — no SPF, DKIM or DMARC record of theirs is involved.
 *
 * The visitor's address never goes in From. To a receiving mail server that is
 * forgery, and it is the fastest way to land every notification in spam. The
 * visitor's address goes in the body, as a mailto: link.
 */

const RESEND_DEFAULT = 'https://api.resend.com/emails';

export const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * Where a submission came from, rendered for the notification email.
 *
 * This exists because the old notification said "Sent from the website form"
 * and nothing else: a suspicious enquiry could not be traced without going into
 * Workers logs, which in practice meant it was never traced. Page, IP and
 * Cloudflare's location for that IP are now in the mail itself.
 *
 * It is diagnostic, not evidence. CF-Connecting-IP is set by the edge and a
 * caller cannot forge it, but geolocation of an IP is approximate and a VPN
 * moves it entirely.
 */
export function originHtml(form, origin) {
  const place = [origin.city, origin.region, origin.country]
    .filter(Boolean)
    .join(', ');
  const line = (label, value) =>
    value
      ? `<div><span style="color:#8a97a3">${esc(label)}</span> <span style="color:#5b6b7a">${value}</span></div>`
      : '';

  return `<div style="margin:18px 0 0;padding-top:14px;border-top:1px solid #e6edf2;font:12px/1.7 -apple-system,Segoe UI,Roboto,sans-serif">
    <p style="margin:0 0 6px;color:#8a97a3;font-weight:600;letter-spacing:.04em;text-transform:uppercase">Where this came from</p>
    ${line('Form', esc(form))}
    ${line('Page', `<a href="${esc(origin.page)}" style="color:#164E83">${esc(origin.page)}</a>`)}
    ${line('IP', esc(origin.ip))}
    ${line('Location', esc(place || 'unknown'))}
    ${line('Network', esc(origin.asOrganization))}
    ${line('Received', esc(origin.at))}
  </div>`;
}

export function originText(form, origin) {
  const place = [origin.city, origin.region, origin.country]
    .filter(Boolean)
    .join(', ');
  return [
    '',
    '--- Where this came from ---',
    `Form:     ${form}`,
    `Page:     ${origin.page}`,
    `IP:       ${origin.ip}`,
    `Location: ${place || 'unknown'}`,
    ...(origin.asOrganization ? [`Network:  ${origin.asOrganization}`] : []),
    `Received: ${origin.at}`,
  ].join('\n');
}

/**
 * Send one email through Resend.
 *
 * `Idempotency-Key` is the guard against the duplicate-send failure seen on
 * another site in this stack, where one submission fired four identical
 * notifications. The key is derived from the form, the recipient, the subject
 * and the minute — so a handler invoked twice for the same submission produces
 * one email, while a visitor who genuinely submits again five minutes later
 * still gets through.
 *
 * `env.RESEND_ENDPOINT` overrides the API base. It exists so the local proof in
 * bin/prove-bot-protection.mjs can count sends against a mock instead of
 * mailing the client. It is not set in wrangler.jsonc and must never be set in
 * production.
 */
export async function sendEmail(env, payload, idempotencyKey) {
  const res = await fetch(env.RESEND_ENDPOINT || RESEND_DEFAULT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
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

/** Stable per-submission key: same submission in the same minute = one email. */
export async function idempotencyKey(form, kind, origin, seed) {
  const minute = Math.floor(Date.now() / 60000);
  const material = `${form}|${kind}|${origin.ip}|${minute}|${seed}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${form}-${kind}-${hex.slice(0, 32)}`;
}
