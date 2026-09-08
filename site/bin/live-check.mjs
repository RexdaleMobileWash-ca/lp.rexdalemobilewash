#!/usr/bin/env node
/**
 * live-check.mjs — gate 15, wp-19-check-nothing-is-broken.
 *
 * Checks the site that is SERVED, not the one in dist/. That distinction is the
 * whole point of the gate: a redirect rule, a transform rule, an edge cache or a
 * Worker route can put a different response in front of a visitor than the build
 * produced, and three things only become true once the domain is live —
 *
 *   - the image host answers through Cloudflare (cf-cache-status present), which
 *     is what keeps Backblaze egress free and cannot be proved from a build;
 *   - canonicals point at the real domain rather than a preview hostname;
 *   - the addresses that existed before the migration still resolve.
 *
 * Three blocks, any of which fails the run:
 *   1. URL SWEEP        every address in live-urls.txt, against its expectation
 *   2. LIVE IMAGE CHECK  served HTML only references the bucket; route is sane
 *   3. LIVE SEO CHECK    canonicals, JSON-LD that PARSES, sitemap
 *
 *     node bin/live-check.mjs [https://lp.rexdalemobilewash.ca]
 *
 * Exit code 1 blocks gate 20.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || 'https://lp.rexdalemobilewash.ca').replace(/\/$/, '');
const HOST = new URL(BASE).host;
const IMG_HOST = 'img-lp.rexdalemobilewash.ca';
const PAGES = ['/', '/privacy-policy/', '/thank-you/', '/pressure-washing/'];

const pad = (s, n) => String(s).padEnd(n);
const failures = [];
const notes = [];

/** One request, no redirect following — the FIRST response is what matters. */
async function head(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), headers: res.headers };
}

/** Follow a chain by hand so every hop is visible, not just the destination. */
async function follow(url, max = 5) {
  const chain = [];
  let current = url;
  for (let i = 0; i <= max; i++) {
    const r = await head(current);
    chain.push({ url: current, status: r.status });
    if (![301, 302, 303, 307, 308].includes(r.status) || !r.location) return { chain, final: r.status };
    current = new URL(r.location, current).toString();
  }
  return { chain, final: null };
}

// ---------------------------------------------------------------- 1. sweep
console.log(`\nURL SWEEP  —  ${BASE}\n`);

const entries = readFileSync(join(here, 'live-urls.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [expect, path] = l.split('\t');
    return { expect: Number(expect), path };
  });

const rows = [];
const tally = { ok200: 0, ok301: 0, ok404: 0 };

for (const { expect, path } of entries) {
  const { chain, final } = await follow(BASE + path);
  const first = chain[0].status;
  const dest = chain.length > 1 ? chain[chain.length - 1].url : '';
  let verdict;

  if ([302, 307, 308].includes(first)) {
    // Lands on a working page and still fails: a temporary redirect holds the
    // ranking on the dead address instead of passing it on.
    verdict = 'TEMP-REDIRECT';
  } else if (expect === 200) {
    verdict = first === 200 ? 'OK' : 'FAIL';
  } else if (expect === 301) {
    verdict = first !== 301 ? 'FAIL' : final === 200 ? 'OK' : 'REDIRECT-BROKEN';
  } else if (expect === 404) {
    // Deliberately gone (gate 14). Anything else means a decision silently
    // changed — including a redirect somebody added without updating this list.
    verdict = first === 404 ? 'OK-GONE' : 'UNEXPECTED-LIVE';
  }

  if (verdict === 'OK') expect === 200 ? tally.ok200++ : tally.ok301++;
  if (verdict === 'OK-GONE') tally.ok404++;
  if (!['OK', 'OK-GONE'].includes(verdict)) failures.push({ path, first, final, verdict });
  rows.push([path, expect, first, final ?? '', dest, verdict].join('\t'));
}

writeFileSync(join(here, 'live-sweep.tsv'), 'path\texpect\tfirst\tfinal\tdestination\tverdict\n' + rows.join('\n') + '\n');

console.log(`  addresses in the list ..... ${entries.length}`);
console.log(`  200 direct ................ ${tally.ok200}`);
console.log(`  301 -> 200 ................ ${tally.ok301}`);
console.log(`  404 by decision ........... ${tally.ok404}`);
console.log(`  FAILED .................... ${failures.length}`);

if (failures.length) {
  console.log('\nFAILURES, BY ADDRESS:');
  for (const f of failures) {
    console.log(`  ${pad(f.path, 62)} ${f.first}  -> ${pad(f.final ?? '-', 5)} ${f.verdict}`);
  }
}

// ---------------------------------------------------- 2. live image check
console.log('\nLIVE IMAGE CHECK\n');

let refs = 0;
let onBucket = 0;
const offHost = [];
let oldDomainMentions = 0;

