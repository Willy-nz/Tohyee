/*
 * The guided setup's steps (#612, decision 1539): one thing a screen, in
 * order, with where to carry on from. Browser-safe and pure; tested in
 * tests/unit/vegetation-setup.test.ts.
 */

export type SetupStep = "need" | "explain" | "account" | "client" | "connect" | "farm" | "test" | "budget" | "on" | "done";

export const SETUP_STEPS: Array<{ key: SetupStep; title: string }> = [
  { key: "need", title: "What you'll need" },
  { key: "explain", title: "What it shows" },
  { key: "account", title: "Make a free Copernicus account" },
  { key: "client", title: "Make the key Tohyee uses" },
  { key: "connect", title: "Paste it in and test it" },
  { key: "farm", title: "Choose a farm and check its paddocks" },
  { key: "test", title: "Test one farm" },
  { key: "budget", title: "Set a budget" },
  { key: "on", title: "Turn it on" },
  { key: "done", title: "Done" },
];

/** What the server says is done, which decides how far someone can be. */
export type SetupProgress = { connected: boolean; farmOn: boolean; tested: boolean; enabled: boolean };

/** The furthest step that's open: you can't be past "connect" without a connection, and so on. */
export function furthestStep(progress: SetupProgress): SetupStep {
  if (!progress.connected) return "connect";
  if (!progress.farmOn) return "farm";
  if (!progress.tested) return "test";
  if (!progress.enabled) return "on";
  return "done";
}

function index(step: SetupStep): number {
  return SETUP_STEPS.findIndex((entry) => entry.key === step);
}

/**
 * Where to carry on (decision 1539): the step saved on this device, no
 * further than the server allows; with nothing saved, the first step not
 * done yet (the start for someone new).
 */
export function resumeStep(saved: string | null, progress: SetupProgress): SetupStep {
  const furthest = furthestStep(progress);
  const known = SETUP_STEPS.find((entry) => entry.key === saved)?.key ?? null;
  if (progress.enabled && (known === null || known === "done")) return "done";
  if (known === null) return progress.connected ? furthest : "need";
  return index(known) > index(furthest) ? furthest : known;
}

export function nextStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.min(SETUP_STEPS.length - 1, index(step) + 1)].key;
}

export function previousStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.max(0, index(step) - 1)].key;
}

export function stepNumber(step: SetupStep): number {
  return index(step) + 1;
}

/** Whether Next is open from this step (a step that does something needs it done first). */
export function canGoOn(step: SetupStep, progress: SetupProgress): boolean {
  if (step === "connect") return progress.connected;
  if (step === "farm") return progress.farmOn;
  if (step === "test") return progress.tested;
  if (step === "on") return progress.enabled;
  return step !== "done";
}
