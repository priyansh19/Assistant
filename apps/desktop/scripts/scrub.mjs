// Takes personal details out of text that ships with every install (the instruction pack): user
// folders, email addresses, phone numbers, account names in URLs, card-like numbers and keys.
// Anything that still looks personal after scrubbing is dropped by the caller, not shipped.

const RULES = [
  // C:\Users\ana\…, D:\Users\ana, /Users/ana/…, /home/ana/…
  [/\b[A-Z]:\\Users\\[^\\\s"'`]+/gi, '%USERPROFILE%'],
  [/\/(?:Users|home)\/[^/\s"'`]+/g, '~'],
  // OneDrive - Company, Dropbox (Personal) folders named after a person or employer.
  [/OneDrive - [^\\/\s"'`]+(?: [^\\/\s"'`]+)*/g, 'OneDrive'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  // Account names in URLs: github.com/ana, linkedin.com/in/ana, x.com/ana…
  [
    /\b((?:github|gitlab|bitbucket)\.(?:com|org)|linkedin\.com\/in|(?:x|twitter|instagram|facebook|tiktok)\.com)\/@?[\w.-]+/gi,
    '$1/<your username>',
  ],
  // Keys and tokens (sk-…, ghp_…, long hex or base64 runs).
  [/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp])[-_][\w-]{10,}/g, '<secret>'],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<secret>'],
  // Phone numbers: +39 333 123 4567, (555) 123-4567.
  [/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g, '<phone>'],
];

/** The text with personal details replaced by placeholders. */
export function scrub(text) {
  let out = String(text);
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

/** Text that still names a person's account after scrubbing (a name the rules can't know). */
export function stillPersonal(text, names = []) {
  const t = String(text).toLowerCase();
  return names.some((n) => n.length >= 3 && t.includes(n.toLowerCase()));
}
