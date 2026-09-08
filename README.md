# rexdalemobilewash-lp

Astro replica of `lp.rexdalemobilewash.ca`, built the same way as
briansmasonry: the live Elementor stylesheets ported declaration-by-declaration
into scoped Astro `<style>` blocks, with each Elementor element id kept in a
comment beside the block it came from.

## Status

**Builds clean.** 4 pages, zero errors, zero warnings, and the AD-9 image check
passes. `site/dist/` is build output and is not committed — `.gitignore` excludes
it. There is no CI: `npm run build` then `npm run deploy:staging`, by hand. See
*Two environments*.

```bash
cd site
npm install --omit=optional
npm install @rolldown/binding-linux-x64-gnu@1.2.7   # see note below
npm run build
node bin/make-standalone.mjs                        # refresh site/standalone/
```

### The install note that matters

A plain `npm install` stalls — Astro 7 pulls the whole `sharp` and `esbuild`
platform-binary matrix and resolution runs long. `--omit=optional` fixes that
(177 packages in 34s) but strips the one native binding rolldown actually needs,
so the build then dies with *"Cannot find native binding"*. Installing just the
binding for your platform afterwards is the fix. On Windows that is
`@rolldown/binding-win32-x64-msvc@1.2.7`; check
`node_modules/rolldown/package.json` for the version if it has moved.

## Layout

```
site/
  package.json  package-lock.json  astro.config.mjs
  src/
    layouts/Base.astro          globals, palette, fonts, section shell, buttons
    components/ Header.astro Hero.astro Steps.astro ServiceSection.astro
                WhyUs.astro About.astro Faq.astro Clients.astro
                ClosingCta.astro Footer.astro EstimateForm.astro
                Analytics.astro   Ads + Clarity, the ONE place they are named
    pages/      index.astro privacy-policy.astro thank-you.astro
                pressure-washing.astro   (self-contained, see below)
    lib/img.ts    the ONE place the image host is named (AD-9)
  image-hosts.json          canonical image host + allowlist, read by the check
  .env.example              PUBLIC_IMG_BASE, a build variable
  public/pw-assets/fonts/   fonts for the pressure-washing page. Fonts only —
                            the photos moved to the bucket, see Images below
  dist/         astro build output, directory format (gitignored)
  standalone/   flat single-file HTML, CSS inlined, opens from file://
  bin/make-standalone.mjs   regenerates standalone/ from dist/
  bin/check-images.mjs      AD-9 enforcement, runs inside `npm run build`
  bin/live-check.mjs        gate 15 — sweeps the SERVED site, not dist/
  bin/live-urls.txt         the address list it sweeps (a reconstruction)
  bin/live-sweep.tsv        last sweep report
bin/where.py    gate-record reader from the earlier scaffolding attempt
```

No `src/data`, no `src/styles`, no Tailwind — globals live in `Base.astro`,
content lives inline in the components. Astro `^7.0.0`, `output: 'static'`.

## `/pressure-washing/` — the commercial LP

A second landing page, ported from the "Rexdale Mobile Wash — Commercial LP V03"
design export. It is **not** part of the Elementor replica above and deliberately
does not use `Base.astro`: it is its own design system (Oswald/Barlow, navy
`#0A4C8A` + red `#C4141A`) and Base's globals would fight it. Everything it needs
is in `src/pages/pressure-washing.astro`, plus its fonts in
`public/pw-assets/fonts/` and its photography in the B2 bucket under the
`pw-assets/img/` prefix.

### `/pressurewashing/` is an alias, not a second page

The un-hyphenated spelling **301s to `/pressure-washing/`**, with or without a
trailing slash. It is not a legacy WordPress address — neither spelling ever
existed on the old site — it exists because that is the spelling people reach
for, ad destinations included.

A redirect rather than a second copy of the page: two URLs serving identical
content split the analytics and leave search engines to pick a canonical.

**The query string is carried across**, and that is the point of the entry
rather than an incidental nicety: an Ads click arrives with `gclid`, and
dropping it breaks conversion attribution for exactly the traffic the alias is
there to catch.

It lives in `ALIASES` in `worker/index.js`, not in Astro's `redirects` config,
because the build is `output: 'static'` — there Astro emits a meta-refresh HTML
page rather than a real redirect, and a paid click deserves a 301, not a page
that loads and then bounces the visitor. Further aliases go in that same map.

The design arrived as a single 30 MB HTML file: a React runtime that rendered a
template at load time, with every image and font inlined as base64. Neither half
of that shipped — Cloudflare rejects a static asset over 25 MiB, and a page
carrying paid traffic should not be blank until React boots. The template was
resolved to plain HTML instead:

