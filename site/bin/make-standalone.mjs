#!/usr/bin/env node
/**
 * make-standalone.mjs - regenerate site/standalone/ from site/dist/.
 *
 * The standalone pages are the same three pages with every local stylesheet
 * inlined and every root-relative link flattened to a sibling .html file, so
 * each one opens correctly straight off the filesystem. The Google Fonts
 * <link> is left alone; it has to stay a network request.
 *
 * Run after `npm run build`:
 *     node bin/make-standalone.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'standalone');

/** dist page -> standalone filename */
const PAGES = {
  'index.html': 'index.html',
  'privacy-policy/index.html': 'privacy-policy.html',
  'thank-you/index.html': 'thank-you.html',
};

/** root-relative route -> standalone filename */
const ROUTES = {
  '/': 'index.html',
  '/privacy-policy': 'privacy-policy.html',
  '/thank-you': 'thank-you.html',
};

mkdirSync(out, { recursive: true });

for (const [src, name] of Object.entries(PAGES)) {
  let html = readFileSync(join(dist, src), 'utf8');

  // Inline every local stylesheet, in the order the page links them.
  const css = [];
  html = html.replace(
    /<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)">/g,
    (_, href) => {
      css.push(readFileSync(join(dist, href.slice(1)), 'utf8').trim());
      return '';
    },
  );
  html = html.replace('</head>', `<style>${css.join('')}</style></head>`);

  // Flatten internal links. Longest route first so /privacy-policy is not
  // eaten by the match for /.
  for (const route of Object.keys(ROUTES).sort((a, b) => b.length - a.length)) {
    html = html.replaceAll(`href="${route}"`, `href="${ROUTES[route]}"`);
  }

  writeFileSync(join(out, name), html);
  console.log(`${name}  ${(html.length / 1024).toFixed(1)} KB`);
}
