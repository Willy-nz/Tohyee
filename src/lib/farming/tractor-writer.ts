import type { TrackPoint } from "@/lib/farming/coverage";
import type { LocalJob } from "@/lib/farming/tractor-store";

/*
 * Keeping a tractor job on the device while it's recorded (#480, decision
 * 1057). Every GPS fix, width change and event waits here until the
 * device's storage has it. Each write is the job as it is now plus every
 * fix not yet kept, from the first one missing, so a write the device
 * refused is tried again, in order, by the next one: the track on the
 * device is always the recorded track, or the start of it, never one with
 * a stretch missing. The warning is cleared only once everything recorded
 * is kept, not just the latest write.
 *
 * If Tohyee closes while some fixes still aren't kept, a small note (in
 * the browser's other storage, when it has room) says from which fix and
 * when; reopening the job records the gap as an event and says so
 * (`unsavedGap`), rather than joining the track across it.
 *
 * Pure apart from what it's given: tests/unit/farm-tractor-writer.test.ts.
 */

/** Writes the job and `points` from `job.pointCount` on, in one go (tractor-store's saveLocal). */
export type TrackSave = (job: LocalJob, points: TrackPoint[]) => Promise<LocalJob>;

export type WriterStatus = {
  /** Fixes recorded but not yet kept on the device. */
  unsavedFixes: number;
  /** The job's own details (width, events, Working ON/OFF) changed since it was last kept. */
  unsavedChanges: boolean;
  /** The device's last refusal in words; null once everything is kept. */
  problem: string | null;
  /** When the first fix not kept was recorded (ms), or null. */
  since: number | null;
  /** Fixes kept on the device. */
  kept: number;
};

/** Where a note of fixes not kept is left, in case Tohyee closes before they are. */
export type GapNotes = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type GapNote = { jobId: string; from: number; since: number };

const NOTE_PREFIX = "tohyee.tractor.unsaved.";

function safeNotes(): GapNotes | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The note left for a job whose fixes weren't all kept when Tohyee closed, if any. */
export function readGapNote(jobId: string, notes: GapNotes | null = safeNotes()): GapNote | null {
  try {
    const text = notes?.getItem(NOTE_PREFIX + jobId);
    if (!text) return null;
    const note = JSON.parse(text) as GapNote;
    return note && note.jobId === jobId && Number.isInteger(note.from) && Number.isFinite(note.since) ? note : null;
  } catch {
    return null;
  }
}

export function clearGapNote(jobId: string, notes: GapNotes | null = safeNotes()): void {
  try {
    notes?.removeItem(NOTE_PREFIX + jobId);
  } catch {
    // fine
  }
}

/**
 * On reopening a job: whether fixes were lost when Tohyee closed (the note
 * says fixes from `from` weren't kept, and the device has no more than
 * that). Null when nothing was lost.
 */
export function unsavedGap(note: GapNote | null, keptPoints: number): { from: number; since: number } | null {
  if (!note || keptPoints > note.from) return null;
  return { from: note.from, since: note.since };
}

export type TrackWriter = {
  /** The job as it is now, and any new fixes. Kept as soon as the device allows. */
  push(job: LocalJob, points?: TrackPoint[]): void;
  /** Writes everything waiting. True once the device has all of it. */
  flush(): Promise<boolean>;
  status(): WriterStatus;
  /** Stops retrying (the screen closed). */
  stop(): void;
};

export function trackWriter(options: {
  save: TrackSave;
  /** The job as it was last kept: its pointCount is how many fixes the device has. */
  initial: LocalJob;
  onChange?: (status: WriterStatus) => void;
  /** How long to wait before trying a refused write again (ms). */
  retryMs?: number;
  now?: () => number;
  notes?: GapNotes | null;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): TrackWriter {
  const now = options.now ?? (() => Date.now());
  const notes = options.notes === undefined ? safeNotes() : options.notes;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const retryMs = options.retryMs ?? 5000;
  let latest: LocalJob = options.initial;
  let kept = options.initial.pointCount;
  const pending: TrackPoint[] = [];
  let dirty = false;
  let problem: string | null = null;
  let since: number | null = null;
  let running: Promise<boolean> | null = null;
  let again = false;
  let timer: unknown = null;
  let stopped = false;

  const status = (): WriterStatus => ({ unsavedFixes: pending.length, unsavedChanges: dirty, problem, since, kept });
  const changed = () => options.onChange?.(status());

  function leaveNote() {
    try {
      notes?.setItem(NOTE_PREFIX + latest.id, JSON.stringify({ jobId: latest.id, from: kept, since: since ?? now() } satisfies GapNote));
    } catch {
      // The browser's storage is full too: the warning on screen still says so.
    }
  }

  async function drain(): Promise<boolean> {
    while (dirty || pending.length) {
      const job = latest;
      const points = pending.slice();
      try {
        await options.save({ ...job, pointCount: kept }, points);
      } catch (error) {
        problem = error instanceof Error && error.message ? error.message : "The device's storage refused it.";
        since ??= pending[0]?.t ?? now();
        leaveNote();
        changed();
        if (!stopped && timer === null) {
          timer = setTimer(() => {
            timer = null;
            void writer.flush();
          }, retryMs);
        }
        return false;
      }
      kept += points.length;
      pending.splice(0, points.length);
      if (latest === job) dirty = false;
    }
    if (problem !== null || since !== null) clearGapNote(latest.id, notes);
    problem = null;
    since = null;
    changed();
    return true;
  }

  const writer: TrackWriter = {
    push(job, points = []) {
      latest = job;
      dirty = true;
      pending.push(...points);
      void writer.flush();
    },
    flush() {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        let ok = await drain();
        while (ok && again) {
          again = false;
          ok = await drain();
        }
        again = false;
        running = null;
        return ok;
      })();
      return running;
    },
    status,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
  return writer;
}
