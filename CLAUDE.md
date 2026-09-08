# Working notes for Claude

## Cloudflare credentials — check before saying you can't

The environment provides **`CF_API_TOKEN`**. Always check for it before
concluding a Cloudflare action is impossible. Check `env` for credentials
generally rather than assuming the conventional variable name is the one
that's set.

Wrangler and most Cloudflare tooling read `CLOUDFLARE_API_TOKEN`, not
`CF_API_TOKEN`, so map it across at call time:

```bash
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler deploy
```

Without the mapping wrangler reports no credentials and the deploy fails,
which looks like a missing token but isn't.

## Deploys are manual — git push does NOT deploy

There is no CI in this repo: no `.github/` directory, zero GitHub Actions
workflows. Cloudflare Workers Builds is not connected to the repository.

Merging to `main` updates the source of truth and changes nothing that is
served. The Worker keeps serving the previously uploaded bundle until
someone runs a deploy:

```bash
cd site
npm run build
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npm run deploy:staging   # staging-lp-rexdalemobilewash
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npm run deploy           # lp-rexdalemobilewash (production)
```

**Use the scripts, not a bare `npx wrangler deploy`.** `wrangler.jsonc` now
defines two environments, and an unqualified deploy warns that no target was
given and then deploys the top level — production — anyway. The scripts name
the environment explicitly.

After deploying, verify against the live URL rather than trusting the
build — fetch the page and grep for what you changed.

## The contact form has a Worker secret — redeploys do not carry it

`POST /api/contact` (see `site/worker/contact.js`) needs `RESEND_API_KEY`, set
as a **Worker secret**, not a build variable or a `var` in `wrangler.jsonc`. A
build variable is present while the build runs and absent when the route
executes — the build passes and the form 500s in production.

The secret lives on the Worker, not in the repo, so a Worker created fresh (new
name, new account) starts without it and the form will 500 until:

```bash
cd site
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler secret put RESEND_API_KEY --env staging
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler secret put RESEND_API_KEY --env ""
```

A secret belongs to **one Worker**, and there are now two. Both have their own
key, scoped to sending access on brandingcentres.com only — separate keys, so
revoking staging's can never stop the live form:

| Environment | Resend key name |
|---|---|
| `--env staging` | `lp.rexdalemobilewash.ca` |
| `--env ""` (production) | `lp.rexdalemobilewash.ca production worker` |

`npx wrangler secret list --env <name>` confirms it by name — Cloudflare never
discloses the value. Ordinary deploys preserve it.

**To test the production form before the domain is attached**, use
`npx wrangler dev --remote --env ""`: it runs the real Worker with the real
secret, exposed on localhost only. A missing secret is otherwise invisible
until a real visitor submits.

## Staging vs live

- Staging: `https://staging-lp-rexdalemobilewash.ash-47a.workers.dev` **and**
  `https://staging.lp.rexdalemobilewash.ca` (Worker
  `staging-lp-rexdalemobilewash`, `NOINDEX=true`)
- Production: `https://lp.rexdalemobilewash.ca` — Worker `lp-rexdalemobilewash`,
  attached as a Custom Domain **2026-09-08**. This is the real site now.

A change deployed to staging reaches no real visitors. **A change deployed to
production does.** There is no CI and no review gate between `npm run deploy`
and the public, so build, deploy to staging, look at it, then deploy production.

**Rollback**, if the new site ever has to come down: delete the Custom Domain
and re-create `A lp.rexdalemobilewash.ca -> 185.206.163.79`, proxied. The old
WordPress site is still running at that address until gate 16
(`wp-20-switch-off-old-site`). That value is not recoverable from Cloudflare —
it is written down in README under *Going live* and nowhere else.

**The staging custom domain does exist**, contrary to older notes here and in
the README that said it was removed. `staging.lp.rexdalemobilewash.ca` is
attached to the staging Worker and serves with a valid certificate: a Workers
Custom Domain gets its own certificate, so the Universal SSL "no second label
below the apex" limit that shaped `img-lp` does not apply to it. Verified
2026-09-08.

**noindex is config, not a hardcoded header.** `worker/index.js` sends
`X-Robots-Tag: noindex, nofollow` when `NOINDEX=true` **or** the hostname is
`*.workers.dev` or starts with `staging.`. The guard means a production config
deployed to a preview hostname is still noindexed. Do not reintroduce an
unconditional header — the live page is what the client's Ads spend points at.

**DNS has moved and the old note here was wrong.** `rexdalemobilewash.ca` is on
Cloudflare nameservers (`dee`/`josh.ns.cloudflare.com`), the zone is `active`,
and the Microsoft 365 records came across intact — gate 6
(`wp-10-confirm-dns-is-ours`) is satisfied, not blocked. Verify before relying
on it; the previous version of this file claimed the opposite.

## Images are on Backblaze B2 — the build enforces it

Bucket `lp-rexdalemobilewash-img` (`us-east-005`), served through Cloudflare at
`https://img-lp.rexdalemobilewash.ca`. `npm run build` runs
`site/bin/check-images.mjs` and **exits non-zero** if any image in `dist/` comes
from another host.

If a build fails on it, the check is right. Put the file in the bucket; do not
add a host to `allow` in `site/image-hosts.json` to get a deploy out.

`site/src/lib/img.ts` is the only place the hostname is named — use `upload()`
for anything that came off the old WordPress install and `img()` for everything
else. Never reference `*.backblazeb2.com` in page code: that skips Cloudflare
and bills the client for every download.

The hostname is `img-lp`, not `img.lp.…`, because `img.rexdalemobilewash.ca` is
already the main site's bucket and the free Universal SSL certificate does not
cover a second label below the apex.

## Analytics — Ads tagging lives in GTM, not in the page

Google Ads is fired by container `GTM-NMTLRJ63` only. There is no hardcoded
gtag.js on any page, and `Analytics.astro` is Microsoft Clarity (`qsc0wq5qpr`)
and nothing else. There is no GA4 (no `G-` measurement ID anywhere).

The old WordPress theme fired Ads from hardcoded snippets, and the Astro build
reproduced them verbatim through the cutover so the Ads account would not see a
gap. That snippet has now been removed in favour of the container, so **the
container is the only thing counting conversions**. It must cover:

- the Google Ads tag for `AW-16946176869`, all pages
- call conversion `AW-16946176869/jqC8COOXo64aEOXGyJA_`, number swap to
  (416) 244-6497
- form conversion `AW-16946176869/cnvWCPKRo64aEOXGyJA_` — on the `/thank-you/`
  page view for the main site's forms, and on the `generate_lead` dataLayer
  push for `/pressure-washing/`

`/thank-you/` is reachable only after `worker/contact.js` accepts a submission,
so a page view there is a real lead — a URL trigger on that path is equivalent
to the on-load snippet it replaced, and abandoned or failed submissions still
never count.

**Do not re-add a hardcoded Ads tag while the container fires one.** That is the
double-count: every conversion lands twice and the Ads account optimises against
inflated numbers. Pick one place — today it is the container.

`Analytics.astro` is pulled in by `Base.astro` (covering `/`,
`/privacy-policy/`, `/thank-you/`) and separately by `pressure-washing.astro`,
which has its own head and does not use `Base`. Both also load `GTM-NMTLRJ63`
independently.

## Build note

`npm install` stalls on the sharp/esbuild binary matrix. See README —
use `--omit=optional` then install the one rolldown native binding.
