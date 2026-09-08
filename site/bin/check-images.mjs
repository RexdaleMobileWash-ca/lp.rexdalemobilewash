#!/usr/bin/env node
// AD-9 enforcement. Exits 1 on any image served from a host that is not img-lp.rexdalemobilewash.ca.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg  = JSON.parse(readFileSync(join(root, 'image-hosts.json'), 'utf8'));
const allow = new Set([cfg.canonical, ...(cfg.allow || [])]);
const dist = join(root, 'dist');

const IMG_EXT = /\.(avif|webp|png|jpe?g|gif|svg|ico|bmp|tiff?)(?:[?#]|$)/i;
const SCAN    = /\.(html|css|js|mjs|json|webmanifest|xml|txt)$/i;

const PATTERNS = [
  [/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)/gi,                              'img src'],
  [/\ssrcset\s*=\s*["']([^"']+)["']/gi,                                   'srcset'],
  [/<source\b[^>]*?\ssrc\s*=\s*["']([^"']+)/gi,                           'source'],
  [/<link\b[^>]*?as=["']image["'][^>]*?href\s*=\s*["']([^"']+)/gi,        'preload'],
  [/(?:og:image|twitter:image)["'][^>]*?content\s*=\s*["']([^"']+)/gi,    'social'],
  [/rel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["'][^>]*?href\s*=\s*["']([^"']+)/gi, 'icon'],
  [/url\(\s*["']?([^"')]+?)["']?\s*\)/gi,                                 'css url()'],
  [/"(?:image|logo|thumbnailUrl|contentUrl)"\s*:\s*"([^"]+)"/gi,          'json-ld'],
  [/"src"\s*:\s*"([^"]+)"/gi,                                             'manifest'],
];

const walk = d => readdirSync(d).flatMap(n => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : (SCAN.test(n) ? [p] : []);
});

const fails = [], warns = [], allowed = [], oldRefs = [];
let scanned = 0, total = 0;

for (const file of walk(dist)) {
  const text = readFileSync(file, 'utf8');
  scanned++;
  const rel = file.slice(dist.length + 1);

  if (cfg.oldHost && text.includes(cfg.oldHost))
    oldRefs.push(rel);

  for (const [re, kind] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      for (const raw of m[1].split(',')) {
        const url = raw.trim().split(/\s+/)[0];
        if (!url || /^(data:|blob:|mailto:|tel:|#)/i.test(url)) continue;

        const abs = /^https?:\/\//i.test(url) || url.startsWith('//');
        if (abs) {
          const host = url.replace(/^(https?:)?\/\//i, '').split('/')[0].toLowerCase();
          if (!IMG_EXT.test(url) && kind === 'css url()') continue;   // fonts, not images
          total++;
          if (!allow.has(host)) fails.push([rel, kind, host, url]);
          else if (host !== cfg.canonical) allowed.push([rel, kind, host, url]);
        } else if (IMG_EXT.test(url) && !url.startsWith('/_astro/')) {
          total++;
          warns.push([rel, kind, url]);                               // local, not in the bucket
        }
      }
    }
  }
}

const p = (l, n) => console.log(`  ${(l + ' ').padEnd(36, '.')} ${n}`);
console.log(`\nAD-9 IMAGE CHECK — canonical host ${cfg.canonical}\n`);
p('files scanned', scanned);
p('image references', total);
p(`on ${cfg.canonical}`, total - fails.length - warns.length - allowed.length);
p('on an allowed third party', allowed.length);
p('off-host', fails.length);
p('local, not in the bucket', warns.length);
p(`files mentioning ${cfg.oldHost}`, oldRefs.length);

if (allowed.length) {
  console.log('\nALLOWLISTED THIRD PARTIES — each one is a decision, not a convenience:');
  for (const [f, k, h, u] of allowed) console.log(`  ${f}  ${k}  [${h}]  ${u}`);
}
if (warns.length) {
  console.log('\nLOCAL IMAGES — not a failure, but not in the bucket either:');
  for (const [f, k, u] of warns.slice(0, 20)) console.log(`  ${f}  ${k}  ${u}`);
}
if (fails.length) {
  console.log('\nOFF-HOST IMAGES, BY FILE:');
  for (const [f, k, h, u] of fails) console.log(`  ${f}\n    ${k}  [${h}]  ${u}`);
  console.log(`\nAD-9 CHECK FAILED — ${fails.length} image(s) not on ${cfg.canonical}.`);
  process.exit(1);
}
console.log('\nAD-9 CHECK PASSED.\n');