- the design's `{{ bindings }}` are baked to their initial render state;
- viewport-dependent ones (hero scrim, header sizing, the sticky mobile bar)
  became media queries, so no layout decision waits on JavaScript;
- `style-hover` / `style-focus` became the `.h*` / `.f*` rules in the page head
  (`!important`, because the base styles are inline and would otherwise win);
- photos were re-encoded to WebP at 2x their layout box — **22.7 MB → 1.6 MB**;
- fonts are self-hosted under `/pw-assets/fonts` rather than fetched from Google.

Accordion, carousels, sticky bar and form submission are one vanilla script at
the end of the body. Verified against the original in headless Chromium at 1440
and 390: identical page height (11151px), identical visible text, and 0.09% of
pixels differing — all of it WebP re-encode noise, none by more than a hair.

To regenerate after a new design export, redo the port; there is no build step
that reads the export at build time.

### The quote forms

**Both post to `POST /api/contact`** — the same Worker route and the same Resend
key as the Elementor-replica forms, so there is one place a lead can go missing
rather than two. Web3Forms is gone: no third-party form service, no second
vendor holding a key, and because the endpoint is same-origin it inherits the
Origin check, the per-IP rate limit and the honeypot already in the Worker.

The design shipped posting to Web3Forms with an empty access key, which meant
the forms were dead and the phone number was the page's only conversion path.

**The field names are load-bearing.** The visible, required "Company *" input
posts as `organization`, **not** `company`:

| Field | Posts as | Why |
|---|---|---|
| Company * | `organization` | `company` is the honeypot the Elementor forms use |
| (hidden) | `botcheck` | this page's honeypot; the Worker knows both names |
| Property Type * | `property_type` | shown as its own row in the notification |
| (hidden) | `source` | `Commercial LP — hero` / `— final CTA` |

Wiring the real company name to `company` would have made every genuine
commercial lead look like a bot to the Worker — 202, no email, no error
anywhere, and nobody the wiser until someone asked why the quote requests had
stopped. See `HONEYPOTS` in `worker/contact.js`.

`source` tags the subject line — `New estimate request — Dana Okafor
[Commercial LP — hero]` — so commercial quote requests are separable in the
inbox from the main landing page's enquiries without opening either.

The page uses the same GTM container as the rest of the build
(`GTM-NMTLRJ63`), and pushes `generate_lead` to the dataLayer only after the
Worker confirms the send — not on click, which would count abandoned and failed
submissions as conversions.

## Two environments

One script, two Workers. `site/wrangler.jsonc` defines both.

| | Worker | Reached at | `NOINDEX` |
|---|---|---|---|
| Production | `lp-rexdalemobilewash` | its Custom Domain only (`workers_dev: false`) | `false` |
| Staging | `staging-lp-rexdalemobilewash` | `staging-lp-rexdalemobilewash.ash-47a.workers.dev`, `staging.lp.rexdalemobilewash.ca` | `true` |

```bash
cd site
npm run build
npm run deploy:staging       # --env staging       needs CLOUDFLARE_API_TOKEN
npm run deploy               # --env ""            production
```

Use the scripts. Once a config defines environments, a bare `wrangler deploy`
warns that no target was given and then deploys the top level — production —
anyway; the scripts name the environment explicitly.

**Production is live on `lp.rexdalemobilewash.ca`** since 2026-09-08 — see
*Going live* below. `workers_dev: false` means the Custom Domain is the only way
to reach it, which is deliberate: a workers.dev URL would be a second, indexable
copy of the live site competing with it in search.

`RESEND_API_KEY` is set on it, and it is **its own key** — a secret belongs to
one Worker, and staging's is a different key, so revoking one cannot take the
other down.

**A production deploy is public immediately.** There is no CI and no review step
between `npm run deploy` and real visitors, so: build, deploy staging, look at
it, then deploy production.

The contact form was proven end to end against it before the cutover, over
`wrangler dev --remote --env ""`, which runs the real Worker with the real
secret and exposes it on localhost only: `POST /api/contact` returned
`{"ok":true,"id":…}` and Resend accepted the message. That check matters because
a missing secret is invisible until a real visitor submits — the build passes,
every page looks right, and the form 500s.

### noindex is config, not a hardcoded header

`worker/index.js` sends `X-Robots-Tag: noindex, nofollow` when `NOINDEX=true`
**or** the hostname is `*.workers.dev` or begins `staging.`. The hostname guard
is deliberate: it can only ever fail safe, so a production config deployed to a
preview hostname is still noindexed.

