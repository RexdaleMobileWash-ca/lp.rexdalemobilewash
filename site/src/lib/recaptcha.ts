/**
 * reCAPTCHA — the one place the site key and the token field name are written.
 *
 * WHICH reCAPTCHA THIS IS. The key pair the client supplied is **v3**
 * (score-based), not v2. That was established, not assumed: Google's anchor
 * endpoint rejects this key when asked to render a v2 widget
 * (`size=normal` -> "Invalid input") and returns the same configuration flags
 * as Google's own published v3 demo key, where a real v2-invisible key renders
 * the widget happily. It matters because the two are wired completely
 * differently — v2 renders a widget and returns a pass/fail, v3 runs invisibly
 * and returns a 0.0-1.0 score the server has to threshold. Wiring a v3 key as
 * a v2 widget fails at page load with "Invalid site key type".
 *
 * So there is no checkbox and no challenge anywhere on this site. Every
 * submission produces a token; `worker/contact.js` scores it.
 *
 * THE SITE KEY IS PUBLIC. It is in the HTML of every page that carries a form,
 * by design — it identifies the site to Google and is useless without the
 * secret. The SECRET key is a Worker secret (`RECAPTCHA_SECRET`) and is not in
 * this repository. Do not add it here, or to wrangler.jsonc `vars`: a var is
 * readable by anyone who can see the deployed Worker's settings, and a build
 * variable is not present at all when the route executes.
 *
 * PUBLIC_RECAPTCHA_SITE_KEY overrides the default, the same way
 * PUBLIC_IMG_BASE does in img.ts. It must be a *build* variable — every page is
 * prerendered, so a runtime value is not read during the build and the key
 * comes out `undefined`.
 */
const DEFAULT_SITE_KEY = '6LcalvUqAAAAAHu88pu8kNJ844UNgiAOftYRurlF';

export const RECAPTCHA_SITE_KEY =
  import.meta.env.PUBLIC_RECAPTCHA_SITE_KEY || DEFAULT_SITE_KEY;

/**
 * The field the token is posted in. `worker/contact.js` reads this exact name,
 * and also accepts Google's own `g-recaptcha-response` so a hand-built form or
 * a future v2 widget would still verify.
 */
export const RECAPTCHA_FIELD = 'recaptcha_token';

/** v3 loader. The `render=` parameter is what makes it v3 rather than a widget. */
export const RECAPTCHA_SRC = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`;

/**
 * Google's required disclosure links. The floating badge is hidden on this site
 * (it collides with the fixed mobile call/quote bar on /pressure-washing/ and
 * sits over the footer everywhere else), and Google permits hiding it ONLY if
 * the "protected by reCAPTCHA" text appears in the form instead. Every form
 * that renders `<Recaptcha />` therefore carries that line under its submit
 * button — the two are not separable. Do not remove the text without also
 * un-hiding the badge in `components/Recaptcha.astro`.
 */
export const RECAPTCHA_NOTICE_LINKS = {
  privacy: 'https://policies.google.com/privacy',
  terms: 'https://policies.google.com/terms',
};
