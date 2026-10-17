// Fourth batch (16 Oct evening): reading what's in the owner's work apps, read-only. Clicky only
// looks and reports; nothing is changed.
const said = (r, re) => re.test(r.answer);
const clean = (r) => r.answer.length > 15 && !said(r, /couldn't|can't|unable|stopped/i);

export const APPS4 = [
  {
    id: 'NU25',
    say: 'Clicky, open Outlook and tell me how many unread emails I have.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /\b\d+\b|no unread|none/i.test(r.answer) && clean(r),
  },
  {
    id: 'NU26',
    say: 'Clicky, open Microsoft Teams and tell me whether I have any unread chats.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /unread|no new|nothing new|sign in|signed out/i),
  },
  {
    id: 'NU27',
    say: 'Clicky, open my clickey project in VS Code and tell me which folders are inside packages.',
    maxMinutes: 4,
    check: '(Get-ChildItem "$env:USERPROFILE\\OneDrive\\Desktop\\clickey\\packages" -Directory).Name -join \'|\'',
    pass: (out, r) =>
      out
        .split('|')
        .filter(Boolean)
        .every((d) => r.answer.toLowerCase().includes(d.toLowerCase())),
  },
  {
    id: 'NU28',
    say: 'Clicky, open Terminal and tell me which version of Node.js I have.',
    maxMinutes: 3,
    check: 'node --version',
    pass: (out, r) => r.answer.includes(out.trim().replace(/^v/, '')),
  },
  {
    id: 'NU29',
    say: 'Clicky, open pgAdmin and tell me which servers are registered.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => clean(r) || said(r, /no servers|none|password/i),
  },
  {
    id: 'NU30',
    say: 'Clicky, open DBeaver and tell me which database connections it has.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => clean(r) || said(r, /no connections|none/i),
  },
  {
    id: 'NU31',
    say: 'Clicky, open Postman and tell me which collections I have.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => clean(r) || said(r, /no collections|none/i),
  },
  {
    id: 'NU32',
    say: 'Clicky, find the latest Electron release on GitHub and tell me its version number.',
    maxMinutes: 4,
    check:
      '$env:GH_TOKEN = (gh auth token --user priyansh19); gh api repos/electron/electron/releases/latest --jq .tag_name',
    pass: (out, r) => r.answer.includes(out.trim().replace(/^v/, '')),
  },
];