It used to be an unconditional `headers.set(...)` with a comment saying to
remove it before production. That would have shipped with the first cutover
deploy and quietly deindexed a page carrying paid traffic — a comment is not a
safeguard.

### Staging's custom domain

`staging.lp.rexdalemobilewash.ca` **is** attached to the staging Worker and
serves with a valid certificate. Earlier notes in this file said a custom domain
was tried and removed; that was true at the time and is no longer. A Workers
Custom Domain gets its own certificate, so the free Universal SSL "no second
label below the apex" limit — the constraint that shaped `img-lp` — does not
apply to it.

The nameserver situation those notes described has also changed. Verified
2026-09-08 over public DNS:

```
NS   dee.ns.cloudflare.com / josh.ns.cloudflare.com   (was ns69/ns70.domaincontrol.com)
MX   0 rexdalemobilewash-ca.mail.protection.outlook.com
TXT  "v=spf1 include:secureserver.net -all"
TXT  "NETORG7588905.onmicrosoft.com"
```

The nameservers moved, the zone is `active`, and the Microsoft 365 mail records
came across intact — so gate 6 (`wp-10-confirm-dns-is-ours`) is satisfied and
Cloudflare is authoritative. That is what made `img-lp.rexdalemobilewash.ca`
possible, and what makes the cutover below a Cloudflare-side operation rather
than a registrar one.

## Going live — done 2026-09-08

`lp.rexdalemobilewash.ca` serves this build. Gate 13 of `wp-migration`
(`wp-17-point-domain-at-new-site`) is complete.

### The rollback record — keep this

The record that answered for the hostname before the cutover, read from the
Cloudflare zone `rexdalemobilewash.ca` (`a4310a1bbb3a53ad3206c1809e6d61b1`):

```
A   lp.rexdalemobilewash.ca   185.206.163.79   proxied, TTL auto (1)
```

**This is still the rollback and it is written down here because it cannot be
re-derived.** A Custom Domain cannot be created over an existing record, so that
record was deleted to make room, and Cloudflare does not keep what it deletes.

**To roll back:** delete the Custom Domain, then re-create `A 185.206.163.79`,
proxied. The WordPress install was not touched by the cutover and is not
switched off until gate 16 (`wp-20-switch-off-old-site`), which is the whole
reason the order was arranged this way.

**Whether that origin still answers has NOT been verified**, and an earlier note
here claiming it had was wrong. `curl --resolve` is silently ignored from the
build environment — its egress proxy does its own DNS, so a request aimed at a
deliberately bogus IP still returned the live site. Every "direct to origin"
check made from here was really measuring Cloudflare. Confirm the old install is
still up in the Hostinger panel before treating this rollback as ready.

### What was done

1. Production Worker redeployed from a clean build at `3d45a85`, secret
   confirmed present, **before** any DNS change — so the Worker was ready to
   serve the instant the hostname pointed at it.
2. The `A` record was deleted and the Custom Domain created immediately after.
   Two seconds apart; the hostname resolved to nothing in between. Cloudflare
   then wrote its own `AAAA lp.rexdalemobilewash.ca -> 100::` proxied, which is
   the normal Custom Domain placeholder, and issued the certificate.

A Custom Domain, not a Route: the Worker *is* the origin, so Cloudflare owns
both the DNS record and the certificate. The API needs `PUT` on
`/accounts/{id}/workers/domains` — `POST` returns `10405 Method not allowed for
this authentication scheme`, and `override_existing_dns_record` is not honoured,
so the delete-first order is forced rather than chosen. The dashboard equivalent
is Worker → Settings → Domains & Routes.

It is still deliberately **not** a `routes` entry in `wrangler.jsonc` — that
would put an irreversible step behind an ordinary `npm run deploy`.

`MX` and the apex `TXT` records were read before and after and are byte-identical.
Zone SSL mode is still `full` (AD-2).

### Verified live after the cutover

```
https status .............. 200, valid certificate (curl ssl_verify_result 0)
serving ................... the Astro build (_astro bundles; WordPress gone)
X-Robots-Tag .............. absent on all four pages   <- production is indexable
routes .................... / /pressure-washing/ /privacy-policy/ /thank-you/ 200
                            /pressurewashing/ 301, unknown path 404
assets .................... 51 referenced across the four pages, all 200
images .................... 23 references, all on img-lp.rexdalemobilewash.ca
analytics ................. Ads + call conversion + Clarity on every page,
                            form conversion on /thank-you/ only
contact form .............. POST /api/contact -> 202 {"ok":true,"id":…}
                            honeypot 202 without sending, cross-origin 403
client MX + TXT ........... unchanged
ssl mode .................. full
staging ................... unaffected, still noindex
old origin ................ 185.206.163.79 still 200 — rollback intact
```

