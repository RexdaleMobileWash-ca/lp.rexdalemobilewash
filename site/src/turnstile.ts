/**
 * Cloudflare Turnstile sitekey, shared by all four contact forms.
 *
 * PUBLIC VALUE. A sitekey is meant to be read by anyone viewing source; the
 * half that must stay secret is TURNSTILE_SECRET, which lives as a Worker
 * secret and never appears in the build.
 *
 * While this is empty NO WIDGET RENDERS, and the Worker — which keys its own
 * enforcement on TURNSTILE_SECRET being present — lets submissions through
 * exactly as before. That pairing is deliberate: it is what lets this code ship
 * before the widget exists without a window where the live form is broken.
 *
 * The two switch on TOGETHER. Setting the Worker secret without filling this in
 * blocks every submission, because the page would send no token. Do both:
 *
 *   1. Create a Managed widget in the Cloudflare dashboard (Turnstile is
 *      account-level and does NOT require the site to be on a Cloudflare zone),
 *      with hostnames staging-lp-rexdalemobilewash.ash-47a.workers.dev,
 *      lp.rexdalemobilewash.ca and localhost.
 *   2. Paste the sitekey here.
 *   3. cd site && CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" \
 *        npx wrangler secret put TURNSTILE_SECRET
 *   4. npm run build && npx wrangler deploy   (both halves in one deploy)
 */
export const TURNSTILE_SITEKEY = '';

/** Where the widget script comes from. Only loaded when a sitekey is set. */
export const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js';
