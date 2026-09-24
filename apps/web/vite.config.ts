import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The same build runs as Dataverse web resources (served from /WebResources/dvt_/app/…, possibly
// under a versioned /%7B…%7D/ path) and on a static host for the demo. So the output must be:
//  - relative (base './') and flat,
//  - stable file names without hashes (re-imports update the same web resources; the platform's
//    version token busts caches), made only of letters, digits and "_" (web-resource name rules),
//  - free of inline scripts, and only web-resource file types (no source maps, no fonts).
//
// On a plain static host (GitHub Pages: DVT_TARGET=pages) there's no version token, so stable
// names would serve stale scripts after a deploy. That build adds a content hash instead.
const hashed = process.env['DVT_TARGET'] === 'pages';
const safeName = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');
const suffix = hashed ? '_[hash]' : '';
const output = {
  hashCharacters: 'hex' as const,
  entryFileNames: (chunk: { name: string }) => `${safeName(chunk.name)}${suffix}.js`,
  chunkFileNames: (chunk: { name: string }) => `${safeName(chunk.name)}${suffix}.js`,
  assetFileNames: (asset: { names?: string[] }) => {
    const name = asset.names?.[0] ?? 'asset';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${safeName(name.slice(0, dot))}${suffix}${name.slice(dot)}` : safeName(name);
  },
};

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: '',
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { output },
  },
  worker: {
    format: 'es',
    rolldownOptions: { output },
  },
});
