import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  { in: 'src/renderer/plugins/speed/stretch-worker.ts', out: path.join(outdir, 'stretch-worker.js'), platform: 'browser', external: [] },
];

// AssemblyScript → WASM for the time-stretch hot loop. Compiled with
// `--runtime stub`: the resulting module is a pure computational kernel
// operating on linear memory we manage from JS.
async function buildWasm() {
  await new Promise((resolve, reject) => {
    const args = [
      'asc',
      'src/renderer/plugins/speed/stretch.as.ts',
      '-o', path.join(outdir, 'stretch.wasm'),
      '--runtime', 'stub',
      '--optimizeLevel', '3',
      '--shrinkLevel', '0',
      '--converge',
    ];
    const proc = spawn('npx', args, { stdio: 'inherit', shell: true });
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`asc exit ${code}`)));
    proc.on('error', reject);
  });
}

// Resolve <!-- @include path --> directives in the HTML. Paths are always
// relative to the project src/ root so nested partials can reference each
// other without worrying about their own location.
const HTML_SRC_ROOT = path.resolve('src');

async function expandIncludes(html, seen = new Set()) {
  const re = /<!--\s*@include\s+([^\s]+)\s*-->/g;
  let out = '';
  let last = 0;
  for (const m of html.matchAll(re)) {
    out += html.slice(last, m.index);
    const rel = m[1];
    const abs = path.resolve(HTML_SRC_ROOT, rel);
    if (seen.has(abs)) throw new Error(`include cycle: ${rel}`);
    const child = await readFile(abs, 'utf8');
    out += await expandIncludes(child, new Set([...seen, abs]));
    last = m.index + m[0].length;
  }
  out += html.slice(last);
  return out;
}

async function copyStatic() {
  const html = await readFile('src/index.html', 'utf8');
  const expanded = await expandIncludes(html);
  await writeFile(path.join(outdir, 'index.html'), expanded);
}

if (watch) {
  await buildWasm();
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
  await Promise.all([
    buildWasm(),
    ...entries.map(e =>
      esbuild.build({
        ...common,
        entryPoints: [e.in],
        outfile: e.out,
        platform: e.platform,
        external: e.external,
      })
    ),
  ]);
  await copyStatic();
  console.log('built.');
}
