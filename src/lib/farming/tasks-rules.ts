import { REPEAT_LABELS, repeatDates, type Repeat } from "@/lib/farming/calendar-shared";

/*
 * Farm team tasks' rules (decisions 1457-1461; examples FT1-FT8, not yet
 * reviewed). Pure and browser-safe. Tested in tests/unit/farm-tasks.test.ts.
 *
 * - A task is due on a day. A repeating task (every week, 2 weeks, 4 weeks
 *   or month, as the farm calendar repeats) is due on each of its dates.
 * - Marking it done records who and when for the date it was due. A
 *   repeating task then moves to its next date after that one; the dates it
 *   missed before the one done aren't owed. Undoing the latest done puts it
 *   back.
 * - A task not done by its day is overdue, from the day after.
 */

export type TaskTiming = { dueOn: string; repeat: Repeat | null };

/** The day after `date`. */
export function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The first date on or after `from` the task is due, or null (a one-off already past). */
export function dueOnOrAfter(task: TaskTiming, from: string): string | null {
  if (!task.repeat) return task.dueOn >= from ? task.dueOn : null;
  if (from <= task.dueOn) return task.dueOn;
  // Look a year and a bit ahead: every repeat has a date in that time.
  const ahead = new Date(Date.parse(`${from}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
  return repeatDates(task.dueOn, task.repeat, null, [], from, ahead)[0] ?? null;
}

/**
 * When the task is next due, given the latest date it was done for: its
 * first date for a new task, the next date after the one done for a
 * repeating task, and null for a one-off that's done.
 */
export function nextDue(task: TaskTiming, lastDoneFor: string | null): string | null {
  if (lastDoneFor === null) return task.dueOn;
  if (!task.repeat) return null;
  return dueOnOrAfter(task, nextDay(lastDoneFor));
}

export type TaskState = "overdue" | "today" | "soon" | "later" | "done";

/** How a task stands today: done (a one-off), overdue, due today, in the next 7 days, or later. */
export function taskState(next: string | null, today: string): TaskState {
  if (next === null) return "done";
  if (next < today) return "overdue";
  if (next === today) return "today";
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  return next <= week ? "soon" : "later";
}

export const TASK_STATE_LABELS: Record<TaskState, string> = { overdue: "Overdue", today: "Due today", soon: "This week", later: "Later", done: "Done" };

/** The task's dates from `from` to `to`, for the calendar: a repeat's dates from its next one, a one-off's day if not done. */
export function taskDates(task: TaskTiming, next: string | null, from: string, to: string): string[] {
  if (next === null) return [];
  if (!task.repeat) return next >= from && next <= to ? [next] : [];
  return repeatDates(task.dueOn, task.repeat, null, [], next > from ? next : from, to);
}

export function repeatText(repeat: Repeat | null): string {
  return repeat ? REPEAT_LABELS[repeat] : "Once";
}