for (const path of PAGES) {
  const html = await fetch(BASE + path).then((r) => r.text());
  // The `//` is load-bearing and this check was wrong without it: the bucket
  // hostname `img-lp.rexdalemobilewash.ca` ENDS WITH `lp.rexdalemobilewash.ca`,
  // so a bare substring match flags every correctly-migrated page. Anchoring to
  // the scheme separator is what distinguishes the host from a suffix of it —
  // the same convention bin/check-images.mjs uses.
  if (/\/\/lp\.rexdalemobilewash\.ca\/wp-content\/uploads/.test(html)) oldDomainMentions++;

  const found = [
    ...html.matchAll(/<img[^>]+src="([^"]+)"/g),
    ...html.matchAll(/<source[^>]+srcset="([^"]+)"/g),
    ...html.matchAll(/(?:og:image|twitter:image)"[^>]*content="([^"]+)"/g),
    ...html.matchAll(/rel="icon"[^>]*href="([^"]+)"/g),
    ...html.matchAll(/url\((["']?)(https?:\/\/[^)"']+\.(?:webp|png|jpe?g|svg|gif))\1\)/g),
    ...html.matchAll(/rel="preload"[^>]*as="image"[^>]*href="([^"]+)"/g),
  ].map((m) => (m[2] && m[2].startsWith('http') ? m[2] : m[1]));

  for (const raw of found) {
    for (const candidate of raw.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean)) {
      if (candidate.startsWith('data:')) continue;
      refs++;
      if (candidate.includes(IMG_HOST)) onBucket++;
      else offHost.push(`${path}  ${candidate.slice(0, 80)}`);
    }
  }
}

const sample = `https://${IMG_HOST}/wp-content/uploads/2025/03/Graffiti-Removal.webp`;
const sampleRes = await fetch(sample);
const cacheStatus = sampleRes.headers.get('cf-cache-status');
// The gate 7 transform rule prefixes /file/<bucket>; a path that tries to reach
// another bucket gets prefixed too and must therefore miss.
const outOfBucket = (await head(`https://${IMG_HOST}/file/rexdalemobilewash-img/x.webp`)).status;

console.log(`  pages fetched ...................... ${PAGES.length}`);
console.log(`  image references ................... ${refs}`);
console.log(`    on ${IMG_HOST} ... ${onBucket}${onBucket === refs ? '      MATCH' : ''}`);
console.log(`    off-host ......................... ${offHost.length}`);
console.log(`  pages mentioning the old image host  ${oldDomainMentions}`);
console.log(`  ${IMG_HOST} sample fetch .......... ${sampleRes.status}`);
console.log(`    cf-cache-status .................. ${cacheStatus ?? 'ABSENT'}${cacheStatus ? '' : '   <- NOT through Cloudflare'}`);
console.log(`    out-of-bucket path ............... ${outOfBucket}`);

if (offHost.length) { failures.push({ path: 'image-host', verdict: 'OFF-HOST' }); offHost.forEach((o) => console.log(`      ${o}`)); }
if (oldDomainMentions) failures.push({ path: 'old-image-host', verdict: 'OLD-HOST-REFERENCED' });
if (sampleRes.status !== 200) failures.push({ path: sample, verdict: 'IMAGE-SAMPLE-FAILED' });
if (!cacheStatus) failures.push({ path: IMG_HOST, verdict: 'NOT-PROXIED' });
if (outOfBucket === 200) failures.push({ path: 'out-of-bucket', verdict: 'TRANSFORM-RULE-LEAKS' });

// ------------------------------------------------------ 3. live seo check
console.log('\nLIVE SEO CHECK\n');

let canonicalOnDomain = 0;
let slashMatches = 0;
let ldBlocks = 0;
let ldParsed = 0;
const pagesWithoutLd = [];

for (const path of PAGES) {
  const html = await fetch(BASE + path).then((r) => r.text());

  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
  if (canonical && new URL(canonical).host === HOST) canonicalOnDomain++;
  // A canonical that disagrees with the served path on the trailing slash makes
  // the page compete with itself.
  if (canonical && new URL(canonical).pathname === path) slashMatches++;

  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) pagesWithoutLd.push(path);
  for (const b of blocks) {
    ldBlocks++;
    // Presence is not the test. A block that exists and does not parse is
    // discarded whole by Google, and nothing on the page says so.
    try { JSON.parse(b); ldParsed++; } catch (e) {
      failures.push({ path, verdict: 'JSON-LD-PARSE-FAILED' });
      console.log(`  JSON-LD PARSE FAILED on ${path}: ${e.message}`);
    }
  }
}

const sitemap = await head(`${BASE}/sitemap.xml`);
const robots = await head(`${BASE}/robots.txt`);

console.log(`  canonical on the real domain ....... ${canonicalOnDomain} of ${PAGES.length}`);
console.log(`  canonical trailing slash matches ... ${slashMatches} of ${PAGES.length}`);
console.log(`  JSON-LD blocks ..................... ${ldBlocks}`);
console.log(`    parse ............................ ${ldParsed}${ldBlocks === ldParsed ? '      all parse' : '   *** HARD FAIL ***'}`);
console.log(`    pages carrying none .............. ${pagesWithoutLd.length}${pagesWithoutLd.length ? '   ' + pagesWithoutLd.join(' ') : ''}`);
console.log(`  robots.txt ......................... ${robots.status}`);
console.log(`  sitemap.xml ........................ ${sitemap.status}`);

if (canonicalOnDomain !== PAGES.length) failures.push({ path: 'canonical', verdict: 'CANONICAL-OFF-DOMAIN' });
if (slashMatches !== PAGES.length) failures.push({ path: 'canonical', verdict: 'CANONICAL-SLASH-MISMATCH' });

// Advisory, not blocking: no sitemap existed before the migration either, so it
// is a gap to close rather than something the cutover broke.
if (sitemap.status !== 200) notes.push('No sitemap.xml. The old WordPress install had none either, so this is a pre-existing gap, not a regression — but it is worth closing.');
if (pagesWithoutLd.length) notes.push(`No JSON-LD on ${pagesWithoutLd.join(', ')}. The old / and /thank-you/ each carried an Organization + WebSite + WebPage graph, so this IS a regression the migration introduced.`);

// ------------------------------------------------------------------ verdict
if (notes.length) {
  console.log('\nADVISORY — does not block, does need a decision:');
  for (const n of notes) console.log(`  - ${n}`);
}

console.log(`\n  report: site/bin/live-sweep.tsv`);
if (failures.length) {
  console.log(`\nSWEEP FAILED — ${failures.length} problem(s). Gate 20 is BLOCKED.\n`);
  process.exit(1);
}
console.log('\nLIVE CHECK PASSED.\n');
