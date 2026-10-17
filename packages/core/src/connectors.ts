/**
 * Custom connectors: any MCP server the user adds, either a hosted URL or a command on this PC.
 * Names (of the server, its environment variables and headers) are kept in settings for display;
 * values (keys, tokens) are kept only in the credential store and handed to the server process as
 * environment variables or request headers, never written to a file the agent can read.
 */

export type ConnectorTransport = 'remote' | 'stdio';
export type ConnectorAuth = 'none' | 'apiKey' | 'oauth';

export interface ConnectorConfig {
  id: string;
  name: string;
  transport: ConnectorTransport;
  /** remote: the server's https URL. */
  url?: string;
  /** stdio: the command (npx, node, a full path) and its arguments. */
  command?: string;
  args?: string[];
  auth: ConnectorAuth;
  /** Names only; values live in the credential store. */
  envNames: string[];
  headerNames: string[];
  oauthClientId?: string;
  enabled: boolean;
  /** One line saying what it can do, derived from its tools after a successful check. */
  capability?: string;
  toolCount?: number;
}

/** The secret half, stored with safeStorage under the connector's id. */
export interface ConnectorSecrets {
  bearer?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface ConnectorCheck {
  errors: string[];
  warnings: string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** Split "-y some-server --flag 'a b'" like a shell would (quotes and backslash escapes). */
export function parseArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** "API_TOKEN=abc" lines → names and values, with a message per bad line. */
export function parseEnvLines(text: string): { values: Record<string, string>; errors: string[] } {
  return parseLines(text, '=', ENV_NAME, (n) => `${n} is not a valid environment variable name.`);
}

/** "X-Api-Key: abc" lines → names and values. */
export function parseHeaderLines(text: string): { values: Record<string, string>; errors: string[] } {
  return parseLines(text, ':', HEADER_NAME, (n) => `${n} is not a valid header name.`);
}

function parseLines(
  text: string,
  sep: string,
  nameRe: RegExp,
  bad: (n: string) => string,
): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(sep);
    const name = (at === -1 ? line : line.slice(0, at)).trim();
    if (at === -1) {
      errors.push(`"${name.slice(0, 30)}" needs a value, like ${sep === '=' ? 'NAME=value' : 'Name: value'}.`);
      continue;
    }
    if (!nameRe.test(name)) {
      errors.push(bad(name.slice(0, 40)));
      continue;
    }
    values[name] = line.slice(at + 1).trim();
  }
  return { values, errors };
}

/**
 * Problems that stop the connector being saved, and warnings shown beside it. `others` are the
 * user's other connectors: two connectors may not use the same environment variable name.
 */
