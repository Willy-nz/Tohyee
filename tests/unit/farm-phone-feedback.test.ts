import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRACTOR_LIMITED, tractorLimitedText } from "@/lib/farming/tractor-shared";

/*
 * From Jess and William's phone use (#498 items 4 and 8, decisions 1119
 * and 1124): no large Call 111 button on the Safety page, and tractor
 * mode says it's limited before Start and beside its controls.
 */
const source = (file: string) => readFileSync(new URL(`../../src/components/${file}`, import.meta.url), "utf8");

describe("Safety's emergency details (#498 item 4)", () => {
  const tab = source("farm-safety-tab.tsx");
  const strip = tab.slice(tab.indexOf("function EmergencyStrip"), tab.indexOf("// Needs doing"));
  it("has no big Call 111 button, but keeps 111 as a link inside a labelled Emergency details area", () => {
    expect(strip).not.toMatch(/>\s*Call 111\s*</);
    expect(strip).not.toContain("styles.call");
    expect(strip).toContain('href="tel:111"');
    expect(strip).toMatch(/>\s*Emergency details\s*</);
    expect(strip).toContain("contacts");
  });
});

describe("tractor mode is labelled limited (#498 item 8)", () => {
  it("uses the issue's exact words", () => {
    expect(TRACTOR_LIMITED).toBe("Limited — keep Tohyee open and your screen unlocked while recording. Locking your phone or switching apps may interrupt GPS and leave gaps in your track.");
  });
  it("shows them before Start and beside the recording controls", () => {
    const tractor = source("tractor.tsx");
    const setup = tractor.slice(tractor.indexOf("function TractorSetup"), tractor.indexOf("function EquipmentSettingsForm"));
    // Through <LimitedNote />: the browser's "Limited" words, or the Android app's (#502).
    expect(setup.indexOf("<LimitedNote />")).toBeGreaterThan(-1);
    expect(setup.indexOf("<LimitedNote />")).toBeLessThan(setup.indexOf("onClick={start}"));
    const drive = tractor.slice(tractor.indexOf("function TractorDrive"), tractor.indexOf("function DriveLocationHelp"));
    expect(drive.indexOf("<LimitedNote />")).toBeGreaterThan(drive.indexOf("Finish"));
    expect(tractor.slice(tractor.indexOf("export function TractorHome"), tractor.indexOf("function TractorSetup"))).toContain("<LimitedNote />");
    expect(tractorLimitedText(false)).toContain(TRACTOR_LIMITED);
  });
});