Browser-level rendering could not be checked from the build environment — its
egress proxy resets browser connections. The asset sweep above stands in for it:
every stylesheet, script, font and image the four pages reference was fetched
and returned 200.

## Keeping the old links working — gate 14, partial

AD-10: nothing is retired. The map is short because almost nothing moved —
`/`, `/thank-you/` and `/privacy-policy/` all kept their paths, so no page
needs a rule at all.

### The images wildcard — done

Every old media address 301s to the bucket:

```
/wp-content/uploads/*  ->  https://img-lp.rexdalemobilewash.ca/wp-content/uploads/*
```

**Host swap only, path untouched.** The generic procedure uses
`substring(http.request.uri.path, 20)` because it assumes the bucket strips
`/wp-content/uploads/`; this bucket deliberately kept the WordPress key layout,
so applying that shape here would 404 every image. Verified: all 21 old upload
addresses the live site references return 301 and then 200.

These are the addresses that leaked outward — Google Images, social unfurl
caches, anything that hotlinked a photo — and they 404'd from the moment the
domain moved.

`/wp-content/plugins/…`, `/wp-content/themes/…` and `/wp-includes/…` are
deliberately **not** redirected. They existed only to render the old Elementor
page and nothing outside the old site linked to them; 404 is the honest answer.
One exception falls out of the wildcard: `/wp-content/uploads/elementor/…`
generated CSS 301s to the bucket and then 404s, because it was never copied
there. Harmless — nothing external references it.

### Where it lives, and why not Redirect Rules

The procedure says to put this in Cloudflare → Rules → Redirect Rules, on the
reasoning that a redirect inside WordPress dies when WordPress is switched off
at gate 20. It is in `worker/index.js` instead, for two reasons:

1. **`CF_API_TOKEN` cannot write Rules.** It reads rulesets fine but every write
   returns `request is not authorized`, and the account-level rules endpoints
   return 403. Bulk Redirects are not reachable either.
2. The reasoning does not transfer. The Worker is not the old site — it *is* the
   new one, and it outlives gate 20.

What Redirect Rules would still buy: independence from a bad Worker deploy, and
evaluation before the Worker runs. If that is wanted, the rule to create by hand
is — and note the host condition, which is **not** optional:

```
expression: (http.host eq "lp.rexdalemobilewash.ca"
             and starts_with(http.request.uri.path, "/wp-content/uploads/"))
target:     concat("https://img-lp.rexdalemobilewash.ca", http.request.uri.path)
status:     301        preserve query string: on
```

Without `http.host`, the rule also catches `rexdalemobilewash.ca`, whose images
live in a **different** bucket (`img.rexdalemobilewash.ca`) — every image on the
main site would be redirected to the wrong place. Delete the `UPLOADS_PREFIX`
branch in `worker/index.js` if the rule is created, so there is one owner.

### WordPress plumbing addresses

The old site also answered on paths that cannot exist on a static site. Only one
of them was a real indexable page, and only that one redirects:

```
/author/ashbrandingcentres-com/   ->  /          301   author archive
/feed/  /comments/feed/               404              feeds — no blog ever existed
/wp-json/*  /xmlrpc.php               404              endpoints, not pages
/wp-admin/admin-ajax.php              404
```

The 404s are deliberate. Answering 200-via-redirect on a feed tells a crawler
the homepage *is* the feed; nothing ever indexed those addresses, and an
endpoint that no longer exists should say so. The author archive is the
exception because it was indexable, so it passes its ranking on rather than
dead-ending.

The match is exact, not a `/author/*` prefix — one author existed, and a
wildcard would swallow paths nobody has asked for.

## Gate 15 — the live sweep

```bash
cd site && npm run check:live      # or: node bin/live-check.mjs [base-url]
```

Checks the site that is **served**, not the one in `dist/`, because a redirect
rule, a transform rule, an edge cache or a Worker route can put a different
response in front of a visitor than the build produced. Three blocks: the URL
sweep, the live image check, the live SEO check. Non-zero exit blocks gate 16.

`site/bin/live-urls.txt` is the address list and `site/bin/live-sweep.tsv` the
last report. **The list is a reconstruction**, built from the old site's own HTML
captured through Cloudflare shortly before the cutover — the canonical gate 0.4
record is in the command repo. The old install had no sitemap and its REST API
is gone, so an orphan page nothing linked to would not appear. Reconcile before
treating a pass as complete.

