# rexdalemobilewash-lp

Astro replica of `lp.rexdalemobilewash.ca`,: the live Elementor stylesheets ported declaration-by-declaration
into scoped Astro `<style>` blocks, with each Elementor element id kept in a
comment beside the block it came from.

## Status

**Builds clean.** 4 pages, zero errors, zero warnings, and the AD-9 image check
passes. `site/dist/` is build output and is not committed — `.gitignore` excludes
it. There is no CI: `npm run build` then `npx wrangler deploy`, by hand.

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

### Before this page goes live

**The quote forms are not connected.** The design posts to Web3Forms; no access
key was supplied. `ACCESS_KEY` at the top of the page's inline script is empty,
and while it is empty a submission is refused in the browser with a visible
"not connected yet, please call" message rather than posting a real enquiry into
a void — the same posture as `EstimateForm.astro`. Paste the key there and both
forms switch on; nothing else needs to change. Until then the page's only
working conversion path is the phone number.

The page uses the same GTM container as the rest of the build
(`GTM-NMTLRJ63`), and pushes `generate_lead` to the dataLayer only after
Web3Forms confirms a success — not on click, which would count abandoned and
failed submissions as conversions.

## Staging

Deployed as a Cloudflare Worker (static assets) named
`staging-lp-rexdalemobilewash`:

```bash
cd site
npm run build
npx wrangler deploy          # needs CLOUDFLARE_API_TOKEN
```

Live at **https://staging-lp-rexdalemobilewash.ash-47a.workers.dev**. That is
the only staging URL; there is no custom domain.

A custom domain was tried and removed, at a time when `rexdalemobilewash.ca` sat
on GoDaddy nameservers and the Cloudflare zone was `pending` with zero records.
**That is no longer the case.** Verified 2026-09-08 over public DNS:

```
NS   dee.ns.cloudflare.com / josh.ns.cloudflare.com   (was ns69/ns70.domaincontrol.com)
MX   0 rexdalemobilewash-ca.mail.protection.outlook.com
TXT  "v=spf1 include:secureserver.net -all"
TXT  "NETORG7588905.onmicrosoft.com"
```

The nameservers moved, the zone is `active`, and the Microsoft 365 mail records
came across intact — so gate 6 (`wp-10-confirm-dns-is-ours`) is satisfied and
Cloudflare is authoritative. That is what made `img-lp.rexdalemobilewash.ca`
possible. A staging hostname is still not set up; it would need
`staging.lp.rexdalemobilewash.ca`, which is two labels below the apex and so is
**not covered by the free Universal SSL certificate** — the same constraint that
shaped the image hostname. `workers.dev` remains the only staging URL.

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
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" npx wrangler secret put RESEND_API_KEY
```

Resend key name `lp.rexdalemobilewash.ca`, scoped to *sending access on
brandingcentres.com only*. Rotate by creating a new key in Resend and re-running
the command above.

**Do not add it as a Build variable.** A build variable is present while the
build runs and absent when the route executes: the build passes and the form
500s in production. Everything else (addresses, site name) is a plain `var` in
`wrangler.jsonc` on purpose, so it is visible in review.

### Abuse protection, and what is actually protecting it

- **Honeypot** — a hidden `company` field. Anything that arrives filled in is a
  bot, and gets a `202` rather than an error, because telling a bot it failed
  only makes it retry. This stops more real-world form spam than the rate limit.
- **Rate limit** — 8/min per IP via the Workers rate limiting binding. Know what
  this is: it is counted **per data centre** and is documented as "permissive,
  eventually consistent, and intentionally designed to not be used as an
  accurate accounting system". A caller spread across colos gets a multiple of
  the limit. It is a brake on the naive case, not a guarantee.
- **Not yet present:** a WAF rate limiting rule and Turnstile. Both need a
  Cloudflare **zone** to attach to, and this is served from `workers.dev`. Add
  them when the Worker gets a custom domain.

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
contact form** above. Field names are unchanged: name, email, phone, city,
message.)*

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
  Cloudflare and authoritative; the staging Worker is deployed; the image store
  is the B2 bucket `lp-rexdalemobilewash-img` served at
  `img-lp.rexdalemobilewash.ca`. The live WordPress site is still untouched and
  `lp.rexdalemobilewash.ca` still resolves to it — the domain has not been
  pointed at the Worker.
- **No day-2 procedure exists** anywhere in the toolchain for shipping a change
  to a live site. Flag at handover.
