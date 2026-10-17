// Downloads everything listed in bundle.json into bundle/, so the installer carries the built-in
// answer model, its server, the speech model and voices, and a new user downloads nothing.
//
//   node scripts/fetch-bundle.mjs          what ships by default (fits one setup .exe)
//   node scripts/fetch-bundle.mjs --all    also the extras (needs a bigger budget; see bundle.json)
//   node scripts/fetch-bundle.mjs --pin    record the SHA-256 of entries that have none yet
//
// Downloads are cached in .bundle-cache/ and every file is checked against its SHA-256, so a
// re-run is quick and a corrupted or swapped file stops the build.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The manifest entries to fetch for this platform. */
export function selectFiles(manifest, { platform, all = false }) {
  return manifest.files.filter((f) => (all || !f.extra) && (!f.platforms || f.platforms.includes(platform)));
}

/** Does a file name match one of the keep patterns ("*.dll", "llama-server.exe")? */
export function matchesKeep(name, patterns) {
  return patterns.some((p) =>
    new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(name),
  );
}

/** Null when the files fit the budget, else the total and the biggest files to blame. */
export function overBudget(files, budget) {
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total <= budget) return null;
  const largest = [...files]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((f) => f.path);
  return { total, budget, largest };
}

/** Every regular file under dir with its size, paths relative to dir. */
export function listSizes(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) return listSizes(join(dir, e.name), rel);
    return e.isFile() ? [{ path: rel, bytes: statSync(join(dir, e.name)).size }] : [];
  });
}

const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, to) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const part = `${to}.part`;
  const out = createWriteStream(part);
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    got += chunk.byteLength;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (total && got - shown > total / 20) {
      shown = got;
      process.stdout.write(`  ${Math.round((got / total) * 100)}%`);
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  if (total) process.stdout.write('\n');
  renameSync(part, to);
}

function unpack(entry, archive, dest) {
  mkdirSync(dest, { recursive: true });
  if (entry.unpack === 'tar.bz2') {
    execFileSync('tar', ['-xjf', archive, '-C', dest], { stdio: 'inherit' });
    return;
  }
  // zip: unpack to a scratch folder, then keep only the files the app runs (flattened).
  const scratch = mkdtempSync(join(tmpdir(), 'clicky-bundle-'));
  try {
    if (process.platform === 'win32') execFileSync('tar', ['-xf', archive, '-C', scratch], { stdio: 'inherit' });
    else execFileSync('unzip', ['-q', '-o', archive, '-d', scratch], { stdio: 'inherit' });
    const kept = listSizes(scratch).filter((f) => matchesKeep(basename(f.path), entry.keep ?? ['*']));
    if (!kept.length) throw new Error(`${entry.id}: nothing in the archive matched ${JSON.stringify(entry.keep)}`);
    for (const f of kept) copyFileSync(join(scratch, f.path), join(dest, basename(f.path)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The llama.cpp server needs the Microsoft C++ runtime. Ship it next to the server (app-local, as
 * Microsoft allows) so PCs without the Visual C++ Redistributable still run it.
 */
function copyVcRuntime(dest) {
  const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  for (const dll of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    if (existsSync(join(dest, dll))) continue;
    if (existsSync(join(sys, dll))) copyFileSync(join(sys, dll), join(dest, dll));
    else console.warn(`  ${dll} not found on this PC; install the Visual C++ Redistributable before building`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = join(root, 'bundle.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const platform = [...args].find((a) => a.startsWith('--platform='))?.split('=')[1] ?? process.platform;
  const pin = args.has('--pin');
  const out = join(root, 'bundle');
  const cache = join(root, '.bundle-cache');
  mkdirSync(cache, { recursive: true });
  let pinned = false;

  const files = selectFiles(manifest, { platform, all: args.has('--all') });
  for (const entry of files) {
    const dest = join(out, entry.to);
    const stamp = join(out, `.${entry.id}.ok`);
    if (entry.sha256 && existsSync(stamp) && readFileSync(stamp, 'utf8') === entry.sha256) {
      console.log(`✓ ${entry.id} (already in bundle/)`);
      continue;
    }
    const cached = join(cache, basename(new URL(entry.url).pathname));
    if (!existsSync(cached)) {
      console.log(`↓ ${entry.id}: ${entry.url}`);
      await download(entry.url, cached);
    }
    const digest = await sha256Of(cached);
    if (!entry.sha256) {
      if (!pin) throw new Error(`${entry.id} has no sha256 in bundle.json. Check the file, then re-run with --pin.`);
      entry.sha256 = digest;
      pinned = true;
      console.log(`  pinned ${entry.id} = ${digest}`);
    } else if (digest !== entry.sha256) {
      rmSync(cached, { force: true });
      throw new Error(`${entry.id}: checksum mismatch (got ${digest}). The download was deleted; run again.`);
    }
    if (entry.unpack) unpack(entry, cached, dest);
    else {
      mkdirSync(dest, { recursive: true });
      copyFileSync(cached, join(dest, basename(cached)));
    }
    if (entry.id === 'llama-server' && platform === 'win32' && process.platform === 'win32') copyVcRuntime(dest);
    writeFileSync(stamp, entry.sha256);
    console.log(`✓ ${entry.id}`);
  }
  if (pinned) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const sizes = listSizes(out).filter((f) => !basename(f.path).startsWith('.'));
  const over = overBudget(sizes, manifest.budgetBytes);
  if (over) {
    throw new Error(
      `bundle/ is ${gb(over.total)}, over the ${gb(over.budget)} that fits in one setup .exe. Largest: ${over.largest.join(', ')}.`,
    );
  }
  console.log(`bundle/ ready: ${gb(sizes.reduce((n, f) => n + f.bytes, 0))} of ${gb(manifest.budgetBytes)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`fetch-bundle: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
