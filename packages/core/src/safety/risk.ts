/**
 * The code-side risk check for agent steps. The model's own "risky" flag is only a hint: this
 * decides from the real action (its target's name, the window it lands in, the keys, the text, the
 * path) and fails closed. The step's level is the higher of this and the model's flag.
 *
 * Levels:
 * - safe: runs without asking.
 * - confirm: asks, unless the user allowed exactly this step earlier in the same run or turned on
 *   Allow all for the run.
 * - irreversible: sends, posts, pays, deletes, merges, runs programs. Always asks, every time.
 *   Allow all and earlier approvals never cover it.
 * - forbidden: never done (password fields, card numbers, network paths). The run stops and says why.
 */

import type { AgentAction } from '../agent.js';

export type RiskLevel = 'safe' | 'confirm' | 'irreversible' | 'forbidden';

const ORDER: Record<RiskLevel, number> = { safe: 0, confirm: 1, irreversible: 2, forbidden: 3 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export interface RiskContext {
  /** The task as the user said it (an app the user named themselves may be sent to). */
  goal?: string;
  /** Title of the window in front ("Inbox - Outlook"), or of the window the step targets. */
  window?: string;
  /** Name of the control the step lands on, from UI Automation (not the model's label). */
  targetName?: string;
  /** Kind of that control ("button", "edit", "password"…). */
  targetKind?: string;
  /** The box that has the keyboard focus is a password field. */
  focusIsPassword?: boolean;
}

export interface Risk {
  level: RiskLevel;
  /** Plain reasons, for the log and the confirmation ("it sends a message"). */
  reasons: string[];
}

/** Words on a button or menu item that mean the step can't be taken back (several languages). */
const IRREVERSIBLE_WORDS: { re: RegExp; why: string }[] = [
  {
    re: /\b(send|sent|send now|invia|inviare|senden|absenden|envoyer|enviar|reply all|rispondi a tutti)\b/i,
    why: 'it sends a message',
  },
  {
    re: /\b(post|publish|tweet|share now|submit|pubblica|invia modulo|veröffentlichen|posten|publier|publicar|enregistrer et publier)\b/i,
    why: 'it posts or submits',
  },
  {
    re: /\b(delete|deleted|remove|erase|trash|discard|empty recycle bin|permanently|elimina|cancella|rimuovi|löschen|entfernen|supprimer|eliminar|borrar)\b/i,
    why: 'it deletes',
  },
  {
    re: /\b(pay|pay now|buy|buy now|purchase|checkout|check out|place (?:your )?order|order now|subscribe|paga|acquista|compra|ordina|bezahlen|kaufen|bestellen|payer|acheter|commander|pagar|comprar)\b/i,
    why: 'it spends money',
  },
  { re: /\b(merge|confirm merge|squash and merge|rebase and merge|unisci)\b/i, why: 'it merges' },
  { re: /\b(transfer|wire|bonifico|überweisen|virement|transferir)\b/i, why: 'it moves money' },
  { re: /\b(uninstall|disinstalla|deinstallieren|désinstaller|desinstalar)\b/i, why: 'it uninstalls' },
  {
    re: /\b(format|factory reset|reset this pc|wipe|close account|delete account|deactivate|disattiva account)\b/i,
    why: 'it wipes or closes an account',
  },
];

/** Words that change the PC but can be undone; asked unless allowed for this run. */
const CONFIRM_WORDS: { re: RegExp; why: string }[] = [
  {
    re: /\b(install|installa|installieren|installer|instalar|update now|restart|shut ?down|sign out|log ?out)\b/i,
    why: 'it changes the PC',
  },
  { re: /\b(allow|grant|authori[sz]e|consenti|zulassen|autoriser|permitir)\b/i, why: 'it grants a permission' },
];

/** Apps where Enter sends a message to a person. */
const CHAT_WINDOW =
  /\b(whatsapp|telegram|slack|teams|discord|messenger|signal|skype|outlook|gmail|mail|thunderbird|instagram|linkedin|twitter|x\.com|facebook|wechat|line|viber|zoom|google chat|messages)\b/i;
/** Apps where Enter runs a command. */
const TERMINAL_WINDOW =
  /\b(powershell|command prompt|cmd(?:\.exe)?|windows terminal|terminal|bash|wsl|git bash|ubuntu|administrator:|run\b)/i;
/** AI assistant apps: Enter asks the assistant, which is fine when the user named it. */
const AI_WINDOW = /\b(chatgpt|claude|grok|copilot|gemini|perplexity|codex|deepseek|mistral|le chat)\b/i;
/** Windows that hold credentials or system security: never typed into. */
const SECURE_WINDOW =
  /\b(windows security|user account control|credential manager|enter (?:your )?password|sign in to|password manager|1password|bitwarden|keepass|lastpass|dashlane)\b/i;

/** A program or script: opening it runs code. */
const EXECUTABLE =
  /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|pif|cpl|lnk|url|reg|jar|appref-ms|application|gadget|inf|sys|dll)$/i;

