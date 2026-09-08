/**
 * Worker for lp.rexdalemobilewash.ca.
 *
 * The site is static, so this is mostly a wrapper around the static-asset
 * binding. The one dynamic route is POST /api/contact — the estimate form. It
 * lives here rather than in src/pages because the Astro build is
 * `output: 'static'`: a route under src/pages would be prerendered to a file
 * and would accept nothing. `run_worker_first` in wrangler.jsonc is what
 * guarantees this fetch handler sees the request at all.
 *
 * ---------------------------------------------------------------------------
 * THE NOINDEX HEADER
 *
 * One script serves both environments (see wrangler.jsonc): production
 * `lp-rexdalemobilewash` and `staging-lp-rexdalemobilewash`. Staging must never
 * be indexed alongside the real site; production must never carry the header at
 * all, or Google drops the page that the client's Ads spend points at.
 *
 * That decision used to be a hardcoded `res.headers.set(...)` with a comment
 * saying to remove it before production. A comment is not a safeguard: the
 * header would have shipped with the first cutover deploy. So it is config now,
 * plus a hostname guard that cannot be got wrong in the unsafe direction:
 *
 *   - NOINDEX=true                -> noindex   (staging sets this)
 *   - *.workers.dev, staging.*    -> noindex   ALWAYS, whatever the var says
 *   - anything else               -> indexable
 *
 * A production config deployed to a staging hostname by mistake is still
 * noindexed. A staging config deployed to the live domain is the only way to
 * get it wrong, and that is a deploy nobody performs by accident — `--env
 * staging` names the environment explicitly.
 * ---------------------------------------------------------------------------
 */
import { handleContact } from './contact.js';

/**
 * Hostnames that are noindex no matter what the environment says. Both are
 * preview surfaces by construction: workers.dev is Cloudflare's own, and the
 * `staging.` label is this stack's convention (staging.lp.rexdalemobilewash.ca
 * is attached to the staging Worker as a Custom Domain).
 */
function isPreviewHostname(hostname) {
  return hostname.endsWith('.workers.dev') || hostname.startsWith('staging.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const noindex = env.NOINDEX === 'true' || isPreviewHostname(url.hostname);

    if (url.pathname === '/api/contact' || url.pathname === '/api/contact/') {
      const res = await handleContact(request, env, ctx);
      // Response.redirect returns an immutable response, so copy before editing.
      const out = new Response(res.body, res);
      // The form endpoint is noindex on every environment: it answers POSTs and
      // has nothing a crawler should hold on to.
      out.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return out;
    }

    const asset = await env.ASSETS.fetch(request);
    if (!noindex) return asset;

    const res = new Response(asset.body, asset);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  },
};
