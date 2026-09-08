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

/**
 * Alias path -> canonical path. Matched with any trailing slash stripped, so
 * one entry covers both `/pressurewashing` and `/pressurewashing/`.
 *
 * `/pressurewashing/` is the un-hyphenated spelling of the commercial landing
 * page. It is NOT a legacy WordPress address — neither spelling ever existed on
 * the old site — it is an alias for traffic that reaches for the obvious
 * spelling, ad destinations included.
 *
 * A 301 rather than a second copy of the page: two URLs serving identical
 * content split the analytics and make search engines pick a canonical for us.
 *
 * Handled here rather than as an Astro `redirects` entry because the build is
 * `output: 'static'`, where Astro emits a meta-refresh HTML page instead of a
 * real redirect. A paid click deserves a 301, not a page that loads and then
 * bounces the visitor.
 */
const ALIASES = new Map([
  ['/pressurewashing', '/pressure-washing/'],

  /**
   * The old WordPress author archive (gate 14). It was the only indexable page
   * among the plumbing addresses the old install answered on, so it passes its
   * ranking to the homepage rather than dead-ending.
   *
   * Its neighbours — /feed/, /comments/feed/, /wp-json/…, /xmlrpc.php,
   * /wp-admin/admin-ajax.php — are deliberately left to 404. They are
   * endpoints, not pages: nothing indexed them, and answering 200-via-redirect
   * would tell a crawler the homepage *is* the feed.
   */
  ['/author/ashbrandingcentres-com', '/'],
]);

/**
 * Old WordPress image addresses (gate 14, AD-10 — nothing is retired).
 *
 * The WordPress install served its media from
 * `lp.rexdalemobilewash.ca/wp-content/uploads/…`, and those addresses are the
 * ones that leaked outward: Google Images, social unfurl caches, and any site
 * that hotlinked a photo. They are not ours to break, and they 404'd from the
 * moment the domain moved to this Worker.
 *
 * The B2 bucket deliberately kept the WordPress key layout, so this is a host
 * swap with the path left completely alone — NOT the `substring(path, 20)`
 * shape the generic procedure uses, which assumes the bucket strips
 * `/wp-content/uploads/`. Applying that here would 404 every one of them.
 *
 * `/wp-content/plugins/…`, `/wp-content/themes/…` and `/wp-includes/…` are
 * deliberately NOT redirected. They existed only to render the old page — the
 * Elementor and jQuery bundles — and nothing outside the old site ever linked
 * to them. A 404 is the honest answer.
 */
const UPLOADS_PREFIX = '/wp-content/uploads/';
const IMG_ORIGIN = 'https://img-lp.rexdalemobilewash.ca';

/**
 * WordPress generated a resized copy of every upload and put the dimensions in
 * the filename — `Graffiti-Removal-300x220.webp` beside `Graffiti-Removal.webp`.
 * Those derivative addresses are all over Google Images and anything that ever
 * hotlinked a thumbnail.
 *
 * Only the originals were copied to B2 (gate 5), so a straight host swap sends
 * every derivative to a 404 in the bucket — 16 of the 30 old media addresses,
 * which is what the gate 15 sweep caught. Stripping the suffix points them at
 * the full-size file, which is the same picture.
 *
 * Safe here because it was checked rather than assumed: not one of the 29
 * objects in the bucket has a `-WxH` key, so a stripped path can never collide
 * with a distinct real file. Re-check that before reusing this on another site.
 *
 * The visitor gets more bytes than the thumbnail address promised. That is the
 * right trade for an address only crawlers and old hotlinks still request — the
 * live site references originals directly and never takes this path.
 *
 * Two digits minimum per dimension, so `Truck-4x4.webp` keeps its name. That is
 * not hypothetical for a client whose business is washing trucks, and WordPress
 * never registers a single-digit image size — the smallest in the wild is around
 * 32x32. A name ending in a two-digit-or-longer `-NNxNN` would still be stripped;
 * the bucket contains no such key, so nothing there can be broken by it, and the
 * gate 15 sweep re-checks every media address if that ever changes.
 */
const WP_SIZE_SUFFIX = /-\d{2,5}x\d{2,5}(\.[A-Za-z0-9]+)$/;

/**
 * 301, never 302. A 302 says the old address is coming back, so search engines
 * hold the ranking on the dead URL instead of passing it to the live one. It
 * looks identical to a visitor and quietly costs the client their position.
 *
 * The query string is always carried across: an Ads click arrives with gclid,
 * and dropping it breaks conversion attribution.
 */
function permanentRedirect(location, noindex) {
  const headers = { Location: location };
  if (noindex) headers['X-Robots-Tag'] = 'noindex, nofollow';
  return new Response(null, { status: 301, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const noindex = env.NOINDEX === 'true' || isPreviewHostname(url.hostname);

    const canonical = ALIASES.get(url.pathname.replace(/\/+$/, '') || '/');
    if (canonical) {
      return permanentRedirect(new URL(canonical + url.search, url).toString(), noindex);
    }

    if (url.pathname.startsWith(UPLOADS_PREFIX)) {
      const key = url.pathname.replace(WP_SIZE_SUFFIX, '$1');
      return permanentRedirect(IMG_ORIGIN + key + url.search, noindex);
    }

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
