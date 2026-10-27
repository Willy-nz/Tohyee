import { describe, expect, it } from "vitest";
import { createFormMemory, emptyLink, formMemoryKey, linkAnchor, linkedRecord, needsDoing, readSafetyLink, safetyHref, type SafetyTodayData, unansweredQuestions } from "@/lib/safety/screens";

/** Safety on a farm phone (#446 layout follow-up, decisions 976-989). */

const params = (query: string) => new URLSearchParams(query);

describe("Safety addresses", () => {
  it("open the overview, a screen, a farm and one record", () => {
    expect(safetyHref()).toBe("/operations/farm/safety");
    expect(safetyHref({ farmId: "3" })).toBe("/operations/farm/safety?farm=3");
    expect(safetyHref({ farmId: "3", screen: "hazards", hazard: "12" })).toBe("/operations/farm/safety?farm=3&view=hazards&hazard=12");
    expect(readSafetyLink(params("farm=3&view=hazards&hazard=12"))).toEqual({ ...emptyLink(), screen: "hazards", farmId: "3", hazard: "12" });
  });

  it("round-trip every screen and record", () => {
    const link = { ...emptyLink(), screen: "reports" as const, farmId: "9", report: "4", action: "7" };
    expect(readSafetyLink(params(safetyHref(link).split("?")[1]))).toEqual(link);
  });

  it("take safety records' UUIDs", () => {
    const uuid = "4a42b2dc-26c3-4160-b43c-48376f88ede1";
    expect(readSafetyLink(params(`farm=1&view=hazards&hazard=${uuid}`)).hazard).toBe(uuid);
  });

  it("open a machine's check from its QR code without the overview", () => {
    expect(readSafetyLink(params("farm=3&equipment=21"))).toMatchObject({ screen: "equipment", farmId: "3", equipment: "21" });
  });

  it("ignore unknown screens and ids that aren't record ids", () => {
    expect(readSafetyLink(params("view=settings&hazard=abc&farm=-1&report=0"))).toEqual(emptyLink());
    expect(readSafetyLink(params("hazard=1%3Bdrop"))).toEqual(emptyLink());
  });

  it("only look for a linked record on the farm it was made for", () => {
    const link = readSafetyLink(params("farm=3&view=hazards&hazard=12"));
    expect(linkedRecord(link, "hazard", "3")).toBe("12");
    expect(linkedRecord(link, "hazard", "4")).toBeNull();
    expect(linkAnchor(link, "3")).toBe("safety-hazard-12");
    expect(linkAnchor(link, "4")).toBeNull();
    // An action on a report scrolls to the action inside the opened report.
    expect(linkAnchor(readSafetyLink(params("view=reports&report=4&action=7")), "3")).toBe("safety-action-7");
  });
});

const empty: SafetyTodayData = { myActions: [], overdueActions: [], actionsToCheck: [], outOfUse: [], toSign: [], training: [], selfDeclaredOnSite: [], reviewsDue: [], importantHazards: [], notCheckedToday: [] };