### Result, 2026-09-08

```
  addresses in the list ..... 46
  200 direct ................  4
  301 -> 200 ................ 33
  404 by decision ...........  9
  FAILED ....................  0

  image references .......... 44, all on img-lp   off-host 0
  cf-cache-status ........... present  <- proxied; MISS is fine, presence is the test
  out-of-bucket path ........ 404      <- gate 7 transform rule still scoped
  canonicals ................ 4 of 4 on the real domain, trailing slash matches
  JSON-LD ................... 2 blocks, 2 parse
```

### What the sweep caught

**16 of the 30 old media addresses were 301 → 404.** WordPress generated a
resized copy of every upload with the dimensions in the filename
(`Graffiti-Removal-300x220.webp`), only the originals were copied to B2 at gate
5, and the gate 14 wildcard sent every derivative to a key that does not exist.
Those addresses are the ones in Google Images and in anything that hotlinked a
thumbnail — broken silently, in the way this gate exists to catch.

Fixed in `worker/index.js`: `WP_SIZE_SUFFIX` strips the size before redirecting,
so a derivative lands on the full-size original. Safe because it was checked
rather than assumed — **not one of the 29 objects in the bucket has a `-WxH`
key**, so a stripped path cannot collide with a distinct file. Two digits minimum
per dimension, so `Truck-4x4.webp` keeps its name; WordPress never registers a
single-digit size.

**One failure was the checker's own bug**, worth recording because the shape
recurs: `img-lp.rexdalemobilewash.ca` **ends with** `lp.rexdalemobilewash.ca`, so
a substring test for the old image host flagged every correctly-migrated page.
The `//` in `//lp.rexdalemobilewash.ca` is what separates the host from a suffix
of it — the convention `bin/check-images.mjs` already used.

### Advisory — passes the gate, still wants a decision

- **No JSON-LD on `/`, `/privacy-policy/`, `/thank-you/`.** The old `/` and
  `/thank-you/` each carried a graph, so this is a regression the migration
  introduced. It is worth being precise about what was lost: RankMath
  boilerplate whose `Organization.name` was the literal string
  `lp.rexdalemobilewash.ca`, with no telephone, no address, an `Article` node on
  a landing page, and a `Person` node exposing `ash@brandingcentres.com`.
  Restoring it verbatim would restore junk. `/pressure-washing/` already carries
  a real `LocalBusiness` graph with genuine NAP; lifting that into `Base.astro`
  would close the gap properly and invents nothing.
- **No `sitemap.xml`.** The old install had none either, so a pre-existing gap
  rather than a regression — but worth closing.

### Still open after the cutover

Analytics parity is done (see *Analytics* below). These are not, and are now
open on a **live** site:

- **Privacy policy is placeholder text.** See *Open items*.
- **Gates 14 and 15 have not run** — `wp-18-keep-old-links-working` (edge
  redirects) and `wp-19-check-nothing-is-broken` (the live sweep). The old page
  linked nowhere but `/`, `/feed/`, `/comments/feed/` and `wp-json`, so the
  redirect surface is small, but small is not none.
- The gate record `sites/lp.rexdalemobilewash.ca.md` lives in the command repo,
  not this one, so gate 12's status was never confirmable from here.

## Analytics

The live WordPress page fires Google Ads and Clarity from hardcoded theme
snippets. All four are reproduced verbatim in
`site/src/components/Analytics.astro`, captured from the live `/` and
`/thank-you/` on 2026-09-08:

| Tag | Id |
|---|---|
| Google Ads gtag.js | `AW-16946176869` |
| Call conversion + number swap | `AW-16946176869/jqC8COOXo64aEOXGyJA_` → (416) 244-6497 |
| Form conversion, `/thank-you/` only | `AW-16946176869/cnvWCPKRo64aEOXGyJA_` |
| Microsoft Clarity | `qsc0wq5qpr` |

There is no GA4 on either site — no `G-` measurement id exists anywhere.

They are hardcoded rather than configured in GTM because this page carries paid
traffic and conversion history is not backfillable: anything not carried across
simply stops counting the moment the domain moves, and nobody notices until the
Ads account has optimised against a hole.

`Base.astro` pulls the component in for `/`, `/privacy-policy/` and
`/thank-you/`; `pressure-washing.astro` pulls it in separately because it has
its own head and does not use `Base`. Only `/thank-you/` passes a `conversion`
prop — that event fires on page load, which is safe because the Worker's 303 is
the only way to reach the page, so abandoned and failed submissions are never
counted.

