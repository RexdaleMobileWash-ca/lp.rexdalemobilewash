/**
 * Staging worker for lp.rexdalemobilewash.ca.
 *
 * The site is fully static, so this only wraps the static-asset binding to add
 * a noindex header. That header is unconditional and deliberate: this worker is
 * the STAGING deployment and must never be indexed alongside the real site. If
 * this config is ever reused for production, remove the header first.
 */
export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  },
};
