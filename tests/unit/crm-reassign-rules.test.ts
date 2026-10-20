import { describe, expect, it } from "vitest";
import { checkReassignAllowed, kindsFor, REASSIGN_KINDS, type ReassignPreview, tickedIds } from "@/lib/crm/reassign-rules";

const admin = { role: "admin" as const, owners: null, canWrite: true };
const bookkeeper = { role: "bookkeeper" as const, owners: null, canWrite: true };
const viewer = { role: "viewer" as const, owners: null, canWrite: false };
const rep = { role: "sales_rep" as const, owners: ["rep"], canWrite: true };
const manager = { role: "sales_manager" as const, owners: ["manager", "rep", "rep2"], canWrite: true };

/** Decision 650: who may move records, and what moves from nobody. */
describe("bulk reassignment rules", () => {
  it("admins and bookkeepers move anyone's; viewers and reps can't", () => {
    expect(() => checkReassignAllowed(admin, "a", "b")).not.toThrow();
    expect(() => checkReassignAllowed(bookkeeper, null, "b")).not.toThrow();
    expect(() => checkReassignAllowed(viewer, "a", "b")).toThrow(/bookkeeper role/);
    expect(() => checkReassignAllowed(rep, "rep", "rep")).toThrow(/sales rep can't/);
  });

  it("a manager moves only between people in their teams", () => {
    expect(() => checkReassignAllowed(manager, "rep", "rep2")).not.toThrow();
    expect(() => checkReassignAllowed(manager, null, "rep")).not.toThrow();
    expect(() => checkReassignAllowed(manager, "rep", "outsider")).toThrow(/their teams/);
    expect(() => checkReassignAllowed(manager, "outsider", "rep")).toThrow(/their teams/);
  });

  it("refuses moving to the same person", () => {
    expect(() => checkReassignAllowed(admin, "a", "a")).toThrow(/different person/);
  });

  it("from nobody: never companies or sequences; a manager only leads", () => {
    expect(kindsFor(null, REASSIGN_KINDS, admin)).toEqual(["leads", "opportunities", "tasks"]);
    expect(kindsFor(null, REASSIGN_KINDS, manager)).toEqual(["leads"]);
    expect(kindsFor("rep", REASSIGN_KINDS, manager)).toEqual([...REASSIGN_KINDS]);
  });

  it("moves what's still ticked", () => {
    const preview: ReassignPreview = {
      fromUserId: "a",
      toUserId: "b",
      includeClosedDeals: false,
      more: [],
      records: {
        leads: [{ id: "1", name: "A", detail: null }, { id: "2", name: "B", detail: null }],
        companies: [{ id: "1", name: "Co", detail: null }],
        opportunities: [],
        tasks: [],
        sequences: [],
      },
    };
    expect(tickedIds(preview, new Set(["leads:2"]))).toEqual({ leads: ["1"], companies: ["1"], opportunities: [], tasks: [], sequences: [] });
  });
});
