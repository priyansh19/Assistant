// App suite (owner's brief, 16 Oct): Clicky operates each app on this laptop for a real task, in as
// few steps as it can. Setup and checks are scripts; everything in between is Clicky. Settings tasks
// put the original value back in cleanup (recorded before testing: dark mode, extensions shown,
// taskbar centred). GitHub tasks only touch repos Clicky creates itself, named clicky-test-….
const has = (r, re) => re.test(r.rawLog);
const said = (r, re) => re.test(r.answer);
const reg = (path, name) => `(Get-ItemProperty '${path}').${name}`;
const PERSONALIZE = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const ADVANCED = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const desk = "[Environment]::GetFolderPath('Desktop')";
const REPO = `clicky-test-${new Date().toISOString().slice(5, 10).replace('-', '')}`;
const ghRepo = (name) =>
  `$env:GH_TOKEN = (gh auth token --user priyansh19); $r = gh api repos/priyansh19/${name} --jq .name 2>$null; if ($r) { $r } else { 'none' }`;

export const APPS = [
  // ---- Terminals and developer tools.
  {
    id: 'AP01',
    say: 'Clicky, open Terminal and tell me which version of git I have.',
    maxMinutes: 3,
    check: 'git --version',
    pass: (out, r) => {
      const v = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? 'x';
      return r.answer.includes(v);
    },
  },
  {
    id: 'AP02',
    say: 'Clicky, open PowerShell and tell me how much free space is left on my C drive.',
    maxMinutes: 3,
    // Windows counts GB as 1024³ and some answers as 10⁹: either is right.
    check: '[math]::Round((Get-PSDrive C).Free / 1GB); [math]::Round((Get-PSDrive C).Free / 1e9)',
    pass: (out, r) => {
      const gbs = out.trim().split(/\s+/).map(Number);
      return [...r.answer.matchAll(/(\d+(?:\.\d+)?)\s*(?:GB|gigabytes)/gi)].some((m) =>
        gbs.some((gb) => Math.abs(Number(m[1]) - gb) <= Math.max(3, gb * 0.05)),
      );
    },
  },
  {
    id: 'AP03',
    say: 'Clicky, open Terminal and tell me which version of kubectl I have.',
    maxMinutes: 3,
    check: "'n/a'",
    pass: (_o, r) => /1\.36/.test(r.answer),
  },
  {
    id: 'AP04',
    say: 'Clicky, open Terminal and ask Claude Code which version it is.',
    maxMinutes: 3,
    check: 'claude --version',
    pass: (out, r) => {
      const v = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? 'x';
      return r.answer.includes(v);
    },
  },
  {
    id: 'AP05',
    say: 'Clicky, start Docker Desktop and tell me when the Docker engine is running.',
    maxMinutes: 6,
    check: "$v = docker version --format '{{.Server.Version}}' 2>$null; if ($v) { $v } else { 'none' }; exit 0",
    pass: (out, r) => /\d+\.\d+/.test(out) && said(r, /running|started|ready/i),
  },
  {
    id: 'AP06',
    say: 'Clicky, open Terminal, run the Docker hello-world container and tell me what it printed.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => said(r, /hello from docker|working correctly|installation appears/i),
    cleanup: ['docker rm -f $(docker ps -aq --filter ancestor=hello-world) 2>$null | Out-Null'],
  },
  {
    id: 'AP07',
    say: 'Clicky, in VS Code create a Python file on my Desktop called clicky_hello.py that prints hello from Clicky, and save it.',
    maxMinutes: 5,
    check: `$f = Join-Path (${desk}) 'clicky_hello.py'; if (Test-Path $f) { Get-Content $f -Raw } else { 'missing' }`,
    pass: (out) => /print\s*\(\s*["']hello from clicky["']\s*\)/i.test(out),
    cleanup: [`Remove-Item (Join-Path (${desk}) 'clicky_hello.py') -ErrorAction SilentlyContinue`],
  },
  {
    id: 'AP08',
    say: 'Clicky, open Postman and send a GET request to httpbin.org/get, then tell me the status code.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /\b200\b/.test(r.answer),
  },
  {
    id: 'AP09',
    say: 'Clicky, open Ubuntu and tell me which version of Ubuntu it is.',
    maxMinutes: 4,
    check: "$v = wsl -d Ubuntu -- lsb_release -rs 2>$null; if ($v) { $v } else { 'none' }; exit 0",
    pass: (out, r) => {
      const v = out.trim().split('\n').pop()?.trim() ?? 'x';
      return !!v && r.answer.includes(v);
    },
  },
  {
    id: 'AP10',
    say: 'Clicky, open Python IDLE and work out 2 to the power of 100.',
    maxMinutes: 3,
    check: "'n/a'",
    pass: (_o, r) => r.answer.replace(/[,\s]/g, '').includes('1267650600228229401496703205376'),
  },

  // ---- AI apps.
  {
    id: 'AP11',
    say: 'Clicky, open the ChatGPT app and ask it what the capital of the UAE is.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /abu dhabi/i),
  },
  {
    id: 'AP12',
    say: 'Clicky, open Grok Bot and ask it to name three famous landmarks in Dubai.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /burj|palm|museum of the future|dubai mall|frame|creek/i),
  },

  // ---- Everyday apps.
  {
    id: 'AP13',
    say: 'Clicky, use the Calculator to convert 100 US dollars to UAE dirhams.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /36[5-9](?:\.\d+)?/.test(r.answer),
  },
  {
    id: 'AP14',
    say: 'Clicky, open the Weather app and tell me tomorrow’s forecast.',
    maxMinutes: 3,
    check: "'n/a'",
    pass: (_o, r) => said(r, /°|degrees|sunny|cloud|clear|rain|hot/i),
  },
  {
    id: 'AP15',
    say: 'Clicky, open the Clock app and start a one minute timer.',
    maxMinutes: 3,
    check: "'n/a'",
    pass: (_o, r) => said(r, /timer|started|running|counting/i) && r.outcome === 'answered',
  },
  {
    id: 'AP16',
    say: 'Clicky, open Beekeeper Studio and tell me which database connections I have saved.',
    maxMinutes: 3,
    check: "'n/a'",
    pass: (_o, r) => r.answer.length > 20 && !said(r, /couldn't|can't|unable/i),
  },
  {
    id: 'AP17',
    say: 'Clicky, open File Explorer at my Downloads folder and sort it by size, biggest first.',
    maxMinutes: 3,
    check: '[LiveWin]::Front()',
    pass: (out, r) => /downloads/i.test(out) && has(r, /size/i),
  },

  // ---- Windows settings (each put back afterwards).
  {
    id: 'ST01',
    say: 'Clicky, switch Windows to light mode.',
    maxMinutes: 4,
    check: reg(PERSONALIZE, 'AppsUseLightTheme'),
    pass: (out) => out.trim() === '1',
    cleanup: [
      `Set-ItemProperty '${PERSONALIZE}' AppsUseLightTheme 0; Set-ItemProperty '${PERSONALIZE}' SystemUsesLightTheme 0`,
    ],
  },
  {
    id: 'ST02',
    say: 'Clicky, make File Explorer hide file name extensions.',
    maxMinutes: 4,
    check: reg(ADVANCED, 'HideFileExt'),
    pass: (out) => out.trim() === '1',
    cleanup: [`Set-ItemProperty '${ADVANCED}' HideFileExt 0`],
  },
  {
    id: 'ST03',
    say: 'Clicky, move my taskbar icons to the left.',
    maxMinutes: 4,
    check: reg(ADVANCED, 'TaskbarAl'),
    pass: (out) => out.trim() === '0',
    cleanup: [`Set-ItemProperty '${ADVANCED}' TaskbarAl 1`],
  },

  // ---- Web and GitHub.
  {
    id: 'WB01',
    say: 'Clicky, find the Docker documentation for docker run and tell me what the -d flag does.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /detach|background/i),
  },
  {
    id: 'WB02',
    say: 'Clicky, open the GitHub page for the Electron project and tell me how many stars it has.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /\d+(?:\.\d+)?\s*k|\d{2,3},\d{3}/i.test(r.answer),
  },
  {
    id: 'GH01',
    say: `Clicky, create a new private GitHub repository called ${REPO}.`,
    maxMinutes: 5,
    allow: new RegExp(REPO, 'i'),
    check: ghRepo(REPO),
    pass: (out) => out.trim() === REPO,
  },
  {
    id: 'GH02',
    say: `Clicky, delete the GitHub repository ${REPO}.`,
    maxMinutes: 6,
    allow: new RegExp(REPO, 'i'),
    check: ghRepo(REPO),
    pass: (out) => out.trim() === 'none',
  },
  {
    id: 'GH03',
    say: 'Clicky, how many open pull requests does my Assistant repository on GitHub have?',
    maxMinutes: 4,
    check: "$env:GH_TOKEN = (gh auth token --user priyansh19); gh pr list --repo priyansh19/Assistant --state open --json number --jq length",
    pass: (out, r) => {
      const n = Number(out.trim());
      const words = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
      return new RegExp(`\\b(${n}|${words[n] ?? '_'})\\b`, 'i').test(r.answer);
    },
  },
];
