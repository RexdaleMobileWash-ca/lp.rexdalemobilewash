# rexdalemobilewash-lp

Astro replica of `lp.rexdalemobilewash.ca`, built the same way as
briansmasonry: the live Elementor stylesheets ported declaration-by-declaration
into scoped Astro `<style>` blocks, with each Elementor element id kept in a
comment beside the block it came from.

## Status

**Builds clean.** 4 pages, zero errors, zero warnings. `site/dist/` is build
output and is not committed — `.gitignore` excludes it, and Railway builds from
source.

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
  public/pw-assets/   images + fonts for the pressure-washing page only
  dist/         astro build output, directory format (gitignored)
  standalone/   flat single-file HTML, CSS inlined, opens from file://
  bin/make-standalone.mjs   regenerates standalone/ from dist/
bin/where.py    gate-record reader from the earlier scaffolding attempt
```

No `src/data`, no `src/styles`, no Tailwind — globals live in `Base.astro`,
content lives inline in the components. Astro `^7.0.0`, `output: 'static'`.

## `/pressure-washing/` — the commercial LP

A second landing page, ported from the "Rexdale Mobile Wash — Commercial LP V03"
design export. It is **not** part of the Elementor replica above and deliberately
does not use `Base.astro`: it is its own design system (Oswald/Barlow, navy
`#0A4C8A` + red `#C4141A`) and Base's globals would fight it. Everything it needs
is in `src/pages/pressure-washing.astro` plus `public/pw-assets/`.

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

A custom domain was tried and removed. `staging.lp.rexdalemobilewash.ca` cannot
work while `rexdalemobilewash.ca` sits on GoDaddy nameservers
(`ns41`/`ns42.domaincontrol.com`): the Cloudflare zone is `pending`, so
Cloudflare is not authoritative and creates no record, and the zone is `full` on
a Free plan, so CNAME setup is unavailable. Only a nameserver move would work.
It is not safe yet — the Cloudflare zone holds **zero records** while the live
zone carries Microsoft 365 mail (MX to Outlook, SPF, Teams/Skype SRV and CNAME
records), so a cutover today would take down the client's email along with the
site. That is gate 6 of the migration (`wp-10-confirm-dns-is-ours`).

Every response carries `X-Robots-Tag: noindex, nofollow`, set in
`worker/index.js`, so staging cannot compete with the live site in search.

## Forms

Both estimate forms POST to `/api/estimate` on the same Worker.
`worker/index.js` validates the submission and hands it to the Mailgun
messages API; `ASSETS` serves everything else. The route is only reachable
because `run_worker_first: true` is set in `wrangler.jsonc` — without it a
request matching a static asset never invokes the Worker.

| Outcome | With JS | Without JS |
|---|---|---|
| Sent | `{"ok":true}`, page navigates to `/thank-you` | `303` → `/thank-you` |
| Rejected / failed | `{"ok":false,"message":…}` shown in the form | self-contained HTML error page |
| Secrets unset | `503`, "not connected — please call" | same, as an HTML page |

The submitter's address goes in `Reply-To`, so the client replies straight from
their inbox. Two spam traps: a hidden `_gotcha` field, and a `_ts` stamp written
by JS on page load — a post under two seconds old is dropped. Both answer `200`
so a bot sees success and does not retry with the field cleared. Neither runs
when the field is absent, so no-JS submissions are unaffected.

### Secrets

Worker secrets, never in `wrangler.jsonc` — that file is committed.
`site/.dev.vars.example` documents all five; copy it to `site/.dev.vars` for
`wrangler dev`.

```bash
cd site
npx wrangler secret put MAILGUN_API_KEY     # required
npx wrangler secret put MAILGUN_DOMAIN      # required — mg.rexdalemobilewash.ca
npx wrangler secret put FORM_FROM           # optional, default postmaster@$MAILGUN_DOMAIN
npx wrangler secret put FORM_TO             # optional, default dispatch@rexdalemobilewash.ca
npx wrangler secret put MAILGUN_REGION      # optional, only if the account is EU
```

Until `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` are both set the route answers
`503` with a "please call" message and sends nothing. That is the intended
pre-provisioning state: a visible failure beats silently dropping an enquiry.

### Use a subdomain as the Mailgun sending domain

**Verify `mg.rexdalemobilewash.ca`, not `rexdalemobilewash.ca`.** The apex
carries the client's live Microsoft 365 mail — MX to Outlook, one SPF record,
Teams SRV and CNAME records. Mailgun asks for its own SPF `include:` and a DKIM
TXT record; adding those at the apex means editing the record the client's
business email depends on, and a second apex SPF record breaks SPF outright
(gate 0.3 refuses a build on exactly that). A subdomain gets its own SPF and
DKIM and touches nothing the client sends mail with.

DNS for `rexdalemobilewash.ca` is still on GoDaddy nameservers
(`ns41`/`ns42.domaincontrol.com`) — the Cloudflare zone is `pending` and holds
zero records, so **the Mailgun records must be added at GoDaddy**, not
Cloudflare. Only the `mg` subdomain records; do not touch the apex.

### Verifying it end to end

```bash
curl -si https://staging-lp-rexdalemobilewash.ash-47a.workers.dev/api/estimate \
  -H 'Accept: application/json' \
  -d 'name=Test&email=you@example.com&phone=4162446497&city=Etobicoke&message=test'
```

`{"ok":true,…}` plus mail in the `FORM_TO` inbox is a pass. `503` means the
secrets are not set; `502` means Mailgun rejected the call — check
`npx wrangler tail` for the status it returned, most often an unverified
sending domain.

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

## Three deliberate departures from the live site

**1. The hero slideshow is fixed, not copied.** `#18016ff0` is an Elementor Pro
background slideshow over the five banner images. Its `data-settings` gallery
lists them as `http://` URLs on an `https://` page, so the browser blocks them
as mixed content and the slideshow never initialises — the live hero renders
flat grey. Served here over `https://` with a CSS cross-fade. To reproduce the
grey instead, delete `.hero__slides`.

**2. Client logos are real `<img>` tags.** The original renders them as an
Elementor `e-gallery` — CSS background-images injected by JavaScript, invisible
to crawlers and screen readers. Now nine `<img>` elements with alt text.

**3. The forms post to the Worker, not to WordPress.** The original posts to
`admin-ajax` via Elementor Pro Forms, which does not exist in a static build.
Both forms now post to `/api/estimate`, handled by `worker/index.js`, which
mails the submission through Mailgun. Field names are preserved: name, email,
phone, city, message. See **Forms** below.

## Images

Still hotlinked to `lp.rexdalemobilewash.ca/wp-content/uploads/2025/03`. No
image store has been created and nothing has been copied. Worth knowing before
this is pointed anywhere: if Cloudflare hotlink protection is on for that zone,
these break cross-origin, including on a `*.up.railway.app` preview.

23 files, ~1.51 MB. `Bulk-Water-Delivery.webp` (139 KB) is genuinely unused. The
five `Rexdale-Mobile-Wash-Banner-*.webp` **are** used (hero slideshow) even
though they never appear in a network request on the live site.
`cropped-Rexdale-Mobile-Wash-Favicon.png` is 225 KB — the largest file on the
site, for a favicon. Worth regenerating.

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
- **No infrastructure.** No GitHub org, no repo, no Railway service, no DNS, no
  image store. Nothing outside this folder was touched and the live site is
  unmodified.
- **No day-2 procedure exists** anywhere in the toolchain for shipping a change
  to a live site. Flag at handover.
