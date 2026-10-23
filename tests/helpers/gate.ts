/*
 * For tests that interleave two things on separate database connections:
 * a gate one side waits at until the test opens it, and a check that a
 * promise is still waiting (blocked on a lock) after a short while.
 */

export type Gate = {
  /** Called by the code under test: says it has arrived, then waits until opened. Only the first call waits. */
  pause: () => Promise<void>;
  /** Resolves once `pause` has been reached. */
  reached: Promise<void>;
  open: () => void;
};

export function gate(): Gate {
  let open!: () => void;
  let arrived!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  let used = false;
  return {
    pause: async () => {
      if (used) return;
      used = true;
      arrived();
      await opened;
    },
    reached,
    open,
  };
}

/** True when `promise` hasn't settled after `ms` milliseconds. */
export async function stillWaiting(promise: Promise<unknown>, ms = 400): Promise<boolean> {
  const settled = promise.then(
    () => "settled",
    () => "settled",
  );
  return (await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve("waiting"), ms))])) === "waiting";
}
