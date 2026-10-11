import { afterAll, beforeAll, expect, it } from "vitest";
import * as movementsRoute from "@/app/api/livestock/movements/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import {
  createLocation,
  headCount,
  previewAgeing,
  recordCounts,
  recordMovement,
  setAgeingSplit,
  setOpenings,
  updateLivestockSettings,
  voidMovement,
} from "@/lib/livestock/movements";
import { getOrganisationSettings, updateOrganisationSettings } from "@/lib/organisations/settings";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  params,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const ORG = "livestock-head-counts";
const YEAR_END = "2026-05-31";

/** Examples LV1-LV3 (approved by Jess 11 Oct 2026), decision 503: head counts, no postings. */
describeWithDatabase("livestock head counts (LV1-LV3)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let agent: Contact;

  const run = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: owner.id, email: owner.email }, work);
  const move = (fields: Record<string, unknown>) =>
    run((tx) => recordMovement(tx, { idempotencyKey: key("lv"), kind: "dairy_cattle", ...fields })).then((result) => result.movement);
  const count = () => run((tx) => headCount(tx, { yearEnd: YEAR_END }));
  const row = (result: Awaited<ReturnType<typeof count>>, classCode: string) => result.rows.find((entry) => entry.classCode === classCode)!;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    await run((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    agent = (await run((tx) => createContact(tx, { idempotencyKey: key("c"), name: "PGG Wrightson", isCustomer: true }))).contact;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("is off until turned on, and starts on the first day of a financial year", async () => {
    await expect(move({ movementType: "birth", movementDate: "2025-08-15", classCode: "r1_heifers", head: 1 })).rejects.toThrow(/isn't turned on/);
    // Turned on from Modules: the current financial year to start with, changeable until movements exist.
    const fromModules = await run((tx) => updateLivestockSettings(tx, { enabled: true }));
    expect(fromModules.firstYearStart).toMatch(/^\d{4}-06-01$/);
    expect((await run((tx) => getOrganisationSettings(tx))).livestockEnabled).toBe(true);
    await run((tx) => updateLivestockSettings(tx, { enabled: false }));
    await expect(run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-07-01" }))).rejects.toThrow(/first day of a financial year/);
    const settings = await run((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2025-06-01" }));
    expect(settings).toMatchObject({ enabled: true, firstYearStart: "2025-06-01", financialYearEndMonth: 5 });
    await run((tx) =>
      setOpenings(tx, {
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 300, value: "750000.00" },
          { kind: "dairy_cattle", classCode: "r2_heifers", head: 70, value: "154000.00" },
          { kind: "dairy_cattle", classCode: "r1_heifers", head: 75, value: "86250.00" },
        ],
      }),
    );
  });

  it("LV1: births, purchases, sales, deaths and ageing reconcile by class; ageing nets to zero and runs once", async () => {
    await move({ movementType: "birth", movementDate: "2025-08-15", classCode: "r1_heifers", head: 80 });
    await move({ movementType: "purchase", movementDate: "2025-11-01", classCode: "ma_cows", head: 10, amount: "24000.00" });
    await move({ movementType: "death", movementDate: "2026-01-20", classCode: "ma_cows", head: 5 });
    await move({ movementType: "sale", movementDate: "2026-03-10", classCode: "ma_cows", head: 60, amount: "66000.00" });
    // A class can't go below zero (300 cows plus the 70 heifers aged in on 1 June), and births only go into the youngest classes.
    await expect(move({ movementType: "sale", movementDate: "2025-06-02", classCode: "ma_cows", head: 371 })).rejects.toThrow(/below zero on 2025-06-02/);
    await expect(move({ movementType: "birth", movementDate: "2025-08-15", classCode: "ma_cows", head: 1 })).rejects.toThrow(/youngest classes/);

    // Ageing happens at the start of the year, from last year's closing classes.
    const preview = await run((tx) => previewAgeing(tx, { yearEnd: YEAR_END }));
    expect(preview.yearStart).toBe("2025-06-01");
    expect(preview.steps.map((step) => [step.classCode, step.toClassCode, step.head])).toEqual([
      ["r1_heifers", "r2_heifers", 75],
      ["r2_heifers", "ma_cows", 70],
    ]);

    const result = await count();
    const columns = (classCode: string) => {
      const entry = row(result, classCode);
      return [entry.opening, entry.births, entry.bought, entry.sold, entry.died, entry.ageingIn - entry.ageingOut, entry.closing];
    };
    expect(columns("ma_cows")).toEqual([300, 0, 10, 60, 5, 70, 315]);
    expect(columns("r2_heifers")).toEqual([70, 0, 0, 0, 0, 5, 75]);
    expect(columns("r1_heifers")).toEqual([75, 80, 0, 0, 0, -75, 80]);
    expect(result.totals).toMatchObject({ opening: 445, births: 80, bought: 10, sold: 60, died: 5, closing: 470 });
    expect(result.ageingBalances).toBe(true);

    // With 75 heifers aged into rising two-year on 1 June, selling 76 of them that day is refused.
    await expect(move({ movementType: "sale", movementDate: "2025-06-01", classCode: "r2_heifers", head: 76 })).rejects.toThrow(/below zero/);
    // A late entry in the year changes the head count; there's no ageing run to redo.
    const late = await move({ movementType: "death", movementDate: "2025-09-01", classCode: "r1_heifers", head: 2 });
    expect(row(await count(), "r1_heifers").closing).toBe(78);
    await run((tx) => voidMovement(tx, late.id, { reason: "Entered on the wrong farm" }));
    expect(row(await count(), "r1_heifers").closing).toBe(80);
    // Voiding the purchase would leave too few cows for the later sale... it doesn't here (300 + 70 - 5 - 60 = 305), so it's allowed and undone.
  });

  it("LV2: a count that doesn't add up shows as not explained until a movement explains it", async () => {
    const counted = await run((tx) =>
      recordCounts(tx, {
        countDate: YEAR_END,
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 312 },
          { kind: "dairy_cattle", classCode: "r2_heifers", head: 75 },
          { kind: "dairy_cattle", classCode: "r1_heifers", head: 80 },
        ],
      }),
    );
    expect(counted.unexplained).toEqual([{ kind: "dairy_cattle", classCode: "ma_cows", className: "Mixed-age cows", expected: 315, counted: 312, difference: 3 }]);
    expect(row(counted, "ma_cows").unexplained).toBe(3);
    await move({ movementType: "missing", movementDate: "2026-05-30", classCode: "ma_cows", head: 3, note: "Not found at the year-end muster" });
    const explained = await count();
    expect(explained.unexplained).toEqual([]);
    expect(row(explained, "ma_cows")).toMatchObject({ missing: 3, closing: 312, counted: 312, unexplained: 0 });
  });

  it("LV3: stock held for others is shown but not counted; own stock grazing elsewhere is", async () => {
    await move({ movementType: "arrival", movementDate: "2025-07-01", classCode: "r2_heifers", head: 50, heldFor: "Neighbour (J Smith)" });
    await expect(move({ movementType: "departure", movementDate: "2025-07-02", classCode: "r2_heifers", head: 51, heldFor: "Neighbour (J Smith)" })).rejects.toThrow(
      /would leave than arrived/,
    );
    const block = await run((tx) => createLocation(tx, { name: "Runoff block" }));
    await move({ movementType: "transfer", movementDate: "2025-07-01", classCode: "r1_heifers", head: 75, toLocationId: block.id });
    const result = await count();
    expect(result.totals.closing).toBe(467);
    expect(result.held).toEqual([
      { heldFor: "Neighbour (J Smith)", kind: "dairy_cattle", classCode: "r2_heifers", className: "Rising two-year heifers", opening: 0, arrived: 50, left: 0, closing: 50 },
    ]);
    expect(result.byLocation).toEqual([
      { locationId: null, locationName: "No location", kind: "dairy_cattle", head: 392 },
      { locationId: block.id, locationName: "Runoff block", kind: "dairy_cattle", head: 75 },
    ]);
  });

  it("LV7: an approved invoice line is linked once per class; the API needs a bookkeeper", async () => {
    const draft = await run((tx) =>
      createInvoice(tx, {
        idempotencyKey: key("inv"),
        contactId: agent.id,
        invoiceDate: "2026-04-10",
        dueDate: "2026-04-30",
        amountsMode: "exclusive",
        lines: [{ description: "Cull cows", quantity: "10", unitPrice: "1100.00", accountCode: "4000", taxCode: "GST" }],
      }),
    );
    const lineId = (await run((tx) => tx.query<{ id: string }>("select id::text from sales_invoice_lines where invoice_id = $1", [draft.invoice.id]))).rows[0].id;
    await expect(move({ movementType: "sale", movementDate: "2026-04-10", classCode: "ma_cows", head: 10, salesInvoiceLineId: lineId })).rejects.toThrow(
      /approved invoice/,
    );
    const approved = (await run((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("ap") }))).invoice;
    const sale = await move({ movementType: "sale", movementDate: "2026-04-10", classCode: "ma_cows", head: 10, amount: "11000.00", salesInvoiceLineId: lineId });
    expect(sale).toMatchObject({ invoiceNumber: approved.invoiceNumber, salesInvoiceLineId: lineId });
    await expect(move({ movementType: "sale", movementDate: "2026-04-10", classCode: "ma_cows", head: 10, salesInvoiceLineId: lineId })).rejects.toThrow(
      /only counted once/,
    );
    // A retry with the same key is the same movement.
    const retryKey = key("lv");
    const first = await run((tx) => recordMovement(tx, { idempotencyKey: retryKey, kind: "dairy_cattle", movementType: "death", movementDate: "2026-04-11", classCode: "ma_cows", head: 1 }));
    const again = await run((tx) => recordMovement(tx, { idempotencyKey: retryKey, kind: "dairy_cattle", movementType: "death", movementDate: "2026-04-11", classCode: "ma_cows", head: 1 }));
    expect(again).toMatchObject({ created: false, movement: { id: first.movement.id } });

    const viewer = await createTestUser("viewer@example.com", {});
    const { coreQuery } = await import("@/lib/db/transactions");
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [ORG, viewer.id]);
    const response = await movementsRoute.POST(
      apiRequest("/api/livestock/movements", {
        method: "POST",
        cookie: await sessionCookieFor(viewer),
        body: { organisationId: ORG, idempotencyKey: key("lv"), kind: "dairy_cattle", movementType: "death", movementDate: "2026-04-11", classCode: "ma_cows", head: 1 },
      }),
      params({}),
    );
    expect(response.status).toBe(403);
  });

  it("mixed-age ewes turn rising five in part: the year waits for the split", async () => {
    await move({ kind: "sheep", movementType: "purchase", movementDate: "2025-06-05", classCode: "ma_ewes", head: 100 });
    // Bought this year, so nothing ages until next year.
    await move({ kind: "sheep", movementType: "purchase", movementDate: "2026-06-05", classCode: "two_tooth_ewes", head: 1 });
    const next = await run((tx) => headCount(tx, { yearEnd: "2027-05-31" }));
    expect(next.needsSplit.map((step) => [step.classCode, step.head])).toEqual([["ma_ewes", 100]]);
    await expect(run((tx) => setAgeingSplit(tx, { yearEnd: "2027-05-31", kind: "sheep", classCode: "ma_ewes", head: 101 }))).rejects.toThrow(/Only 100/);
    await run((tx) => setAgeingSplit(tx, { yearEnd: "2027-05-31", kind: "sheep", classCode: "ma_ewes", head: 40 }));
    const split = await run((tx) => headCount(tx, { yearEnd: "2027-05-31" }));
    expect(split.needsSplit).toEqual([]);
    expect(split.rows.filter((entry) => entry.kind === "sheep").map((entry) => [entry.classCode, entry.closing])).toEqual([
      ["two_tooth_ewes", 1],
      ["ma_ewes", 60],
      ["r5_ewes", 40],
    ]);
    await expect(run((tx) => setAgeingSplit(tx, { yearEnd: "2027-05-31", kind: "dairy_cattle", classCode: "ma_cows", head: 1 }))).rejects.toThrow(/nothing to split/);
  });

  it("is part of Accounting: turning Accounting off turns livestock off, and its records are kept", async () => {
    await run((tx) => updateOrganisationSettings(tx, { accountingEnabled: false, crmEnabled: true }));
    expect((await run((tx) => getOrganisationSettings(tx))).livestockEnabled).toBe(false);
    await run((tx) => updateOrganisationSettings(tx, { accountingEnabled: true }));
    await run((tx) => updateLivestockSettings(tx, { enabled: true }));
    expect(row(await count(), "ma_cows").closing).toBeGreaterThan(0);
  });
});
