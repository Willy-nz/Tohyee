import { describe, expect, it } from "vitest";
import { effluentHref, readEffluentLink } from "@/lib/effluent/screens";
import { activeConsent, bufferFor, bufferRing, CONSENT_TEMPLATES, SETTINGS_FOR, STARTING_CHECKLISTS, SYSTEM_TYPES } from "@/lib/effluent/shared";

/** Effluent's pure setup rules (#487, decisions 1070-1079). */
describe("effluent setup rules", () => {
  it("templates point to their sources and leave the limits to the consent", () => {
    for (const template of Object.values(CONSENT_TEMPLATES)) {
      expect(template.sources.length).toBeGreaterThan(0);
      for (const source of template.sources) expect(source.url).toMatch(/^https:\/\/(www\.)?(orc|es)\.govt\.nz\//);
      expect(template.fromYourConsent).toEqual(expect.arrayContaining(["maxDepthMm", "maxRateMmPerHour", "returnPeriodDays", "expiresOn", "consentNumber"]));
      expect(template.notifyCouncil.phone).toMatch(/^0800 /);
    }
    expect(bufferFor(CONSENT_TEMPLATES.orc, "waterway")).toBe("50");
    expect(bufferFor(CONSENT_TEMPLATES.es, "bore")).toBe("100");
    expect(bufferFor(null, "bore")).toBeNull();
    expect(bufferFor(CONSENT_TEMPLATES.orc, "boundary")).toBeNull();
  });

  it("every system type has settings and a starting checklist with critical items", () => {
    for (const type of SYSTEM_TYPES) {
      expect(SETTINGS_FOR[type].length).toBeGreaterThan(0);
      expect(STARTING_CHECKLISTS[type].some((item) => item.critical)).toBe(true);
    }
  });

  it("the consent in force is the latest not replaced or withdrawn", () => {
    const consent = (change: string, replaced: boolean, id: string) => ({ change, data: { replaced }, id });
    expect(activeConsent([consent("created", false, "a"), consent("updated", true, "b"), consent("withdrawn", false, "c")])?.id).toBe("a");
    expect(activeConsent([consent("created", true, "a")])).toBeNull();
    expect(activeConsent([])).toBeNull();
  });

  it("a buffer ring is a closed circle the right size", () => {
    const ring = bufferRing([170.5, -45.9], 50);
    expect(ring.length).toBe(37);
    expect(ring[0]).toEqual(ring[36]);
    // 50 m north is about 0.00045 degrees of latitude.
    const north = Math.max(...ring.map((point) => point[1]));
    expect(north + 45.9).toBeCloseTo(50 / 111_320, 5);
  });

  it("links open the screen and record on the farm they were made for, and ignore anything else", () => {
    const href = effluentHref({ farmId: "12", screen: "setup", record: "0F9A0B7E-6F9C-4C34-8F0C-3D5B1F4A2E11" });
    expect(href).toBe("/operations/farm/effluent?farm=12&view=setup&record=0F9A0B7E-6F9C-4C34-8F0C-3D5B1F4A2E11");
    expect(readEffluentLink(new URL(`http://x${href}`).searchParams)).toEqual({ screen: "setup", farmId: "12", record: "0f9a0b7e-6f9c-4c34-8f0c-3d5b1f4a2e11" });
    expect(readEffluentLink(new URLSearchParams("view=drop&farm=x&record=1"))).toEqual({ screen: null, farmId: null, record: null });
    expect(effluentHref()).toBe("/operations/farm/effluent");
  });
});
