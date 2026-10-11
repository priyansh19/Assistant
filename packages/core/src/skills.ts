/**
 * The agent's standing context and task skills, both plain Markdown the user can read and edit:
 *
 * - agents.md: who Clicky is, what it is responsible for, how this PC is set up and how to read a
 *   screenshot. Added to every agent run.
 * - skills/*.md: playbooks for one kind of task (merging pull requests on GitHub, collecting jobs
 *   from LinkedIn into a sheet…). A skill is added to a run when its triggers appear in the task,
 *   and grows a "Learned" list from runs that worked.
 */

export interface AgentSkill {
  id: string;
  name: string;
  /** Words or phrases; the skill applies when any of them appears in the task. */
  triggers: string[];
  body: string;
}

export const DEFAULT_BRIEFING = `# Clicky: your briefing

You are Clicky, a voice assistant that lives next to the mouse pointer on the user's Windows PC.
You carry out tasks the user asks for out loud: opening apps and sites, reading what is on screen,
working across several websites in a row, and turning what you find into files (sheets, notes).

## How to read a screenshot
- Each turn you get fresh screenshots of every screen. They are the truth: trust them over what
  you expected to happen. Compare with the previous step to see what changed.
- Pages load slowly. If a page is blank, half-drawn or shows a spinner, wait instead of clicking.
- Popups (cookie banners, sign-in nags, "open in app", notifications) sit on top of the page.
  Close them with their X, "Not now" or "Reject all" before going on. Never accept new terms.
- Text you need may be below the fold: scroll inside the page and look again.
- The browser address bar shows where you are. To go somewhere, open the URL directly instead of
  searching for it.

## How to work on long tasks
- Break the task into parts (for example: open the site, find the list, collect the items, save
  the file) and finish one part before starting the next.
- Screenshots of earlier pages are gone once you move on, so write down what you find with the
  note action as you go. Notes are your memory for the rest of the task.
- When the task asks for a sheet, spreadsheet or Excel file, collect the rows with notes, then use
  save_sheet once at the end and open the saved file so the user sees it.
- Report what you found in "say" when you finish: numbers, names, titles. The user hears it.

## Safety
- You never send messages, post, apply, buy, delete or merge without asking: mark those steps
  risky and the user decides.
- If you are not signed in somewhere, stop and ask the user to sign in; never type passwords.
`;

/** Skills Clicky starts with. The user can edit or delete them; runs that work add to them. */
export const STARTER_SKILLS: AgentSkill[] = [
  {
    id: 'github-pull-requests',
    name: 'GitHub pull requests',
    triggers: ['pull request', 'pull requests', 'pr', 'prs', 'merge', 'github'],
    body: `- Open the repository directly: {"url":"https://github.com/<owner>/<repo>/pulls"}. The user's
  own repositories are under their GitHub username (see the "Your repositories" list or their profile).
- The Pull requests tab lists open ones; "Closed" shows merged and closed ones.
- To merge one: open it, scroll to the bottom, click "Merge pull request" (risky), then "Confirm
  merge" (risky). If the button is grey, read why (checks failing, conflicts, review needed) and say so.
- After merging, go back to the list and continue with the next open one. Done when the list says
  there are no open pull requests.`,
  },
  {
    id: 'linkedin-jobs',
    name: 'LinkedIn jobs',
    triggers: ['linkedin'],
    body: `- LinkedIn is read only: never apply, message, connect, like, comment or post.
- Job search: {"url":"https://www.linkedin.com/jobs/search/?keywords=<words>&location=<place>"}.
  Each card shows the title, company and location; scroll the list on the left for more.
- Feed: {"url":"https://www.linkedin.com/feed/"}. Job posts say "hiring", "we're hiring", "open role"
  or link to a job. Scroll a few screens and note each relevant one.
- What fits the user comes from "About the user" (their role, seniority and location).
- Note each job as a row: title, company, location, link or where it was seen.`,
  },
  {
    id: 'spreadsheets',
    name: 'Sheets and Excel files',
    triggers: ['excel', 'sheet', 'spreadsheet', 'table', 'csv'],
    body: `- Collect rows with {"action":"note","row":["…","…"]} as you find them (one row per item).
- At the end: {"action":"save_sheet","name":"<short title>","columns":["…","…"]}. It writes an .xlsx
  in Documents\\Clicky with every noted row (or pass "rows" yourself).
- Then open the file with {"action":"open","path":"<the saved path>"} and finish with done, saying
  how many rows it has.`,
  },
  {
    id: 'comet-browser',
    name: 'Browsing in Comet',
    triggers: ['comet', 'browser', 'tab', 'website', '.com', 'site'],
    body: `- Comet is the user's default browser: {"url": …} opens pages there.
- ctrl+l focuses the address bar, ctrl+t opens a new tab, ctrl+tab or ctrl+<n> switches tabs,
  ctrl+w closes the tab.
- Comet's assistant side panel is not part of the page; ignore it unless the task is about it.`,
  },
  {
    id: 'windows-files',
    name: 'Files and folders',
    triggers: ['folder', 'file', 'downloads', 'desktop', 'documents', 'save it', 'explorer'],
    body: `- Open folders with {"path": …} (see "Folders"). In File Explorer, the Details view shows dates;
  click the "Date modified" header to sort.
- In a Save dialog, type the full file name in "File name" and press enter. If it asks to replace a
  file, that is risky.
- Deleting files is risky.`,
  },
];

