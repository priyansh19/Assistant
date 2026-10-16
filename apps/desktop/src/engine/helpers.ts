import {
  clickyBriefing,
  clickyCopy,
  memoryNote,
  noteRefusal,
  routeToClicky,
  routineCopy,
  splitCadence,
  titleFor,
  type AgentTaskPlan,
  type ClickyAgent,
} from '@clicky/core';
import type { EngineConfig, EngineToMain } from '../shared/engine-protocol';

type HelperConfig = Pick<EngineConfig, 'clickys' | 'clickyWorkspaces' | 'routineTitles'>;

/**
 * Before an agent task: "ask Pitch Lab to draft the deck" runs as Pitch Lab (its job, notes and
 * folder in the briefing), and "every morning summarize my inbox" sets up a routine whose first run
 * is this one. Routine runs themselves never set up another repeat.
 */
export function planAgentTask(goal: string, cfg: HelperConfig, post: (m: EngineToMain) => void): AgentTaskPlan | null {
  const routed = routeToClicky(goal, cfg.clickys);
  const clicky: ClickyAgent | undefined = routed?.clicky;
  let task = routed?.task ?? goal;
  const plan: AgentTaskPlan = { goal: task };
  if (clicky) {
    if (clicky.archived) post({ type: 'clickyRestore', slug: clicky.slug });
    plan.helper = clicky.name;
    plan.briefing = clickyBriefing(clicky, cfg.clickyWorkspaces[clicky.slug] ?? `Documents\\Clicky\\${clicky.name}`);
  }
  if (!/^\[Routine "/.test(task)) {
    const repeat = splitCadence(task);
    if (repeat) {
      task = repeat.task;
      plan.goal = task;
      const title = titleFor(task);
      const owned = cfg.routineTitles[clicky?.slug ?? ''] ?? [];
      post({ type: 'routineCreate', title, task, cadence: repeat.cadence, ...(clicky ? { owner: clicky.slug } : {}) });
      plan.after = owned.some((t) => t.toLowerCase() === title.toLowerCase())
        ? routineCopy.noTwin(title)
        : routineCopy.confirm({ cadence: repeat.cadence });
    }
  }
  if (clicky?.archived) plan.after = [clickyCopy.restored(clicky.name), plan.after].filter(Boolean).join(' ');
  return clicky || plan.after ? plan : null;
}

/** "Pitch Lab, remember the deck uses our 2026 colours": a note for that helper, or null. */
export function helperNoteLine(question: string, cfg: HelperConfig, post: (m: EngineToMain) => void): string | null {
  const routed = routeToClicky(question, cfg.clickys);
  if (!routed) return null;
  const note = memoryNote(routed.task);
  if (!note) return null;
  const refused = noteRefusal(note);
  if (refused) return `I won't add that to ${routed.clicky.name}'s notes, because ${refused}.`;
  post({ type: 'clickyNote', slug: routed.clicky.slug, note });
  return `Got it. ${routed.clicky.name} will remember that.`;
}
