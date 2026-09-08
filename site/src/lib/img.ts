/**
 * AD-9 — the one place an image host is named.
 *
 * Every image this site serves lives in the Backblaze B2 bucket
 * `lp-rexdalemobilewash-img` and is requested through Cloudflare at
 * `img-lp.rexdalemobilewash.ca`. Never build an image URL by hand and never
 * reference `*.backblazeb2.com` in page code — that path skips Cloudflare and
 * bills the client for every download.
 *
 * Keys in the bucket keep the paths the files had on the old WordPress host
 * (`wp-content/uploads/2025/03/...`), so a rewrite is host-only and the two
 * sides stay reconcilable file for file.
 *
 * Why the hostname is `img-lp` and not `img.lp.rexdalemobilewash.ca`:
 * `img.rexdalemobilewash.ca` is already taken by the main site's bucket, and
 * Cloudflare's Universal SSL certificate on a Free plan covers
 * `*.rexdalemobilewash.ca` but not a second label below it — `img.lp.…` would
 * serve a certificate error until the zone buys Advanced Certificate Manager.
 *
 * PUBLIC_IMG_BASE overrides the default. It must be a *build* variable, not a
 * Worker secret: every page is prerendered, so a runtime secret is not read
 * during the build and the URLs come out `undefined/...`.
 */
const DEFAULT_BASE = 'https://img-lp.rexdalemobilewash.ca';

export const IMG_BASE = (import.meta.env.PUBLIC_IMG_BASE || DEFAULT_BASE).replace(/\/+$/, '');

/** img('wp-content/uploads/2025/03/Rexdale-Mobile-Wash-Logo.webp') */
export const img = (path: string): string => `${IMG_BASE}/${path.replace(/^\/+/, '')}`;

/** Everything that came off the old WordPress install shares this prefix. */
export const UPLOADS = 'wp-content/uploads/2025/03';

/** upload('Rexdale-Mobile-Wash-Logo.webp') */
export const upload = (file: string): string => img(`${UPLOADS}/${file}`);