/** 13 to 19 digits that pass the Luhn check: a payment card number. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** A network or device path ("\\server\share", "\\?\C:\…", "//server"): never opened or used. */
export function isNetworkPath(path: string): boolean {
  return /^(?:\\\\|\/\/)/.test(path.trim());
}

function wordsRisk(text: string, reasons: string[]): RiskLevel {
  let level: RiskLevel = 'safe';
  for (const w of IRREVERSIBLE_WORDS)
    if (w.re.test(text)) {
      level = 'irreversible';
      if (!reasons.includes(w.why)) reasons.push(w.why);
    }
  if (level === 'safe')
    for (const w of CONFIRM_WORDS)
      if (w.re.test(text)) {
        level = 'confirm';
        if (!reasons.includes(w.why)) reasons.push(w.why);
      }
  return level;
}

/** The user named this assistant app in the task ("ask Grok…"), so sending to it is what they asked. */
function userNamedAiApp(goal: string | undefined, window: string): boolean {
  const app = AI_WINDOW.exec(window)?.[1]?.toLowerCase();
  return !!app && !!goal && goal.toLowerCase().includes(app);
}

/** What pressing Enter (or typing a line break) does in this window. */
function enterRisk(ctx: RiskContext, reasons: string[]): RiskLevel {
  const w = ctx.window ?? '';
  if (AI_WINDOW.test(w)) {
    if (userNamedAiApp(ctx.goal, w)) return 'safe';
    reasons.push('Enter sends the message to an assistant you did not name');
    return 'confirm';
  }
  if (CHAT_WINDOW.test(w)) {
    reasons.push('Enter sends the message');
    return 'irreversible';
  }
  if (TERMINAL_WINDOW.test(w)) {
    reasons.push('Enter runs a command');
    return 'irreversible';
  }
  return 'safe';
}

/**
 * The code-side level of one step. Unknown actions are not safe: anything this doesn't recognise
 * is at least "confirm".
 */