const META = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse a skill file: front matter (name, triggers) then Markdown. */
export function parseSkill(id: string, text: string): AgentSkill {
  let body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const meta: Record<string, string> = {};
  const m = META.exec(body);
  if (m?.[1]) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^\s*([a-z]+)\s*:\s*(.*)$/i.exec(line);
      if (kv?.[1]) meta[kv[1].toLowerCase()] = (kv[2] ?? '').trim();
    }
    body = body.slice(m[0].length);
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    id,
    name: (meta['name'] || heading || id).slice(0, 80),
    triggers: (meta['triggers'] ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 30),
    body: body.trim(),
  };
}

export function serializeSkill(s: AgentSkill): string {
  return [
    '---',
    `name: ${s.name.replace(/\n/g, ' ')}`,
    `triggers: ${s.triggers.join(', ')}`,
    '---',
    '',
    s.body.trim(),
    '',
  ].join('\n');
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A trigger matches as whole words ("pr" is not "print"; ".com" can sit inside "example.com"). */
function hit(goal: string, t: string): boolean {
  const pre = /^[a-z0-9]/.test(t) ? '(?:^|[^a-z0-9])' : '';
  const post = /[a-z0-9]$/.test(t) ? '(?:$|[^a-z0-9])' : '';
  return new RegExp(`${pre}${escapeRe(t)}${post}`).test(goal);
}

/** The skills whose triggers appear in the task (at most `max`, most triggers matched first). */
export function matchSkills(goal: string, skills: readonly AgentSkill[], max = 3): AgentSkill[] {
  const g = goal.toLowerCase();
  return skills
    .map((s) => ({ s, hits: s.triggers.filter((t) => hit(g, t)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max)
    .map((x) => x.s);
}

/** Matched skills as a prompt block. */
export function skillsText(skills: readonly AgentSkill[], budget = 4000): string {
  const parts: string[] = [];
  for (const s of skills) {
    const body = s.body.slice(0, budget);
    if (!body) continue;
    budget -= body.length;
    parts.push(`Skill "${s.name}" (follow it):\n${body}`);
    if (budget <= 0) break;
  }
  return parts.join('\n\n');
}

const LEARNED = '## Learned from runs that worked';
const MAX_LEARNED = 8;

/** The skill with one more "worked" line; the oldest is dropped past the limit. */
export function learnIntoSkill(s: AgentSkill, goal: string, steps: readonly string[], when: Date): AgentSkill {
  const line = `- ${when.toISOString().slice(0, 10)} "${goal.slice(0, 120).replace(/\n/g, ' ')}": ${steps
    .slice(0, 10)
    .join('; ')
    .replace(/\n/g, ' ')
    .slice(0, 500)}`;
  const at = s.body.indexOf(LEARNED);
  const head = (at === -1 ? s.body : s.body.slice(0, at)).trimEnd();
  const old =
    at === -1
      ? []
      : s.body
          .slice(at + LEARNED.length)
          .split('\n')
          .filter((l) => l.startsWith('- '));
  const lines = [...old, line].slice(-MAX_LEARNED);
  return { ...s, body: `${head}\n\n${LEARNED}\n${lines.join('\n')}` };
}
