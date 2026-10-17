import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, shell } from 'electron';
import {
  addNote,
  clickyCopy,
  clickyFolderName,
  clickyNameProblem,
  findTwin,
  newClicky,
  parseAgentsMd,
  renderAgentsMd,
  type ClickyAgent,
} from '@clicky/core';
import { log } from './log';

export type CreateResult = { ok: true; clicky: ClickyAgent } | { ok: false; reason: string; twin?: string };

/**
 * Named helpers (Clickys): the roster in userData/clickys.json, and each helper's folder in
 * Documents\Clicky\<Name> with AGENTS.md, output and tmp. AGENTS.md is the source of truth for
 * standing preferences and notes, so edits the user makes in it are read back before each use.
 */
export class ClickyStore {
  private readonly file = join(app.getPath('userData'), 'clickys.json');
  private readonly root = join(app.getPath('documents'), 'Clicky');
  private roster: ClickyAgent[] = [];
  private readonly listeners = new Set<() => void>();

  constructor() {
    try {
      if (existsSync(this.file)) {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw))
          this.roster = raw.filter(
            (c): c is ClickyAgent =>
              typeof c === 'object' && c !== null && typeof c.slug === 'string' && typeof c.name === 'string',
          );
      }
    } catch (e) {
      log.warn('clickys.json could not be read', String(e));
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The roster with each helper's notes and preferences as its AGENTS.md has them now. */
  list(): ClickyAgent[] {
    return this.roster.map((c) => this.withFile(c));
  }

  get(slug: string): ClickyAgent | undefined {
    const c = this.roster.find((x) => x.slug === slug);
    return c ? this.withFile(c) : undefined;
  }

  /** The helper's folder (Documents\Clicky\<Name>). */
  workspace(c: Pick<ClickyAgent, 'name' | 'slug'>): string {
    return join(this.root, clickyFolderName(c));
  }

  workspaces(): Record<string, string> {
    return Object.fromEntries(this.roster.map((c) => [c.slug, this.workspace(c)]));
  }

  /**
   * Make a helper. Nothing starts: it waits for the user to ask it for something. A helper whose
   * job an existing one already covers is refused unless `anyway` is set, so the user chooses.
   */
  create(input: { name: string; role?: string; purpose: string; anyway?: boolean }, userName?: string): CreateResult {
    const problem = clickyNameProblem(input.name, this.roster, userName);
    if (problem) return { ok: false, reason: problem };
    if (input.purpose.trim().length < 5) return { ok: false, reason: 'Say in one sentence what it does for you.' };
    if (!input.anyway) {
      const twin = findTwin(`${input.name} ${input.purpose}`, this.roster);
      if (twin) return { ok: false, reason: clickyCopy.twin(twin.name), twin: twin.slug };
    }
    const c = newClicky(input, this.roster, Date.now());
    try {
      const dir = this.workspace(c);
      mkdirSync(join(dir, 'output'), { recursive: true });
      mkdirSync(join(dir, 'tmp'), { recursive: true });
      const md = join(dir, 'AGENTS.md');
      if (!existsSync(md)) writeFileSync(md, renderAgentsMd(c));
    } catch (e) {
      log.warn('helper folder could not be made', String(e));
      return {
        ok: false,
        reason: "I couldn't make its folder in Documents\\Clicky. Check that Documents is writable.",
      };
    }
    this.roster.push(c);
    this.save();
    log.info(`helper made: ${c.name} (${c.slug})`);
    return { ok: true, clicky: c };
  }

  /** Archive or bring back. Archiving never deletes the folder or its files. */
  setArchived(slug: string, archived: boolean): void {
    const c = this.roster.find((x) => x.slug === slug);
    if (!c) return;
    if (archived) c.archived = true;
    else delete c.archived;
    this.save();
  }

  /** Remove from the roster; the folder and its files stay where they are. */
  remove(slug: string): void {
    this.roster = this.roster.filter((c) => c.slug !== slug);
    this.save();
  }

  /** Add a dated note to the helper's AGENTS.md. Returns the reason when it's refused. */
  note(slug: string, text: string): string | null {
    const c = this.get(slug);
    if (!c) return 'that helper no longer exists';
    const r = addNote(c.notes, text, new Date());
    if (!r.ok) return r.reason;
    this.writeFile({ ...c, notes: r.notes });
    return null;
  }

  openFolder(slug: string): void {
    const c = this.roster.find((x) => x.slug === slug);
    if (c) void shell.openPath(this.workspace(c));
  }

  private withFile(c: ClickyAgent): ClickyAgent {
    try {
      const md = join(this.workspace(c), 'AGENTS.md');
      if (!existsSync(md)) return c;
      const parsed = parseAgentsMd(readFileSync(md, 'utf8'), new Date());
      return { ...c, standing: parsed.standing, notes: parsed.notes };
    } catch {
      return c;
    }
  }

  private writeFile(c: ClickyAgent): void {
    try {
      const dir = this.workspace(c);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), renderAgentsMd(c));
    } catch (e) {
      log.warn('AGENTS.md could not be written', String(e));
    }
    this.emit();
  }

  private save(): void {
    try {
      // Notes and preferences live in each AGENTS.md, not here.
      writeFileSync(
        this.file,
        JSON.stringify(
          this.roster.map((c) => ({ ...c, standing: [], notes: [] })),
          null,
          1,
        ),
      );
    } catch (e) {
      log.warn('clickys.json could not be written', String(e));
    }
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
