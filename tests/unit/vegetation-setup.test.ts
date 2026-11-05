import { describe, expect, it } from "vitest";
import { canGoOn, furthestStep, nextStep, previousStep, resumeStep, SETUP_STEPS, stepNumber } from "@/lib/farming/vegetation/setup-steps";

/* The guided satellite vegetation setup (#612, decision 1539): one thing a screen, carrying on where you stopped. */
describe("satellite vegetation setup steps", () => {
  const none = { connected: false, farmOn: false, tested: false, enabled: false };
  it("starts with what you'll need and ends with what happens next", () => {
    expect(SETUP_STEPS.map((step) => step.key)).toEqual(["need", "explain", "account", "client", "connect", "farm", "test", "budget", "on", "done"]);
    expect(resumeStep(null, none)).toBe("need");
  });
  it("carries on from the saved step, but never past what's done", () => {
    expect(resumeStep("client", none)).toBe("client");
    expect(resumeStep("budget", none)).toBe("connect");
    expect(resumeStep("budget", { ...none, connected: true, farmOn: true, tested: true })).toBe("budget");
    expect(resumeStep(null, { ...none, connected: true })).toBe("farm");
    expect(resumeStep(null, { connected: true, farmOn: true, tested: true, enabled: true })).toBe("done");
    expect(resumeStep("nonsense", none)).toBe("need");
  });
  it("a step that does something must be done before Next", () => {
    expect(canGoOn("need", none)).toBe(true);
    expect(canGoOn("connect", none)).toBe(false);
    expect(canGoOn("connect", { ...none, connected: true })).toBe(true);
    expect(canGoOn("test", { ...none, connected: true, farmOn: true })).toBe(false);
    expect(furthestStep({ connected: true, farmOn: true, tested: true, enabled: false })).toBe("on");
  });
  it("moves one step at a time and numbers them", () => {
    expect(nextStep("need")).toBe("explain");
    expect(previousStep("need")).toBe("need");
    expect(nextStep("done")).toBe("done");
    expect(stepNumber("connect")).toBe(5);
  });
});
