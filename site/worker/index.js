/**
 * Staging worker for lp.rexdalemobilewash.ca.
 *
 * The site is static, so this is mostly a wrapper around the static-asset
 * binding that adds a noindex header. That header is unconditional and
 * deliberate: this worker is the STAGING deployment and must never be indexed
 * alongside the real site. If this config is ever reused for production, remove
 * the header first.
 *
 * The one dynamic route is POST /api/contact — the estimate form. It lives here
 * rather than in src/pages because the Astro build is `output: 'static'`: a
 * route under src/pages would be prerendered to a file and would accept
 * nothing. `run_worker_first` in wrangler.jsonc is what guarantees this fetch
 * handler sees the request at all.
 */
import { handleContact } from './contact.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/contact' || pathname === '/api/contact/') {
      const res = await handleContact(request, env, ctx);
      // Response.redirect returns an immutable response, so copy before editing.
      const out = new Response(res.body, res);
      out.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return out;
    }

    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  },
};
