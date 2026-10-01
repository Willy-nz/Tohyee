import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordDetails } from "@/components/crm-record-details";
import type { Role } from "@/lib/auth/roles";
import { detailSections, monthLabel, nzMonth, pastByMonth, upcomingAndOverdue } from "@/lib/crm/record-page";
import { customKey, type PageLayout, standardFieldApplies } from "@/lib/crm/record-types/layout";
import type { Task, TimelineEntry } from "@/lib/crm/service";
import type { CustomField } from "@/lib/custom-fields/values";

/** The CRM record page's Details tab and Activity panel (examples CRT6, CRT7, CRT11). */

const field = (id: string, label: string, usedOn: CustomField["usedOn"] = ["prospect"]): CustomField => ({
  id,
  record: "contact",
  label,
  help: null,
  type: "text",
  usedOn,
  isRequired: false,
  defaultValue: null,
  showInList: false,
  isActive: true,
  sortOrder: Number(id),
  sectionId: null,
  options: [],
});

const funderReference = field("1", "Funder reference");
const grantRound = field("2", "Grant round");
const supplierCode = field("3", "Supplier code", ["supplier"]);

const fundingLayout: PageLayout = {
  sections: [
    {
      name: "Company information",
      fields: [
        { key: "name", required: true, readOnly: false },
        { key: "phone", required: true, readOnly: false },
        { key: customKey(funderReference.id), required: true, readOnly: false },
        { key: customKey(supplierCode.id), required: false, readOnly: false },
      ],
    },
    { name: "Admin only", fields: [{ key: customKey(grantRound.id), required: false, readOnly: true }] },
    { name: "Supplier details", fields: [{ key: customKey(supplierCode.id), required: false, readOnly: false }] },
    {
      name: "System information",
      fields: [
        { key: "createdAt", required: false, readOnly: true },
        { key: "updatedAt", required: false, readOnly: true },
      ],
    },
  ],
};

const visible = [funderReference, grantRound];

describe("the Details tab follows the record type's layout (CRT6, CRT7)", () => {
  it("shows the layout's sections, leaving out fields that don't apply and empty sections", () => {
    const sections = detailSections("contact", fundingLayout, visible, "bookkeeper");
    expect(sections.map((s) => [s.name, s.fields.map((f) => f.label)])).toEqual([
      ["Company information", ["Company name", "Phone", "Funder reference"]],
      ["Admin only", ["Grant round"]],
      ["System information", ["Created", "Last changed"]],
    ]);
    const phone = sections[0].fields[1];
    expect([phone.required, phone.readOnly]).toEqual([true, false]);
  });

  it("shows a company's delivery address only on customers (CRT4)", () => {
    const layout = { sections: [{ name: "Address information", fields: [{ key: "postalAddress", required: false, readOnly: false }, { key: "deliveryAddress", required: true, readOnly: false }] }] };
    const labels = (contact: { isCustomer: boolean }) =>
      detailSections("contact", layout, [], "bookkeeper", (key) => standardFieldApplies("contact", key, contact)).flatMap((s) => s.fields.map((f) => f.label));
    expect(labels({ isCustomer: true })).toEqual(["Billing address", "Delivery address"]);
    expect(labels({ isCustomer: false })).toEqual(["Billing address"]);
    expect(standardFieldApplies("person", "deliveryAddress", null)).toBe(true);
  });

  it("lets bookkeepers edit, admins also edit read-only fields, and viewers nothing", () => {
    const editable = (role: Role) =>
      detailSections("contact", fundingLayout, visible, role)
        .flatMap((s) => s.fields)
        .filter((f) => f.editable)
        .map((f) => f.label);
    expect(editable("viewer")).toEqual([]);
    expect(editable("bookkeeper")).toEqual(["Company name", "Phone", "Funder reference"]);
    expect(editable("admin")).toEqual(["Company name", "Phone", "Funder reference", "Grant round"]);
    expect(editable("owner")).toEqual(editable("admin"));
  });

  it("draws a pencil only on fields the person can edit", () => {
    const render = (role: Role) =>
      renderToStaticMarkup(
        createElement(RecordDetails, {
          sections: detailSections("contact", fundingLayout, visible, role),
          valueOf: (f: { key: string }) => (f.key === "name" ? "Lottery Grants Board" : ""),
          editingKey: null,
          onEdit: () => undefined,
          renderEditor: () => null,
        }),
      );
    const pencils = (html: string) => [...html.matchAll(/aria-label="Edit ([^"]+)"/g)].map((match) => match[1]);
    const viewer = render("viewer");
    expect(pencils(viewer)).toEqual([]);
    expect(viewer).toContain("Lottery Grants Board");
    expect(viewer).toContain("<details open");
    expect(pencils(render("bookkeeper"))).toEqual(["Company name", "Phone", "Funder reference"]);
    expect(pencils(render("admin"))).toEqual(["Company name", "Phone", "Funder reference", "Grant round"]);
    expect(render("bookkeeper")).toContain('title="Required"');
    expect(render("bookkeeper")).toContain("Read-only");
  });
});

const task = (id: string, title: string, dueDate: string | null, status: Task["status"] = "todo", completedAt: string | null = null): Task => ({
  id,
  title,
  body: null,
  dueDate,
  status,
  assigneeUserId: null,
  contactId: "1",
  contactName: "Mānuka Vets",
  personId: null,
  personName: null,
  opportunityId: null,
  opportunityName: null,
  completedAt,
  createdByEmail: "owner@example.com",
  createdAt: "2026-09-01T00:00:00.000Z",
});

const entry = (kind: TimelineEntry["kind"], at: string, title: string): TimelineEntry => ({ kind, at, title, detail: null, amount: null, href: null, by: null });

describe("the Activity panel (CRT11)", () => {
  const today = "2026-10-01";
  const now = "2026-10-01T04:00:00.000Z";
  const tasks = [
    task("1", "Follow up", "2026-10-08"),
    task("2", "Send sample", "2026-09-30"),
    task("3", "Someday", null),
    task("4", "Old overdue", "2026-09-20"),
    task("5", "Called back", "2026-09-25", "done", "2026-09-26T03:00:00.000Z"),
  ];
  const timeline = [
    entry("meeting", "2026-10-03T21:00:00.000Z", "Meeting: Site visit"),
    entry("activity", "2026-09-15T02:00:00.000Z", "Call: Intro call"),
    entry("invoice", "2026-08-31T13:30:00.000Z", "Invoice approved INV-0001"),
    entry("task", "2026-09-01T00:00:00.000Z", "Task added: Follow up"),
  ];

  it("lists overdue tasks first, then what's coming up, then undated tasks", () => {
    expect(upcomingAndOverdue(tasks, timeline, today, now).map((item) => [item.title, item.overdue])).toEqual([
      ["Old overdue", true],
      ["Send sample", true],
      ["Meeting: Site visit", false],
      ["Follow up", false],
      ["Someday", false],
    ]);
  });

  it("groups past activity by New Zealand month, newest first, with done tasks", () => {
    // 31 August 13:30 UTC is 1 September in New Zealand.
    expect(nzMonth("2026-08-31T13:30:00.000Z")).toBe("2026-09");
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(pastByMonth(tasks, timeline, now).map((month) => [month.label, month.entries.map((e) => e.title)])).toEqual([
      ["September 2026", ["Task done: Called back", "Call: Intro call", "Invoice approved INV-0001"]],
    ]);
  });
});
