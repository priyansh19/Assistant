/**
 * Streaming plan reader. The agent's plan is one JSON object
 * `{"understood": "…", "done_when": {…}, "steps": [ {…}, {…} ]}` written token by token. Waiting
 * for the whole reply before acting costs the time to write every step; this reader hands out
 * each step the moment its closing brace arrives, so Clicky starts on step one while the model is
 * still writing the rest.
 *
 * It only finds boundaries (it never evaluates JSON): every raw slice it returns is complete and
 * goes through JSON.parse and the usual step checks by the caller. Text before the first `{`
 * (a code fence, a sentence) and after the object closes is ignored.
 */

export type PlanStreamEvent =
  /** A top-level member whose value is a string, object or array (raw JSON of the value). */
  | { type: 'member'; key: string; raw: string }
  /** One element of the "steps" (or "plan") array that is an object (raw JSON). */
  | { type: 'step'; raw: string };

/** Keys whose array holds the steps, as parsePlan accepts them. */
const STEP_KEYS = new Set(['steps', 'plan']);

export class PlanStream {
  private text = '';
  /** Next character to scan. */
  private at = 0;
  /** Nesting depth of {} and []; 1 inside the top-level object. */
  private depth = 0;
  private started = false;
  private ended = false;
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  /** The last string closed at depth 1: a key if a colon follows. */
  private lastString: string | null = null;
  /** The key whose value comes next (after its colon), or is being read. */
  private key: string | null = null;
  /** Where the current top-level value starts. */
  private valueStart = -1;
  /** Depth of the steps array while inside it. */
  private stepsDepth = -1;
  private stepsSeen = false;
  private elementStart = -1;

  /** Feed the next chunk. Returns the members and steps it completes. */
  push(chunk: string): PlanStreamEvent[] {
    this.text += chunk;
    const events: PlanStreamEvent[] = [];
    for (; this.at < this.text.length && !this.ended; this.at++) this.scan(this.text[this.at] ?? '', events);
    return events;
  }

  /** The whole reply so far. */
  get reply(): string {
    return this.text;
  }

  private scan(c: string, events: PlanStreamEvent[]): void {
    const i = this.at;
    if (!this.started) {
      if (c === '{') {
        this.started = true;
        this.depth = 1;
      }
      return;
    }
    if (this.inString) {
      if (this.escaped) this.escaped = false;
      else if (c === '\\') this.escaped = true;
      else if (c === '"') {
        this.inString = false;
        if (this.depth === 1) {
          if (this.valueStart >= 0 && this.key !== null) {
            events.push({ type: 'member', key: this.key, raw: this.text.slice(this.valueStart, i + 1) });
            this.valueStart = -1;
            this.key = null;
          } else {
            this.lastString = unquote(this.text.slice(this.stringStart, i + 1));
          }
        }
      }
      return;
    }
    switch (c) {
      case '"':
        this.inString = true;
        this.stringStart = i;
        if (this.depth === 1 && this.key !== null && this.valueStart < 0) this.valueStart = i;
        return;
      case ':':
        if (this.depth === 1) {
          this.key = this.lastString;
          this.lastString = null;
          this.valueStart = -1;
        }
        return;
      case ',':
        if (this.depth === 1) {
          this.key = null;
          this.lastString = null;
          this.valueStart = -1;
        }
        return;
      case '{':
      case '[':
        if (this.depth === 1 && this.key !== null && this.valueStart < 0) {
          this.valueStart = i;
          if (c === '[' && !this.stepsSeen && STEP_KEYS.has(this.key)) {
            this.stepsSeen = true;
            this.stepsDepth = 2;
          }
        }
        this.depth++;
        if (c === '{' && this.stepsDepth > 0 && this.depth === this.stepsDepth + 1) this.elementStart = i;
        return;
      case '}':
      case ']':
        if (c === '}' && this.stepsDepth > 0 && this.depth === this.stepsDepth + 1 && this.elementStart >= 0) {
          events.push({ type: 'step', raw: this.text.slice(this.elementStart, i + 1) });
          this.elementStart = -1;
        }
        if (c === ']' && this.depth === this.stepsDepth) this.stepsDepth = -1;
        this.depth--;
        if (this.depth === 1 && this.valueStart >= 0 && this.key !== null) {
          events.push({ type: 'member', key: this.key, raw: this.text.slice(this.valueStart, i + 1) });
          this.valueStart = -1;
          this.key = null;
        }
        if (this.depth <= 0) this.ended = true;
        return;
      default:
        return;
    }
  }
}

function unquote(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
