import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

if (existsSync(outdir)) await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: 'es2022',
  format: 'cjs',
};

const entries = [
  { in: 'src/main/index.ts',    out: path.join(outdir, 'main.js'),     platform: 'node',    external: ['electron'] },
  { in: 'src/preload/index.ts', out: path.join(outdir, 'preload.js'), platform: 'node',    external: ['electron'] },
  { in: 'src/renderer/index.ts', out: path.join(outdir, 'renderer.js'), platform: 'browser', external: [] },
];

async function copyStatic() {
  await copyFile('src/index.html', path.join(outdir, 'index.html'));
}

if (watch) {
  await copyStatic();
  const ctxs = await Promise.all(entries.map(e =>
    esbuild.context({
      ...common,
      entryPoints: [e.in],
      outfile: e.out,
      platform: e.platform,
      external: e.external,
    })
  ));
  await Promise.all(ctxs.map(c => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(entries.map(e =>
    esbuild.build({
      ...common,
      entryPoints: [e.in],
      outfile: e.out,
      platform: e.platform,
      external: e.external,
    })
  ));
  await copyStatic();
  console.log('built.');
}