export function classifyRisk(a: AgentAction, ctx: RiskContext = {}): Risk {
  const reasons: string[] = [];
  const window = ctx.window ?? '';
  let level: RiskLevel = 'safe';
  const raise = (l: RiskLevel, why?: string): void => {
    if (why && !reasons.includes(why)) reasons.push(why);
    level = maxRisk(level, l);
  };
  const typing = (text: string): void => {
    if (ctx.focusIsPassword || ctx.targetKind === 'password') raise('forbidden', 'it types into a password field');
    if (SECURE_WINDOW.test(window)) raise('forbidden', 'it types into a sign-in or security window');
    if (looksLikeCardNumber(text)) raise('forbidden', 'it types a card number');
    if (/[\r\n]/.test(text)) raise(enterRisk(ctx, reasons));
  };

  switch (a.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'click_element': {
      // Both names count: the model's label and the control really under the point.
      const names = [ctx.targetName ?? '', 'target' in a ? a.target : ''].filter(Boolean).join(' / ');
      if (a.type !== 'right_click' && !(a.type === 'click_element' && a.op === 'right'))
        raise(wordsRisk(names, reasons));
      break;
    }
    case 'control': {
      const names = [a.name, ctx.targetName ?? ''].filter(Boolean).join(' / ');
      if (a.op === 'set') typing(a.text);
      else if (a.op !== 'right') raise(wordsRisk(names, reasons));
      break;
    }
    case 'set_value':
      typing(a.text);
      break;
    case 'type':
      typing(a.text);
      break;
    case 'key': {
      const k = a.keys.join('+');
      if (k === 'ctrl+alt+delete') raise('forbidden', 'it opens the secure desktop');
      else if (/^(?:shift\+delete|delete\+shift)$/.test(k)) raise('irreversible', 'it deletes permanently');
      else if (k === 'ctrl+enter' || k === 'alt+s') raise(maxRisk(enterRisk(ctx, reasons), 'confirm'), 'it may send');
      else if (k === 'enter') raise(enterRisk(ctx, reasons));
      else if (k === 'delete' && /\b(file explorer|explorer|this pc|downloads|documents|desktop)\b/i.test(window))
        raise('irreversible', 'it deletes files');
      else if (/^(?:ctrl\+w|ctrl\+q|alt\+f4|ctrl\+shift\+w)$/.test(k)) raise('confirm', 'it closes a window or tab');
      else if (/^win\+[rxl]$|^ctrl\+shift\+esc$/.test(k)) raise('confirm', 'it opens a system tool');
      if (SECURE_WINDOW.test(window) && /^(?:enter|tab|ctrl\+v)$/.test(k))
        raise('forbidden', 'it acts in a sign-in or security window');
      break;
    }
    case 'open':
      if (a.path) {
        if (isNetworkPath(a.path)) raise('forbidden', 'it opens a network path');
        else if (EXECUTABLE.test(a.path.trim().replace(/["']/g, ''))) raise('irreversible', 'it runs a program');
      }
      break;
    case 'move_files':
      if (isNetworkPath(a.from) || isNetworkPath(a.to)) raise('forbidden', 'it uses a network path');
      else raise('confirm', a.copy ? 'it copies files' : 'it moves files');
      break;
    case 'list_files':
      if (isNetworkPath(a.path)) raise('forbidden', 'it reads a network path');
      break;
    case 'close_window':
    case 'close_tab':
      raise('confirm', 'it closes a window or tab');
      break;
    case 'scroll':
    case 'wait':
    case 'drag':
    case 'note':
    case 'find_files':
    case 'save_sheet':
    case 'done':
    case 'fail':
      break;
    default:
      raise('confirm', 'an action Clicky does not know');
  }
  if (a.risky) raise('confirm', reasons.length ? undefined : 'Clicky marked it risky');
  return { level, reasons };
}

function quote(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? `${t.slice(0, max)}…` : t}"`;
}

/**
 * What the confirmation shows: built from the real action (exact text, keys, path, target and
 * window), never from the model's description of it.
 */
export function confirmText(a: AgentAction, ctx: RiskContext = {}): string {
  const where = ctx.window ? ` in ${quote(ctx.window, 60)}` : '';
  const on = (label: string): string => (label ? ` ${quote(label, 60)}` : '');
  switch (a.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${a.type === 'right_click' ? 'Right-click' : a.type === 'double_click' ? 'Double-click' : 'Click'}${on(ctx.targetName || a.target)}${where}`;
    case 'click_element':
      return `${a.op === 'right' ? 'Right-click' : a.op === 'double' ? 'Double-click' : 'Click'}${on(ctx.targetName || a.target)}${where}`;
    case 'control':
      return a.op === 'set' ? `Type ${quote(a.text, 200)} into${on(a.name)}${where}` : `Click${on(a.name)}${where}`;
    case 'set_value':
      return `Type ${quote(a.text, 200)} into${on(ctx.targetName || a.target)}${where}`;
    case 'type':
      return `Type ${quote(a.text, 200)}${where}`;
    case 'key':
      return `Press ${a.keys.map((k) => k.charAt(0).toUpperCase() + k.slice(1)).join('+')}${where}`;
    case 'open':
      return a.path ? `Open ${quote(a.path, 200)}` : a.url ? `Open ${quote(a.url, 200)}` : `Open ${quote(a.app, 80)}`;
    case 'move_files':
      return `${a.copy ? 'Copy' : 'Move'} ${quote(a.pattern, 60)} from ${quote(a.from, 120)} to ${quote(a.to, 120)}`;
    case 'close_window':
      return `Close the window ${quote(a.title, 100)}`;
    case 'close_tab':
      return `Close the tab ${quote(a.tab, 100)}`;
    default:
      return a.say || a.type;
  }
}

/**
 * A key for approvals: the same kind of step on the same target in the same window. Text and paths
 * are part of it, so allowing one message never allows a different one.
 */
export function approvalKey(a: AgentAction, ctx: RiskContext = {}): string {
  return `${confirmText(a, ctx).toLowerCase()}|${(ctx.window ?? '').toLowerCase()}`;
}
