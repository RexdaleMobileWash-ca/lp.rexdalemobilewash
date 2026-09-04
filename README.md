# rexdalemobilewash-lp

Astro replica of `lp.rexdalemobilewash.ca`, built the same way as
briansmasonry: the live Elementor stylesheets ported declaration-by-declaration
into scoped Astro `<style>` blocks, with each Elementor element id kept in a
comment beside the block it came from.

## Status

**Builds clean.** 4 pages, zero errors, zero warnings. `site/dist/` is build
output and is not committed — `.gitignore` excludes it. There is no CI: pushing
to `main` deploys nothing, and the Worker keeps serving its last uploaded bundle
until someone runs `npx wrangler deploy` by hand (see **Staging** below).

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

### The quote forms

Both quote forms on this page (the hero one and the closing CTA) post to
**`POST /api/contact`** — the same Worker route the estimate forms use, sent
through Resend. See [The contact form](#the-contact-form) below.

They were previously wired to Web3Forms with an empty access key, which meant
they were not connected at all: a submission was refused in the browser and the
visitor told to call. Web3Forms is gone from the page — no access key, no
`subject` hidden field, no `botcheck`.

Two things to know if you edit these forms:

- **`company` is a real, required field here** (the enquirer's company name),
  which is why the Worker's honeypot is `fax` and not `company`. Naming a real
  field after the honeypot makes every submission look like a bot, and the
  Worker answers bots `202` — so the form would look like it worked while every
  lead was discarded. Check any new field name against `HONEYPOT_FIELD` in
  `site/worker/contact.js`.
- Each form posts a hidden **`source`** (`pressure-washing-hero` /
  `pressure-washing-final`) so the notification email says which form produced
  the lead. The Worker maps it through an allowlist, so a new form needs an
  entry in `SOURCES` or it shows as the generic "Website form".

The page uses the same GTM container as the rest of the build
(`GTM-NMTLRJ63`), and pushes `generate_lead` to the dataLayer only after the
Worker confirms the notification was accepted — not on click, which would count
abandoned and failed submissions as conversions.

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

A custom domain was tried and removed at a time when `rexdalemobilewash.ca` was
still on GoDaddy nameservers and the Cloudflare zone was `pending` with zero
records. **That is no longer the situation.** As of 2026-09-04 the domain
resolves from `dee`/`josh.ns.cloudflare.com`, the zone is `active` and `full`,
and it carries 28 records including the client's Microsoft 365 mail (Outlook
`MX`, apex `SPF`, the tenant `TXT`, and the Teams/Skype `SRV` and `CNAME`
records). So a custom hostname is now technically possible; whether to attach
one is a migration decision, not a blocked one.

Verify before relying on any of this — it is the kind of fact that changes
underneath a README:

```bash
curl -s -H 'accept: application/dns-json' \
  'https://cloudflare-dns.com/dns-query?name=rexdalemobilewash.ca&type=NS'
```

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

**All four forms** post to **`POST /api/contact`**, handled at request time by
`site/worker/contact.js` and sent through Resend:

| Form | `source` value |
|---|---|
| `/` hero estimate form | `hero` |
| `/` closing CTA estimate form | `cta` |
| `/pressure-washing/` hero quote form | `pressure-washing-hero` |
| `/pressure-washing/` closing quote form | `pressure-washing-final` |

The two pages do not collect the same fields — the commercial page asks for
company and property type and never asks for a city — so everything except
name, email and phone is optional at the Worker. A partly filled lead is still
a lead.

The route lives in the Worker, not in `src/pages`. The build is
`output: 'static'`, so a route under `src/pages` would be prerendered to a file
and would accept nothing. Keeping it in the Worker also preserves the noindex
wrapper in `worker/index.js`, which the `@astrojs/cloudflare` adapter would
have replaced.

### Addressing — do not "improve" this casually

| | |
|---|---|
| From | `forms@rexdalemobilewash.ca` — the client's **own** domain |
| To | `dispatch@rexdalemobilewash.ca` |
| Cc | `Paolo@tboxstudio.com` |
| Reply-To | `dispatch@rexdalemobilewash.ca` |

This used to send as `forms@brandingcentres.com`, a shared domain, specifically
so that nothing here could reach the client's Microsoft 365 mail reputation. It
now sends as the client's own domain, verified in Resend through records chosen
to stay clear of their live mail:

| Record | Name | Value |
|---|---|---|
| TXT | `resend._domainkey` | the Resend DKIM public key |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` |
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` (priority 10) |

Their apex `SPF` (`v=spf1 include:secureserver.net -all`) and their Outlook `MX`
are **not modified and not consulted**: SPF authenticates the envelope sender,
which is `send.rexdalemobilewash.ca`, not the `From` header a person reads. DKIM
uses a new selector, so their Microsoft 365 selectors are untouched. One genuine
gain: `From` and the DKIM `d=` now align, so this mail would pass DMARC if a
policy is ever published.

**What this does not buy is isolation.** Form mail and the client's business
mail now share one domain reputation. Anything this endpoint sends in volume is
felt by their Microsoft 365 mail — which raises the stakes on the confirmation
email below.

The visitor's address never goes in `From` either — to a receiving mail server
that is forgery and it lands every notification in spam. It goes in the body as
a `mailto:` link.

The visitor also gets a confirmation email (`CONTACT_CONFIRM`), sent *after* the
notification has already succeeded and best-effort: a bounced confirmation must
never cost the client a real lead.

**Known risk, accepted deliberately.** That confirmation is the one message here
addressed to an unvetted person, at an address they chose, quoting text they
wrote — which is the shape of a relay: someone can use the form to send their
own words to a third party over a domain we have verified. Since `From` moved to
`rexdalemobilewash.ca`, the reputation that would spend is the client's business
domain. The honeypot and the 8/min per-IP limit blunt it; neither closes it. The
close, if it is ever wanted, is to drop `v.message` from `summary` in
`confirmationEmail()` so the acknowledgement only repeats fields the client
already holds — at the cost of the "what you sent us" quote-back.

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

- **Honeypot** — a hidden `fax` field. Anything that arrives filled in is a
  bot, and gets a `202` rather than an error, because telling a bot it failed
  only makes it retry. This stops more real-world form spam than the rate limit.
  It is `fax` and **not** `company` because `company` is a real required field
  on the `/pressure-washing/` quote forms; `fax` is filled by blind form-filling
  bots and is not an autofill token any browser recognises, so it cannot be
  populated on a real visitor's behalf. Check new field names against it.
- **Rate limit** — 8/min per IP via the Workers rate limiting binding. Know what
  this is: it is counted **per data centre** and is documented as "permissive,
  eventually consistent, and intentionally designed to not be used as an
  accurate accounting system". A caller spread across colos gets a multiple of
  the limit. It is a brake on the naive case, not a guarantee.
- **Not yet present:** a WAF rate limiting rule and Turnstile. Both need a
  Cloudflare **zone** to attach to, and this is served from `workers.dev`. Add
  them when the Worker gets a custom domain.

### Client mail, re-proven after this change

Moving `From` onto the client's domain meant writing to the zone their business
email lives in, so this was checked before and after. Every record below is
byte-identical to what was there beforehand — the three Resend records are
additions on new names, and nothing existing was modified or removed:

```
NS    dee.ns.cloudflare.com / josh.ns.cloudflare.com   (was GoDaddy; zone active)
MX    rexdalemobilewash-ca.mail.protection.outlook.com   priority 0   UNCHANGED
TXT   v=spf1 include:secureserver.net -all                            UNCHANGED
TXT   NETORG7588905.onmicrosoft.com                                   UNCHANGED
SRV   _sip._tls / _sipfederationtls._tcp  (Teams/Skype)               UNCHANGED
```

Added, all on names that did not previously exist:

```
TXT   resend._domainkey    <Resend DKIM public key>
TXT   send                 v=spf1 include:amazonses.com ~all
MX    send                 feedback-smtp.us-east-1.amazonses.com   priority 10
```

Re-prove it yourself after any change here:

```bash
for t in MX TXT; do
  curl -s -H 'accept: application/dns-json' \
    "https://cloudflare-dns.com/dns-query?name=rexdalemobilewash.ca&type=$t" \
    | python3 -c 'import sys,json;[print(a["data"]) for a in json.load(sys.stdin).get("Answer",[])]'
done
```

**Pre-existing, not caused by this work:** that apex SPF record authorises
GoDaddy (`secureserver.net`) with a hard fail `-all`, but the domain's mail is on
Microsoft 365, which is *not* included. Mail sent from their tenant can fail SPF
at strict receivers. There is also no `_dmarc` record. Neither is touched by this
endpoint — form mail is authenticated on the `send.` subdomain — but both are
worth raising with whoever owns the client's mail.

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
contact form** above. The Elementor field names are unchanged: name, email,
phone, city, message. The Worker also accepts company and property_type, which
only the `/pressure-washing/` forms send, plus a hidden `source` and the `fax`
honeypot.)*

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