export function checkConnector(c: ConnectorConfig, others: readonly ConnectorConfig[]): ConnectorCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!c.name.trim()) errors.push('Give the connector a name.');
  if (others.some((o) => o.id !== c.id && o.name.trim().toLowerCase() === c.name.trim().toLowerCase()))
    errors.push(`You already have a connector called ${c.name.trim()}.`);
  if (c.transport === 'remote') {
    let u: URL | null;
    try {
      u = new URL(c.url ?? '');
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:'))
      errors.push("Enter the server's full URL, starting with https://.");
    else {
      if (u.username || u.password)
        errors.push('Remove the sign-in details from the URL and use the authentication fields instead.');
      if (/[?&](?:access_token|token|api[_-]?key|key|secret)=/i.test(u.search))
        errors.push('Remove the key from the URL and use the authentication fields instead.');
      if (u.protocol === 'http:' && !isLoopback(u.hostname))
        warnings.push('This server uses plain http, so its traffic is not encrypted.');
    }
  } else {
    const cmd = (c.command ?? '').trim();
    if (!cmd) errors.push('Enter the command that starts the server, like npx.');
    else if (/[|&;<>`$]/.test(cmd))
      errors.push('Enter just the program here; put everything after it under Arguments.');
  }
  for (const n of c.envNames) if (!ENV_NAME.test(n)) errors.push(`${n} is not a valid environment variable name.`);
  for (const n of c.headerNames) {
    if (!HEADER_NAME.test(n)) errors.push(`${n} is not a valid header name.`);
    else if (RESERVED_HEADERS.has(n.toLowerCase())) errors.push(`${n} is set by Clicky and can't be changed.`);
  }
  for (const n of c.envNames) {
    const clash = others.find((o) => o.id !== c.id && o.envNames.some((x) => x.toUpperCase() === n.toUpperCase()));
    if (clash) errors.push(`${clash.name} already uses ${n}. Use a different name, or remove that connector first.`);
  }
  if (c.transport === 'stdio' && c.auth === 'oauth') errors.push('Browser sign-in works only for servers with a URL.');
  return { errors, warnings };
}

/** Things that change what a saved credential belongs to; changing them clears the credentials. */
export function credentialsInvalidated(before: ConnectorConfig, after: ConnectorConfig): boolean {
  return (
    before.transport !== after.transport ||
    (before.url ?? '') !== (after.url ?? '') ||
    (before.command ?? '') !== (after.command ?? '') ||
    (before.oauthClientId ?? '') !== (after.oauthClientId ?? '')
  );
}

const ID_PART = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export interface StdioLaunch {
  transport: 'stdio';
  command: string;
  args: string[];
  /** Added to the server's environment only; never written to disk. */
  env: Record<string, string>;
}

export interface RemoteLaunch {
  transport: 'remote';
  url: string;
  headers: Record<string, string>;
}

/**
 * How to start or reach the server with its secrets. Only the names that the config lists are
 * passed (a value left over from an older config is not), and the bearer token goes in the
 * Authorization header or a CLICKY_CONNECTOR_<ID>_BEARER_TOKEN variable.
 */
export function launchSpec(c: ConnectorConfig, s: ConnectorSecrets): StdioLaunch | RemoteLaunch {
  if (c.transport === 'stdio') {
    const env: Record<string, string> = {};
    for (const n of c.envNames) if (s.env[n] !== undefined) env[n] = s.env[n];
    if (s.bearer) env[`CLICKY_CONNECTOR_${ID_PART(c.id)}_BEARER_TOKEN`] = s.bearer;
    return { transport: 'stdio', command: (c.command ?? '').trim(), args: c.args ?? [], env };
  }
  const headers: Record<string, string> = {};
  for (const n of c.headerNames) if (s.headers[n] !== undefined) headers[n] = s.headers[n];
  if (s.bearer) headers['Authorization'] = `Bearer ${s.bearer}`;
  return { transport: 'remote', url: (c.url ?? '').trim(), headers };
}

/**
 * Where to look for a stdio command on Windows when the GUI app's PATH is shorter than a
 * terminal's: the PATH entries, npm's global folder, and per-user program folders, each with
 * the PATHEXT extensions (npx is npx.cmd). A full path is returned as is.
 */
export function commandCandidates(command: string, env: Record<string, string | undefined>): string[] {
  const cmd = command.trim();
  if (/^[a-z]:[\\/]|^\\\\|[\\/]/i.test(cmd)) return [cmd];
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const dirs = (env['PATH'] ?? env['Path'] ?? '').split(';').filter(Boolean);
  if (env['APPDATA']) dirs.push(`${env['APPDATA']}\\npm`);
  if (env['LOCALAPPDATA'])
    dirs.push(`${env['LOCALAPPDATA']}\\Programs\\nodejs`, `${env['LOCALAPPDATA']}\\Microsoft\\WindowsApps`);
  if (env['ProgramFiles']) dirs.push(`${env['ProgramFiles']}\\nodejs`);
  if (env['USERPROFILE'])
    dirs.push(
      `${env['USERPROFILE']}\\.bun\\bin`,
      `${env['USERPROFILE']}\\.cargo\\bin`,
      `${env['USERPROFILE']}\\.volta\\bin`,
    );
  const hasExt = /\.[a-z0-9]{1,4}$/i.test(cmd);
  const out: string[] = [];
  for (const d of [...new Set(dirs.map((x) => x.replace(/[\\/]+$/, '')))]) {
    if (hasExt) out.push(`${d}\\${cmd}`);
    else for (const e of exts) out.push(`${d}\\${cmd}${e}`);
  }
  return out;
}

export interface McpToolInfo {
  name: string;
  description?: string;
}

export type ToolEffect = 'read' | 'change' | 'outward';

const OUTWARD =
  /\b(send|reply|post|publish|share|invite|message|email|tweet|comment|notify|pay|purchase|buy|charge|transfer|spend|budget|bid|launch|deploy|merge|submit)\w*/i;
const CHANGE =
  /\b(create|add|update|edit|set|write|upload|move|rename|delete|remove|archive|close|assign|insert|patch|modify|cancel|pause|resume|enable|disable)\w*/i;

/**
 * What a tool does, from its name and description: reads, changes things in the app, or reaches
 * other people or money. This is a description for the capability line and an input for the
 * approval layer; it is not itself the safety decision.
 */
export function toolEffect(t: McpToolInfo): ToolEffect {
  const text = `${t.name.replace(/[_.-]+/g, ' ')} ${t.description ?? ''}`;
  const name = t.name.replace(/[_.-]+/g, ' ');
  if (OUTWARD.test(name)) return 'outward';
  if (CHANGE.test(name)) return 'change';
  if (OUTWARD.test(text)) return 'outward';
  if (CHANGE.test(text)) return 'change';
  return 'read';
}

const NOUN_SKIP = new Set([
  'get',
  'list',
  'search',
  'find',
  'read',
  'fetch',
  'query',
  'create',
  'add',
  'update',
  'edit',
  'set',
  'delete',
  'remove',
  'send',
  'post',
  'by',
  'id',
  'all',
  'one',
  'many',
  'new',
  'tool',
  'mcp',
]);

/** "find, create and update issues and projects": what the voice and the agent are told it can do. */
export function capabilityLine(tools: readonly McpToolInfo[]): string {
  if (!tools.length) return 'no tools yet';
  const verbs = new Set<string>();
  const nouns = new Map<string, number>();
  for (const t of tools) {
    const parts = t.name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[\s_.-]+/)
      .filter(Boolean);
    const e = toolEffect(t);
    const first = parts[0] ?? '';
    if (e === 'read') verbs.add('find');
    else if (/^(create|add|insert|new)/.test(first)) verbs.add('create');
    else if (/^(delete|remove|archive)/.test(first)) verbs.add('delete');
    else if (e === 'outward') verbs.add('send');
    else verbs.add('update');
    for (const p of parts) {
      if (NOUN_SKIP.has(p) || p.length <= 2 || /^\d+$/.test(p)) continue;
      const one = p.endsWith('ies')
        ? `${p.slice(0, -3)}y`
        : /(ss|us)$/.test(p)
          ? p
          : p.replace(/(?:es(?<=(?:sh|ch|x)es)|s)$/, '');
      nouns.set(one, (nouns.get(one) ?? 0) + 1);
    }
  }
  const order = ['find', 'create', 'update', 'send', 'delete'];
  const v = order.filter((x) => verbs.has(x));
  const verbText = v.length <= 1 ? (v[0] ?? 'use') : `${v.slice(0, -1).join(', ')} and ${v[v.length - 1]}`;
  const top = [...nouns.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([n]) => (/[^aeiou]y$/.test(n) ? `${n.slice(0, -1)}ies` : /(sh|ch|x|s)$/.test(n) ? `${n}es` : `${n}s`));
  const nounText = top.length <= 1 ? (top[0] ?? 'items') : `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}`;
  return `${verbText} ${nounText}`;
}

/** The fixed honest lines for connector checks. */
export const connectorCopy = {
  accepted: (name: string, tools: number): string =>
    `${name} accepted the key (${tools} tool${tools === 1 ? '' : 's'}).`,
  rejected: (name: string, status: number): string =>
    `${name} rejected the key (HTTP ${status}). Paste a fresh one under Edit.`,
  unreachable: (name: string): string =>
    `Couldn't reach ${name}. Check the server URL and your connection, then try again.`,
  notFound: (cmd: string): string => `${cmd} wasn't found on this PC. Use the full path, or install it first.`,
  cleared: 'Changing the server or client ID clears its saved key. Save, then sign in again or add the new key.',
  unauthorizedForAgent: (name: string): string =>
    `${name} said the key isn't valid any more. Open Settings, Connectors, ${name} to add a fresh one.`,
};

/** Rules added to the agent's briefing when connectors are available. */
export function connectorRules(list: readonly ConnectorConfig[]): string {
  const on = list.filter((c) => c.enabled);
  if (!on.length) return '';
  return [
    '## Connected apps (custom connectors)',
    ...on.map((c) => `- ${c.name}: ${c.capability ?? 'tools not checked yet'}`),
    'Use a connector directly for tasks in its app instead of working its website on screen. The same approval rule applies: confirm before sending messages to other people, posting, or changing spending or budgets.',
    "Its key is already set up: never ask for a key or token, never print one, and never look for one in other apps' settings. If a tool is missing or says unauthorized, say so and point the user to Settings, Connectors.",
    'After any change, read the item back by its id and check each field before you say it is done, then give its link.',
  ].join('\n');
}
