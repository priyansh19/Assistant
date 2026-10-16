/**
 * Secret shapes: API keys, tokens, JWTs, bearer headers, passwords said out loud and card numbers.
 * Used two ways: `redactSecrets` masks them in anything written to a log or bug report, and
 * `secretReason` refuses to keep them in anything Clicky remembers (notes, lessons, skills, a
 * Clicky's AGENTS.md). Memory is read on every turn and shown in the dashboard, so a secret saved
 * there would leak into every prompt.
 */

interface Shape {
  re: RegExp;
  what: string;
  /** Keep this many leading characters when masking, so a log line still says which key it was. */
  keep: number;
}

const SHAPES: Shape[] = [
  // Provider keys: OpenAI/OpenRouter/Anthropic (sk-…, sk-ant-…, sk-or-v1-…), ElevenLabs (xi-…),
  // GitHub, Slack, Google, AWS.
  { re: /\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{16,}/g, what: 'an API key', keep: 4 },
  { re: /\bxi-[A-Za-z0-9]{8,}/g, what: 'an API key', keep: 4 },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, what: 'a GitHub token', keep: 4 },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, what: 'a Slack token', keep: 5 },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, what: 'a Google key', keep: 4 },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, what: 'an AWS key', keep: 4 },
  // JWTs (eyJ… . … . …), bearer headers, token= / secret= / password= parameters.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, what: 'a sign-in token', keep: 3 },
  { re: /\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, what: 'a sign-in token', keep: 7 },
  {
    re: /\b(?:access_token|refresh_token|id_token|provider_token|api[_-]?key|apikey|client_secret|token|secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"'&,;]{4,}/gi,
    what: 'a password or token',
    keep: 0,
  },
  // Long hex runs (raw keys, session ids).
  { re: /\b[A-Fa-f0-9]{32,}\b/g, what: 'a key', keep: 4 },
];

/** "my password is hunter2", "the PIN is 1234", "passcode: 0000". */
const SPOKEN_SECRET =
  /\b(?:password|passcode|passphrase|pin|pin code|otp|one[- ]time code|verification code|security code|cvv|cvc|recovery code|seed phrase)\b\s*(?:is|was|=|:|of)\s*\S+/i;

/** 13 to 19 digits, optionally grouped by spaces or dashes, passing the Luhn check. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cards(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.push(m[0]);
  }
  return found;
}

/** Why this text must not be remembered ("it looks like an API key"), or null when it's fine. */
export function secretReason(text: string): string | null {
  for (const s of SHAPES) {
    s.re.lastIndex = 0;
    if (s.re.test(text)) return `it looks like ${s.what}`;
  }
  if (SPOKEN_SECRET.test(text)) return 'it looks like a password or code';
  if (cards(text).length) return 'it looks like a card number';
  return null;
}

/** The text with every secret shape masked, for logs and bug reports. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const s of SHAPES) out = out.replace(s.re, (m) => `${m.slice(0, s.keep)}…[redacted]`);
  for (const c of cards(out)) out = out.replace(c, '[card redacted]');
  return out;
}
