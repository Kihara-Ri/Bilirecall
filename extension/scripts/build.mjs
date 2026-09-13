import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from './icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  target: 'chrome111',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

const entries = [
  { entryPoints: [path.join(root, 'src/background/index.ts')], outfile: path.join(dist, 'background.js'), format: 'esm', platform: 'browser' },
  { entryPoints: [path.join(root, 'src/content/index.ts')], outfile: path.join(dist, 'content.js'), format: 'iife', platform: 'browser' },
  { entryPoints: [path.join(root, 'src/content/inject.ts')], outfile: path.join(dist, 'inject.js'), format: 'iife', platform: 'browser' },
  { entryPoints: [path.join(root, 'src/popup/index.tsx')], outfile: path.join(dist, 'popup.js'), format: 'iife', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact' },
  { entryPoints: [path.join(root, 'src/options/index.tsx')], outfile: path.join(dist, 'options.js'), format: 'iife', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact' },
  { entryPoints: [path.join(root, 'src/viewer/index.tsx')], outfile: path.join(dist, 'viewer.js'), format: 'iife', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact' },
];

async function prepare() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await cp(path.join(root, 'public'), dist, { recursive: true });
  // styles.css lives in src/ and is linked by popup.html / options.html.
  await cp(path.join(root, 'src/styles.css'), path.join(dist, 'styles.css'));
  await generateIcons(path.join(dist, 'icons'));
  await generateIcons(path.join(root, 'public/icons'));
}

if (watch) {
  await prepare();
  for (const entry of entries) {
    const ctx = await context({ ...shared, ...entry });
    await ctx.watch();
  }
  console.log('watching…');
} else {
  await prepare();
  await Promise.all(entries.map((entry) => build({ ...shared, ...entry })));
  console.log('build complete →', dist);
}
