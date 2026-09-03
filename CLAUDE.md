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
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler deploy
```

After deploying, verify against the live URL rather than trusting the
build — fetch the page and grep for what you changed.

## Staging vs live

- Staging: `https://staging-lp-rexdalemobilewash.ash-47a.workers.dev`
  (Worker `staging-lp-rexdalemobilewash`, sends `X-Robots-Tag: noindex, nofollow`)
- Public: `https://lp.rexdalemobilewash.ca` — still the **old WordPress /
  Elementor site**. The Astro build is not public yet; the domain move is
  gate 6 (`wp-10-confirm-dns-is-ours`) and is blocked on the client's
  Microsoft 365 mail records.

A change deployed to staging reaches no real visitors.

## Analytics currently on the public WordPress site

Hardcoded in the theme, not via a tag manager:

- Google Ads gtag.js `AW-16946176869` (all pages)
- Call conversion `AW-16946176869/jqC8COOXo64aEOXGyJA_`, number swap to
  (416) 244-6497
- Form conversion `AW-16946176869/cnvWCPKRo64aEOXGyJA_` on `/thank-you/`
- Microsoft Clarity `qsc0wq5qpr`
- No GA4 (no `G-` measurement ID anywhere)

GTM container `GTM-NMTLRJ63` is installed in the Astro build only. If that
container is ever configured to fire Ads conversions for `AW-16946176869`
while the hardcoded snippet is also present, conversions count twice.

## Build note

`npm install` stalls on the sharp/esbuild binary matrix. See README —
use `--omit=optional` then install the one rolldown native binding.