**Double-counting is the one way this goes wrong.** The build also loads GTM
container `GTM-NMTLRJ63`. If that container is ever configured to fire
conversions for `AW-16946176869` while these snippets are present, every
conversion counts twice. Pick one place; if it moves to GTM, delete
`Analytics.astro` in the same change.

Every response carries `X-Robots-Tag: noindex, nofollow`, set in
`worker/index.js`, so staging cannot compete with the live site in search.

`standalone/` exists because Astro's absolute `/_astro/...` paths break under
`file://`. Double-click `standalone/index.html`; hard-refresh with Ctrl+F5 if
you have opened it before. It is generated, so re-run `bin/make-standalone.mjs`
after any build rather than editing those files by hand.

## Source of the CSS

Four stylesheets, fetched from the live site and ported by hand:

| File | Size | Covers |
|---|---|---|
| `post-6.css` | 1.6 KB | global kit — palette, container widths, breakpoints |
| `post-23.css` | 3.2 KB | theme-builder header |
| `post-18.css` | 1.9 KB | theme-builder footer |
| `post-110.css` | 83.2 KB | the landing page itself |

Nothing was scraped and no HTML was exported from WordPress — only public
pages were read, no login and no REST writes.

### Palette (`.elementor-kit-6`)

| Token | Value | Elementor name |
|---|---|---|
| `--c-blue` | `#164E83` | `--e-global-color-c8ead36` |
| `--c-blue-mid` | `#376898` | `--e-global-color-9732338` |
| `--c-blue-pale` | `#D4E4ED` | `--e-global-color-4376da3` |
| `--c-blue-grey` | `#9DB6C9` | `--e-global-color-d496520` |
| `--c-offwhite` | `#FCFDFC` | `--e-global-color-b266324` |
| `--c-frame-pale` | `#DFEBFF` | literal, image frame shadows only |

Sections run `--content-width: 80vw` above 768px, `100vw` in the 768–1024 band,
capped at the kit's 1140px. Headings step 40px → 30px → 25px. Sections pad
100px → 50px.

### Fonts

Measured with `document.fonts` on the live site: **Source Sans Pro** 400/600/700
and **Montserrat** 400/500/700 load and are used; **Roboto** 400 loads but is
only referenced through kit variables that every visible element overrides;
**Roboto Slab** is declared as `--e-global-typography-secondary` and never
loads at all. Only the two families that do visible work are requested.

## The contact form

Both estimate forms (hero and closing CTA) post to **`POST /api/contact`**,
handled at request time by `site/worker/contact.js` and sent through Resend.

The route lives in the Worker, not in `src/pages`. The build is
`output: 'static'`, so a route under `src/pages` would be prerendered to a file
and would accept nothing. Keeping it in the Worker also preserves the noindex
wrapper in `worker/index.js`, which the `@astrojs/cloudflare` adapter would
have replaced.

### Addressing — do not "improve" this casually

| | |
|---|---|
| From | `forms@brandingcentres.com` — the **shared** sending domain |
| To | `dispatch@rexdalemobilewash.ca` |
| Cc | `Paolo@tboxstudio.com` |
| Reply-To | `dispatch@rexdalemobilewash.ca` |

`rexdalemobilewash.ca` is **never** used as a sending domain. That is the whole
point: no SPF, DKIM or DMARC record of the client's is involved, so nothing this
endpoint does can reach their Microsoft 365 mail reputation. The visitor's
address never goes in `From` either — to a receiving mail server that is forgery
and it lands every notification in spam. It goes in the body as a `mailto:` link.

The visitor also gets a confirmation email (`CONTACT_CONFIRM`), sent *after* the
notification has already succeeded and best-effort: a bounced confirmation must
never cost the client a real lead.

### The API key is a Worker secret

```bash
cd site
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler secret put RESEND_API_KEY --env staging
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler secret put RESEND_API_KEY --env ""
```

**A secret belongs to one Worker, and there are two.** Each environment holds
its own key, both scoped to *sending access on brandingcentres.com only*:

| Environment | Resend key name |
|---|---|
| `--env staging` | `lp.rexdalemobilewash.ca` |
| `--env ""` (production) | `lp.rexdalemobilewash.ca production worker` |

Separate keys, not a shared one, so either can be revoked without taking the
other down — revoking staging's key must never be able to stop the live form.

Rotate by creating a new key in Resend, re-running the command above for the
environment concerned, and deleting the old key once the form is confirmed
working. `npx wrangler secret list --env <name>` reads back the name only;
Cloudflare never discloses a secret's value, so a lost key is replaced, not
recovered.

