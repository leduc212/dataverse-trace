import { defineConfig } from 'vite';

// Web resources are served from https://<org>/WebResources/dvt_/spike/<file> (optionally under a
// versioned /%7B<ver>%7D/ path), so everything must be:
//  - relative (base './'),
//  - flat, with stable names (no content hashes: the platform's version token already busts caches,
//    and stable names mean re-imports update the same web resources),
//  - free of inline scripts (modulePreload polyfill off),
//  - only web-resource file types (html/js/css/svg/png...), no source maps.
const output = {
  entryFileNames: '[name].js',
  chunkFileNames: '[name].js',
  assetFileNames: '[name][extname]',
};

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: '',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rolldownOptions: { output },
  },
  worker: {
    format: 'es',
    rolldownOptions: { output },
  },
});