describe("Needs doing", () => {
  it("is empty when Today has nothing", () => {
    expect(needsDoing(empty, "3")).toEqual([]);
  });

  it("puts machines out of use, overdue jobs and inductions to sign first, and links each to its record on the farm", () => {
    const items = needsDoing(
      {
        ...empty,
        myActions: [
          { id: "50", title: "Fix the yard rail", due: "2026-11-02", state: "open", reportId: "40", hazardId: null },
          { id: "51", title: "Fence the pond", due: "2026-10-01", state: "overdue", reportId: null, hazardId: "30" },
        ],
        overdueActions: [
          { id: "51", title: "Fence the pond", due: "2026-10-01", reportId: null, hazardId: "30" },
          { id: "52", title: "Mend the race", due: "2026-10-02", reportId: "41", hazardId: null },
        ],
        actionsToCheck: [{ id: "53", title: "New gate latch", reportId: "42", hazardId: null }],
        outOfUse: [{ id: "21", name: "Quad" }],
        toSign: [{ id: "60", title: "Farm induction", reason: "Not signed yet." }],
        training: [
          { id: "70", who: "Hemi", what: "First aid", expiresOn: "2026-11-20", state: "expiring" },
          { id: "71", who: "Hemi", what: "Quad", expiresOn: "2026-10-01", state: "expired" },
        ],
        reviewsDue: [{ id: "30", title: "Effluent pond", reviewDue: "2026-10-01" }],
        selfDeclaredOnSite: [{ id: "80", name: "Sam", company: "Fencing Co" }],
      },
      "3",
    );
    expect(items.map((item) => [item.badge, item.text])).toEqual([
      ["Out of use", "Quad: don't use it"],
      ["Overdue", "Fence the pond"],
      ["Sign", "Farm induction"],
      ["Yours", "Fix the yard rail"],
      ["Overdue", "Mend the race"],
      ["To check", "New gate latch"],
      ["Expired", "Hemi: Quad"],
      ["Renew", "Hemi: First aid"],
      ["Review", "Effluent pond"],
      ["On site", "Sam (Fencing Co)"],
    ]);
    expect(items.map((item) => item.href)).toEqual([
      "/operations/farm/safety?farm=3&view=equipment&equipment=21",
      "/operations/farm/safety?farm=3&view=reports&action=51",
      "/operations/farm/safety?farm=3&view=people&induction=60",
      "/operations/farm/safety?farm=3&view=reports&report=40&action=50",
      "/operations/farm/safety?farm=3&view=reports&report=41&action=52",
      "/operations/farm/safety?farm=3&view=reports&report=42&action=53",
      "/operations/farm/safety?farm=3&view=people&training=71",
      "/operations/farm/safety?farm=3&view=people&training=70",
      "/operations/farm/safety?farm=3&view=hazards&hazard=30",
      "/operations/farm/safety?farm=3&view=people&visit=80",
    ]);
    expect(items[1].note).toBe("was due 1 Oct 2026");
    // Every item has a word, not just a colour.
    for (const item of items) expect(item.badge).toMatch(/\w/);
  });
});

describe("half-filled reports kept while moving around Safety", () => {
  const store = () => {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
  };

  it("are kept per person, organisation and farm", () => {
    expect(formMemoryKey({ userId: "u1", organisationId: "o1", farmId: "3", form: "report.hazard" })).toBe("tohyee.safety.form.u1.o1.3.report.hazard");
    expect(formMemoryKey({ userId: "u1", organisationId: "o1", farmId: "4", form: "report.hazard" })).not.toBe(formMemoryKey({ userId: "u1", organisationId: "o1", farmId: "3", form: "report.hazard" }));
  });

  it("say they were kept only when the browser kept them", () => {
    const kept = store();
    const memory = createFormMemory(() => kept);
    expect(memory.write("k", { title: "Broken rail" })).toBe(true);
    expect(memory.read("k")).toEqual({ title: "Broken rail" });
    memory.clear("k");
    expect(memory.read("k")).toBeNull();
  });

  it("say so truthfully when storage is full, blocked or missing", () => {
    const full = createFormMemory(() => ({ ...store(), setItem: () => { throw new Error("QuotaExceededError"); } }));
    expect(full.write("k", { title: "x" })).toBe(false);
    const ignored = createFormMemory(() => ({ ...store(), setItem: () => undefined }));
    expect(ignored.write("k", { title: "x" })).toBe(false);
    const blocked = createFormMemory(() => { throw new Error("SecurityError"); });
    expect(blocked.write("k", { title: "x" })).toBe(false);
    expect(blocked.read("k")).toBeNull();
    expect(() => blocked.clear("k")).not.toThrow();
    expect(createFormMemory(() => null).write("k", 1)).toBe(false);
  });

  it("read a damaged copy as nothing", () => {
    const memory = createFormMemory(() => ({ ...store(), getItem: () => "{not json" }));
    expect(memory.read("k")).toBeNull();
  });
});

describe("WorkSafe's questions", () => {
  it("count unanswered questions; a No is an answer, a blank isn't", () => {
    const keys = ["death", "hospital", "seriousInjury", "dangerousIncident"];
    expect(unansweredQuestions(keys, {})).toBe(4);
    expect(unansweredQuestions(keys, { death: false, hospital: true })).toBe(2);
  });
});