**Do not add it as a Build variable.** A build variable is present while the
build runs and absent when the route executes: the build passes and the form
500s in production. Everything else (addresses, site name) is a plain `var` in
`wrangler.jsonc` on purpose, so it is visible in review.

### Abuse protection, and what is actually protecting it

- **Honeypot** — two hidden fields, `company` and `botcheck`. Anything that
  arrives with either one filled in is a bot, and gets a `202` rather than an
  error, because telling a bot it failed only makes it retry. This stops more
  real-world form spam than the rate limit.

  Two names because the two form families were built at different times:
  `EstimateForm.astro` traps on `company`, the commercial LP traps on
  `botcheck`. **This is why the commercial LP's real, required "Company *" input
  posts as `organization`** — see that page's *quote forms* section. Anything
  added later must check `HONEYPOTS` in `worker/contact.js` before naming a
  visible field.
- **Rate limit** — 8/min per IP via the Workers rate limiting binding. Know what
  this is: it is counted **per data centre** and is documented as "permissive,
  eventually consistent, and intentionally designed to not be used as an
  accurate accounting system". A caller spread across colos gets a multiple of
  the limit. It is a brake on the naive case, not a guarantee.
- **Not yet present:** a WAF rate limiting rule and Turnstile. Both need a
  Cloudflare **zone** to attach to. `staging.lp.rexdalemobilewash.ca` is now in
  the zone, so they can be attached and tested there ahead of the cutover rather
  than added to a live site afterwards.

### Client mail, re-proven after this change

Unchanged by anything in this repo. The nameservers have since moved to
Cloudflare (see **Staging** above); the mail records themselves are the same:

```
NS    dee/josh.ns.cloudflare.com     (was ns41/ns42.domaincontrol.com)
MX    rexdalemobilewash-ca.mail.protection.outlook.com
TXT   v=spf1 include:secureserver.net -all
TXT   NETORG7588905.onmicrosoft.com
TXT   _dmarc  v=DMARC1; p=none;
```

**Pre-existing, not caused by this work:** that SPF record authorises GoDaddy
(`secureserver.net`) with a hard fail `-all`, but the domain's mail is on
Microsoft 365, which is *not* included. Mail sent from their tenant can fail
SPF at strict receivers. A `_dmarc` record now exists at `p=none` — monitoring
only, so it enforces nothing, but it does mean reports can be turned on. Worth
raising with whoever owns the client's mail — it is a DNS edit on their side,
deliberately outside what this endpoint touches.

## Two deliberate departures from the live site

**1. The hero slideshow is fixed, not copied.** `#18016ff0` is an Elementor Pro
background slideshow over the five banner images. Its `data-settings` gallery
lists them as `http://` URLs on an `https://` page, so the browser blocks them
as mixed content and the slideshow never initialises — the live hero renders
flat grey. Served here over `https://` with a CSS cross-fade. To reproduce the
grey instead, delete `.hero__slides`.

**2. Client logos are real `<img>` tags.** The original renders them as an
Elementor `e-gallery` — CSS background-images injected by JavaScript, invisible
to crawlers and screen readers. Now nine `<img>` elements with alt text.

*(The third departure — forms that did not submit — is resolved; see **The
contact form** above. These forms' field names are unchanged: name, email,
phone, city, message. The endpoint additionally accepts `organization`,
`property_type` and `source`, all optional, all sent only by the commercial LP
forms.)*

## Images

**On Backblaze B2 (AD-9).** Nothing on this site requests an image from the old
WordPress host any more, and nothing is served out of `public/`.

| | |
|---|---|
| Bucket | `lp-rexdalemobilewash-img` — public, its own bucket, not shared with the main site |
| Region / S3 endpoint | `us-east-005` / `s3.us-east-005.backblazeb2.com` |
| Native origin | `f005.backblazeb2.com` |
| Public hostname | `https://img-lp.rexdalemobilewash.ca` |
| Transform rule | `img-lp.rexdalemobilewash.ca -> B2 bucket lp-rexdalemobilewash-img (AD-9)` |
| Contents | 29 files, 3,069,624 bytes |
| Lifecycle | keep only the last version of a file |

### Why `img-lp` and not `img.lp.rexdalemobilewash.ca`

`img.rexdalemobilewash.ca` already exists in this zone and already points at the
main site's bucket (`rexdalemobilewash-img`), so this site needed its own name.
The convention would be `img.lp.rexdalemobilewash.ca`, and it does not work here:
Cloudflare's free Universal SSL certificate covers `rexdalemobilewash.ca` and
`*.rexdalemobilewash.ca`, but **not a second label below the apex** — that host
would serve a certificate error until the zone buys Advanced Certificate
Manager. `img-lp` is one label, so the existing certificate already covers it.

