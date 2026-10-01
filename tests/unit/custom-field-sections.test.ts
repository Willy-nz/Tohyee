import { describe, expect, it } from "vitest";
import {
  contactUses,
  type CustomField,
  type CustomFieldSection,
  defaultValues,
  fieldsFor,
  groupBySection,
  isSwitchedOn,
  listColumnsFor,
} from "@/lib/custom-fields/values";

function field(id: string, overrides: Partial<CustomField>): CustomField {
  return {
    id,
    record: "opportunity",
    label: `Field ${id}`,
    help: null,
    type: "text",
    usedOn: ["opportunity"],
    isRequired: false,
    defaultValue: null,
    showInList: false,
    isActive: true,
    sortOrder: Number(id),
    sectionId: null,
    options: [],
    ...overrides,
  };
}

const crmOnly = { advancedFeatures: false, crmEnabled: true };
const reportingOnly = { advancedFeatures: true, crmEnabled: false };

/** Examples CRMF1, CRMF6 and CRMF8 in docs/ACCOUNTING-EXAMPLES.md (not yet approved): the parts screens use. */
describe("custom fields on CRM records", () => {
  it("CRMF1, CRMF8: CRM uses need the CRM, the rest need Advanced reporting", () => {
    for (const use of ["prospect", "person", "opportunity"] as const) {
      expect([isSwitchedOn(crmOnly, use), isSwitchedOn(reportingOnly, use)]).toEqual([true, false]);
    }
    for (const use of ["customer", "supplier", "invoice", "journal"] as const) {
      expect([isSwitchedOn(crmOnly, use), isSwitchedOn(reportingOnly, use)]).toEqual([false, true]);
    }
    expect(contactUses({ isCustomer: false, isSupplier: false, isProspect: true })).toEqual(["prospect"]);
    expect(contactUses({ isCustomer: true, isSupplier: true, isProspect: true })).toEqual(["customer", "supplier", "prospect"]);

    const practiceSize = field("1", { record: "contact", usedOn: ["prospect"], showInList: true, defaultValue: "5" });
    const petName = field("2", { record: "contact", usedOn: ["customer"], showInList: true, defaultValue: "Rex" });
    const both = field("3", { record: "contact", usedOn: ["customer", "prospect"] });
    const fields = [practiceSize, petName, both];
    const kobe = contactUses({ isCustomer: true, isSupplier: false, isProspect: true });
    // CRM on, Advanced reporting off: a customer and prospect gets the prospect fields only.
    expect(fieldsFor(fields, "contact", kobe, {}, crmOnly).map((f) => f.id)).toEqual(["1", "3"]);
    expect(defaultValues(fields, "contact", kobe, crmOnly)).toEqual({ "1": "5" });
    expect(listColumnsFor(fields, "contact", kobe, crmOnly).map((f) => f.id)).toEqual(["1"]);
    // A value the record already has still shows (CRMF8).
    expect(fieldsFor(fields, "contact", kobe, { "2": "Rex" }, crmOnly).map((f) => f.id)).toEqual(["1", "2", "3"]);
    // Without switches it's as before: every field for the uses.
    expect(fieldsFor(fields, "contact", kobe).map((f) => f.id)).toEqual(["1", "2", "3"]);
  });

  it("CRMF6: fields with no section first, then each section with fields, in order", () => {
    const sections: CustomFieldSection[] = [
      { id: "10", record: "opportunity", name: "Marketing", sortOrder: 2 },
      { id: "11", record: "opportunity", name: "Preferences", sortOrder: 3 },
      { id: "12", record: "opportunity", name: "Admin only", sortOrder: 1 },
      { id: "13", record: "person", name: "Personal", sortOrder: 1 },
    ];
    const leadSource = field("1", { label: "Lead source", sectionId: "10", sortOrder: 5 });
    const discount = field("2", { label: "Discount offered", sectionId: "10", sortOrder: 4 });
    const sampleKit = field("3", { label: "Sample kit sent", sortOrder: 6 });
    const owner = field("4", { label: "Budget holder", sectionId: "12", sortOrder: 7 });
    const groups = groupBySection([leadSource, discount, sampleKit, owner], sections);
    expect(groups.map((group) => [group.section?.name ?? null, group.fields.map((f) => f.label)])).toEqual([
      [null, ["Sample kit sent"]],
      ["Admin only", ["Budget holder"]],
      ["Marketing", ["Discount offered", "Lead source"]],
    ]);
    // A field whose section isn't known (or is gone) is shown with the unsectioned ones.
    expect(groupBySection([field("5", { sectionId: "99" })], sections).map((group) => group.section)).toEqual([null]);
    expect(groupBySection([], sections)).toEqual([]);
  });
});
