/**
 * Undo and Redo while a report is being changed (#387, decision 691).
 *
 * The history lives in the browser tab for this editing session only: it's
 * not version history (nothing is kept on the server), and it doesn't undo a
 * save. Undoing after a save just makes the report's draft differ from what's
 * saved again, so Save puts the undone version back.
 */

export const MAX_UNDO = 50;

type Entry<T> = { state: T; label: string };

export type EditHistory<T> = {
  present: T;
  past: Entry<T>[];
  future: Entry<T>[];
  /**
   * Changes with the same key in a row (typing in the name, say) are one
   * step, so Undo doesn't go back a letter at a time.
   */
  lastKey: string | null;
};

export function startHistory<T>(state: T): EditHistory<T> {
  return { present: state, past: [], future: [], lastKey: null };
}

/** A change: the present goes on the Undo list (named, e.g. "remove Sales by month") and Redo is cleared. */
export function recordChange<T>(history: EditHistory<T>, next: T, label: string, key?: string): EditHistory<T> {
  if (next === history.present) return history;
  if (key && history.lastKey === key && history.past.length > 0) {
    return { ...history, present: next, future: [] };
  }
  const past = [...history.past, { state: history.present, label }].slice(-MAX_UNDO);
  return { present: next, past, future: [], lastKey: key ?? null };
}

export function undo<T>(history: EditHistory<T>): EditHistory<T> {
  const entry = history.past.at(-1);
  if (!entry) return history;
  return {
    present: entry.state,
    past: history.past.slice(0, -1),
    future: [...history.future, { state: history.present, label: entry.label }],
    lastKey: null,
  };
}

export function redo<T>(history: EditHistory<T>): EditHistory<T> {
  const entry = history.future.at(-1);
  if (!entry) return history;
  return {
    present: entry.state,
    past: [...history.past, { state: history.present, label: entry.label }].slice(-MAX_UNDO),
    future: history.future.slice(0, -1),
    lastKey: null,
  };
}

/** What Undo would undo, e.g. "remove Sales by month"; null when there's nothing. */
export function undoLabel<T>(history: EditHistory<T>): string | null {
  return history.past.at(-1)?.label ?? null;
}

export function redoLabel<T>(history: EditHistory<T>): string | null {
  return history.future.at(-1)?.label ?? null;
}

/**
 * Puts the server's copy in place of the present without a new Undo step
 * (after a save, the server may have tidied the definition: trimmed names,
 * new ids for copies). Only when the present is still what was sent, so
 * changes made while the save was on its way aren't lost.
 */
export function replaceSaved<T>(history: EditHistory<T>, sent: T, saved: T): EditHistory<T> {
  if (history.present !== sent) return history;
  return { ...history, present: saved, lastKey: null };
}

/** The parts of a report a save changes; anything else (who saved it, when, its version) isn't a change. */
type Definition = { name: string; description: string | null; settings: unknown; tiles: unknown };

/** Object keys in order, so the same definition always reads the same. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

/** True when the draft has changes that aren't saved. */
export function hasUnsavedChanges(saved: Definition, draft: Definition): boolean {
  const pick = (report: Definition) => JSON.stringify(stable({ name: report.name, description: report.description || null, settings: report.settings, tiles: report.tiles }));
  return pick(saved) !== pick(draft);
}

/** "Sales" -> "Sales (copy)", kept within the 100 characters a report name can have. */
export function copyName(name: string): string {
  const suffix = " (copy)";
  return `${name.trim().slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}