The two image hosts are fully independent: separate buckets, separate CNAMEs,
separate transform rules. The main site's rule was not touched.

### Keys keep their WordPress paths

`wp-content/uploads/2025/03/Rexdale-Mobile-Wash-Logo.webp`, not a re-organised
name. That makes the rewrite host-only, keeps the two sides reconcilable file
for file, and means a later `rclone` pass against the old site compares cleanly.
The `/pressure-washing/` page's photography keeps the `pw-assets/img/` prefix it
already had; its **fonts stay in `public/`** — they are not images.

### One place names the host

`src/lib/img.ts`. Never build an image URL by hand, and never reference
`*.backblazeb2.com` in page code — that path skips Cloudflare and bills the
client for every download.

```astro
---
import { upload, img } from '../lib/img';
---
<img src={upload('Graffiti-Removal.webp')} width="600" height="400" alt="…" />
<img src={img('pw-assets/img/logo.webp')} width="433" height="433" alt="…" />
```

`PUBLIC_IMG_BASE` overrides the default host (see `.env.example`). It must be a
**build** variable, never a Worker secret: every page is prerendered, so a
runtime secret is not read during the build and the URLs come out
`undefined/...`.

### The build enforces it

`npm run build` is `astro build && node bin/check-images.mjs`. The check fails
the build on any image served from a host other than
`img-lp.rexdalemobilewash.ca`, and it looks in all eight places an image address
hides — `<img src>`, `srcset`, `<source>`, `<link rel=preload as=image>`,
`og:image`/`twitter:image`, `rel=icon`, `url()` in CSS and in inline styles, and
JSON-LD. **If a build fails on this, the check is right** — put the file in the
bucket, do not add the host to `allow` in `image-hosts.json`.

Current output:

```
AD-9 IMAGE CHECK — canonical host img-lp.rexdalemobilewash.ca

  files scanned ...................... 6
  image references ................... 44
  on img-lp.rexdalemobilewash.ca ..... 44
  on an allowed third party .......... 0
  off-host ........................... 0
  local, not in the bucket ........... 0
  files mentioning //lp.rexdalemobilewash.ca/wp-content/uploads  0

AD-9 CHECK PASSED.
```

Verified against fixtures as well as the real build: a `srcset` entry, an
`og:image`, an inline `background-image` and a `url()` in a `.css` file were
each planted in `dist/` and all four were caught and named, while a `data:` URI,
an `/_astro/` bundle asset and a `.woff2` font were correctly ignored.

### Replacing an image later

Prefer a **new filename** — no cache purge, correct everywhere the moment the
code change deploys. Same filename works too, but Cloudflare will keep serving
the old bytes for up to the edge TTL (31 days), so purge that exact URL under
Caching → Configuration → Purge Custom URL and re-check in a private window.

### Still worth doing

`cropped-Rexdale-Mobile-Wash-Favicon.png` is 225 KB — the largest file in the
bucket, for a favicon. Regenerating it is a bucket upload plus a purge.
`Bulk-Water-Delivery.webp` on the old host is unused and was deliberately not
copied.

## Open items

- **Privacy policy is a placeholder.** The original is stock WordPress
  boilerplate about comments, user registration, Gravatar and password resets —
  none of which this site does. The URL and headings are kept so the route
  works; the body text needs writing by whoever owns the client's privacy
  position. Do not publish as-is.
- **De-icing section `#0ed65bb`** carries an `elementor-hidden` class on the
  live DOM. The full class name was truncated in the DOM read so the breakpoint
  it hides at is unknown; the section does render in page source, so it is built
  visible here. Confirm against client intent.
- **Infrastructure, as it now stands.** GitHub org and repo exist; DNS is on
  Cloudflare and authoritative; the staging Worker is deployed and reachable at
  both its `workers.dev` URL and `staging.lp.rexdalemobilewash.ca`; the image
  store is the B2 bucket `lp-rexdalemobilewash-img` served at
  `img-lp.rexdalemobilewash.ca`. The production Worker `lp-rexdalemobilewash`
  holds `lp.rexdalemobilewash.ca` as a Custom Domain and **is the live site**
  (gate 13, 2026-09-08), with its own `RESEND_API_KEY` and its form proven
  against the live domain. Old image addresses and the old author archive
  redirect (gate 14). Gate 15, the live sweep, has not run.
  See *Going live* for the rollback record.
- **No day-2 procedure exists** anywhere in the toolchain for shipping a change
  to a live site. Flag at handover.
