/**
 * Staging worker for lp.rexdalemobilewash.ca.
 *
 * The site is static, so this is mostly a wrapper around the static-asset
 * binding that adds a noindex header. That header is unconditional and
 * deliberate: this worker is the STAGING deployment and must never be indexed
 * alongside the real site. If this config is ever reused for production, remove
 * the header first.
 *
 * The dynamic routes are the two form endpoints:
 *
 *   POST /api/contact   the estimate form on the home page (contact.js)
 *   POST /api/quote     the two quote forms on /pressure-washing/ (quote.js)
 *
 * They live here rather than in src/pages because the Astro build is
 * `output: 'static'`: a route under src/pages would be prerendered to a file and
 * would accept nothing. `run_worker_first` in wrangler.jsonc is what guarantees
 * this fetch handler sees the request at all.
 *
 * Both endpoints run the same four bot-protection layers, in worker/guard.js.
 */
import { handleContact } from './contact.js';
import { handleQuote } from './quote.js';

const ROUTES = {
  '/api/contact': handleContact,
  '/api/quote': handleQuote,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    const handler = ROUTES[pathname.replace(/\/$/, '')];
    if (handler) {
      const res = await handler(request, env, ctx);
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
