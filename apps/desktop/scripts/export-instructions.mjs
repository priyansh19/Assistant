// Compiles Clicky's instruction pack from a machine where the test suite passed: agents.md, the
// skills (with what they learned) and the learned shortest routes, into resources/instructions,
// which ships with every install (src/main/instruction-pack.ts applies it).
//
//   node scripts/export-instructions.mjs [--from <userData>] [--version 2026.10.12]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const from = arg('--from') ?? path.join(process.env.APPDATA ?? '', 'Clicky');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'instructions');
const version = arg('--version') ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'skills'), { recursive: true });

// agents.md as the user's machine has it.
const agents = path.join(from, 'agents.md');
if (fs.existsSync(agents)) fs.copyFileSync(agents, path.join(out, 'agents.md'));

// Skills, with each "Learned" list cut to its newest lines and personal paths generalised.
const generalise = (s) =>
  s
    .replace(/[A-Z]:\\Users\\[^\\\s"']+/gi, '%USERPROFILE%')
    .replace(/github\.com\/priyansh19/gi, 'github.com/<your username>');
let skills = 0;
for (const f of fs.existsSync(path.join(from, 'skills')) ? fs.readdirSync(path.join(from, 'skills')) : []) {
  if (!f.endsWith('.md')) continue;
  fs.writeFileSync(path.join(out, 'skills', f), generalise(fs.readFileSync(path.join(from, 'skills', f), 'utf8')));
  skills++;
}

// Learned routes (shortest ways that worked), without the user's own names and paths.
const lessonsFile = path.join(from, 'agent-lessons.json');
const lessons = fs.existsSync(lessonsFile) ? JSON.parse(fs.readFileSync(lessonsFile, 'utf8')) : [];
const shipped = lessons
  .filter((l) => Array.isArray(l.steps) && l.steps.length)
  .slice(0, 40)
  .map((l) => ({ goal: generalise(l.goal), steps: l.steps.map(generalise), at: l.at }));
fs.writeFileSync(path.join(out, 'lessons.json'), JSON.stringify(shipped, null, 1));
fs.writeFileSync(path.join(out, 'pack.json'), JSON.stringify({ version, skills, lessons: shipped.length }, null, 1));
console.log(`instruction pack ${version}: agents.md, ${skills} skills, ${shipped.length} routes -> ${out}`);
