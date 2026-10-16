// Compiles Clicky's instruction pack from a machine where the test suite passed: agents.md, the
// skills (with what they learned) and the learned shortest routes, into resources/instructions,
// which ships with every install (src/main/instruction-pack.ts applies it).
//
// Everything is scrubbed first (scripts/scrub.mjs): folders, emails, phones, account names, keys.
// A line or route that still names the owner (--names, plus this PC's user name) is left out.
//
//   node scripts/export-instructions.mjs [--from <userData>] [--version 2026.10.12] [--names "Ana,Rossi"]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, stillPersonal } from './scrub.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const from = arg('--from') ?? path.join(process.env.APPDATA ?? '', 'Clicky');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'instructions');
const version = arg('--version') ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const names = [...(arg('--names') ?? '').split(','), os.userInfo().username].map((n) => n.trim()).filter(Boolean);
let dropped = 0;
/** Scrubbed text, without the lines that still name the owner. */
const clean = (text) =>
  scrub(text)
    .split('\n')
    .filter((line) => {
      const personal = stillPersonal(line, names);
      if (personal) dropped++;
      return !personal;
    })
    .join('\n');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'skills'), { recursive: true });

// agents.md, scrubbed (it describes the owner's PC).
const agents = path.join(from, 'agents.md');
if (fs.existsSync(agents)) fs.writeFileSync(path.join(out, 'agents.md'), clean(fs.readFileSync(agents, 'utf8')));

// Skills, scrubbed.
let skills = 0;
for (const f of fs.existsSync(path.join(from, 'skills')) ? fs.readdirSync(path.join(from, 'skills')) : []) {
  if (!f.endsWith('.md')) continue;
  fs.writeFileSync(path.join(out, 'skills', f), clean(fs.readFileSync(path.join(from, 'skills', f), 'utf8')));
  skills++;
}

// Learned routes (shortest ways that worked), without the user's own names and paths.
const lessonsFile = path.join(from, 'agent-lessons.json');
const lessons = fs.existsSync(lessonsFile) ? JSON.parse(fs.readFileSync(lessonsFile, 'utf8')) : [];
const shipped = lessons
  .filter((l) => Array.isArray(l.steps) && l.steps.length)
  .map((l) => ({ goal: scrub(l.goal), steps: l.steps.map(scrub), at: l.at }))
  // A route that still names the owner isn't shipped at all.
  .filter((l) => {
    const personal = [l.goal, ...l.steps].some((t) => stillPersonal(t, names));
    if (personal) dropped++;
    return !personal;
  })
  .slice(0, 40);
fs.writeFileSync(path.join(out, 'lessons.json'), JSON.stringify(shipped, null, 1));
fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify({ version, skills, lessons: shipped.length }, null, 1));
console.log(
  `instruction pack ${version}: agents.md, ${skills} skills, ${shipped.length} routes -> ${out} (${dropped} personal lines or routes left out)`,
);
