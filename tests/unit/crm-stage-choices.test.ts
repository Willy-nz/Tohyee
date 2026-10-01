import { describe, expect, it } from "vitest";
import { stageChoices } from "@/components/crm";
import type { OpportunityStageSetup } from "@/lib/crm/forecast-figures";

/** Which stages an opportunity can be moved to on the board and forms (CRMS3, CRMS7). */

const stage = (key: string, type: OpportunityStageSetup["type"], isActive = true): OpportunityStageSetup => ({
  id: key,
  key,
  name: key[0].toUpperCase() + key.slice(1),
  sortOrder: 0,
  type,
  probability: type === "won" ? 100 : type === "lost" ? 0 : 10,
  forecastCategory: type === "won" ? "closed" : type === "lost" ? "omitted" : "pipeline",
  isActive,
  opportunityCount: 0,
});

describe("stage choices", () => {
  const stages = [stage("new", "open"), stage("screening", "open", false), stage("meeting", "open"), stage("proposal", "open"), stage("won", "won"), stage("lost", "lost")];
  const data = {
    stages,
    salesProcesses: [
      { recordTypeId: "1", recordTypeName: "Standard", isActive: true, stageKeys: null },
      { recordTypeId: "2", recordTypeName: "Grant application", isActive: true, stageKeys: ["new", "proposal", "won", "lost"] },
    ],
  };

  it("active stages, and an archived one only for an opportunity already in it", () => {
    expect(stageChoices(data, "1", "new").map((s) => s.key)).toEqual(["new", "meeting", "proposal", "won", "lost"]);
    expect(stageChoices(data, "1", "screening").map((s) => s.key)).toEqual(["new", "screening", "meeting", "proposal", "won", "lost"]);
  });

  it("only the record type's sales process, plus where it is now", () => {
    expect(stageChoices(data, "2", null).map((s) => s.key)).toEqual(["new", "proposal", "won", "lost"]);
    expect(stageChoices(data, "2", "meeting").map((s) => s.key)).toEqual(["new", "meeting", "proposal", "won", "lost"]);
    expect(stageChoices(undefined, "2", null)).toEqual([]);
  });
});
