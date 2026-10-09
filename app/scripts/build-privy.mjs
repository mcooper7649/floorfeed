// Builds the Privy sign-in bundle into public/privy/, which Expo serves in dev
// and copies into dist/ on export. Prints the entry file name; pass it to the
// app as EXPO_PUBLIC_PRIVY_ENTRY (see the build:web script).
import { build } from 'esbuild';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';

const outdir = 'public/privy';
rmSync(outdir, { recursive: true, force: true });
const result = await build({
  entryPoints: ['privy/entry.tsx'],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  jsx: 'automatic',
  entryNames: '[name]-[hash]',
  chunkNames: 'c-[hash]',
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  metafile: true,
  logLevel: 'warning',
});
const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint === 'privy/entry.tsx')[0].split('/').pop();
writeFileSync(`${outdir}/ENTRY`, entry);
const files = readdirSync(outdir);
console.error(`privy bundle: ${entry} (+${files.length - 2} chunks)`);
console.log(entry);
