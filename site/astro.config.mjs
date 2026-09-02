import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://lp.rexdalemobilewash.ca',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
