# rexdalemobilewash-lp

Astro replica of `lp.rexdalemobilewash.ca`, built the same way as
briansmasonry: the live Elementor stylesheets ported declaration-by-declaration
into scoped Astro `<style>` blocks, with each Elementor element id kept in a
comment beside the block it came from.

## Status

**Builds clean.** 3 pages, zero errors, zero warnings. `site/dist/` is build
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
  dist/         astro build output, directory format (gitignored)
  standalone/   flat single-file HTML, CSS inlined, opens from file://
  bin/make-standalone.mjs   regenerates standalone/ from dist/
bin/where.py    gate-record reader from the earlier scaffolding attempt
```

No `src/data`, no `src/styles`, no Tailwind — globals live in `Base.astro`,
content lives inline in the components. Astro `^7.0.0`, `output: 'static'`.

## Staging

Deployed as a Cloudflare Worker (static assets) named
`staging-lp-rexdalemobilewash`:

```bash
cd site
npm run build
npx wrangler deploy          # needs CLOUDFLARE_API_TOKEN
```

Live at **https://staging-lp-rexdalemobilewash.ash-47a.workers.dev**.

`staging.lp.rexdalemobilewash.ca` is attached to the Worker but does **not**
resolve: `rexdalemobilewash.ca` still uses GoDaddy nameservers and the
Cloudflare zone is `pending`, so Cloudflare is not authoritative and creates no
record. The hostname begins working by itself once the nameservers move — but
the Cloudflare zone currently holds **zero DNS records**, so cutting over before
the zone is populated would take down the client's website and email. That is
gate 6 of the migration (`wp-10-confirm-dns-is-ours`), and it is not done.

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

**3. The forms do not submit.** The original posts to WordPress `admin-ajax`
via Elementor Pro Forms, which does not exist in a static build. `ENDPOINT` in
`EstimateForm.astro` is empty on purpose — submitting shows a visible "not
connected, please call" notice rather than silently dropping a real enquiry.
Field names are preserved: name, email, phone, city, message. **Wire this before
go-live.**

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
