import { afterAll, beforeAll, expect, it } from "vitest";
import * as changesRoute from "@/app/api/repeating-invoices/price-changes/route";
import * as previewRoute from "@/app/api/repeating-invoices/price-changes/preview/route";
import * as undoRoute from "@/app/api/repeating-invoices/price-changes/[priceChangeId]/undo/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { listInvoices } from "@/lib/invoices/service";
import { createItem } from "@/lib/items/service";
import { newUnitPrice, previewPriceChange, savePriceChange, undoPriceChange } from "@/lib/repeating/price-changes";
import { createRepeatingInvoice, getRepeatingInvoice, runRepeatingInvoices, setRepeatingStatus, updateRepeatingInvoice } from "@/lib/repeating/service";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples RP1-RP8 in docs/ACCOUNTING-EXAMPLES.md ("Price changes on repeating invoices"). */
describeWithDatabase("price changes on repeating invoices", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("price-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("price-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `price-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    const job = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: null, email: "repeating-invoices@tohyee" }, work);
    const customer = async (name: string) => (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, isCustomer: true }))).contact;
    const kobe = await customer("Kobe Cafe");
    const paw = await customer("Paw Walkers");
    const ret = (await as((tx) => createItem(tx, { idempotencyKey: key("item"), code: "RET", name: "Monthly retainer", itemType: "service" }))).item;
    const common = { period: "month", every: 1, startDate: "2026-01-31", dueRule: "days_after", dueDays: 20, saveAs: "draft" };
    const make = async (input: Record<string, unknown>) => (await as((tx) => createRepeatingInvoice(tx, { idempotencyKey: key("ri"), ...common, ...input }))).repeatingInvoice;
    const retainer = await make({
      contactId: kobe.id,
      amountsMode: "exclusive",
      lines: [{ description: "Monthly retainer", quantity: "1", unitPrice: "100.00", accountCode: "4000", taxCode: "GST", itemId: ret.id }],
    });
    const walking = await make({
      contactId: paw.id,
      amountsMode: "inclusive",
      lines: [{ description: "Dog walking", quantity: "1", unitPrice: "115.00", accountCode: "4000", taxCode: "GST" }],
    });
    const grooming = await make({
      contactId: kobe.id,
      amountsMode: "exclusive",
      lines: [{ description: "Shampoo", quantity: "2", unitPrice: "45.00", discountPercent: "10", accountCode: "4000", taxCode: "GST" }],
    });
    const run = (today: string) => job((tx) => runRepeatingInvoices(tx, { today }));
    await run("2026-03-05");
    const ids = [retainer.id, walking.id, grooming.id];
    const prices = async (id: string) => (await as((tx) => getRepeatingInvoice(tx, id))).lines.map((line) => line.unitPrice);
    const totals = async () => Promise.all(ids.map(async (id) => (await as((tx) => getRepeatingInvoice(tx, id))).total));
    /** The invoices a template has made: date and total, oldest first. */
    const invoicesFor = async (templateId: string) => {
      const template = await as((tx) => getRepeatingInvoice(tx, templateId));
      const all = (await as((tx) => listInvoices(tx, {}))).invoices;
      return template.runs
        .map((run) => all.find((invoice) => invoice.id === run.invoiceId)!)
        .map((invoice) => [invoice.invoiceDate, invoice.total])
        .sort();
    };
    return { org, as, job, kobe, ret, retainer, walking, grooming, ids, run, prices, totals, invoicesFor };
  }

  it("works out a line's new price: percentage, minimum, rounding, fixed", () => {
    const rule = (extra: Partial<Parameters<typeof newUnitPrice>[1]>) => ({ method: "percent" as const, percent: "3", fixedPrice: null, rounding: "cent" as const, minimumIncrease: null, ...extra });
    expect(newUnitPrice("100.00", rule({}))).toBe("103.00");
    expect(newUnitPrice("45.00", rule({}))).toBe("46.35");
    expect(newUnitPrice("10.01", rule({}))).toBe("10.31"); // 10.3103 to the cent
    expect(newUnitPrice("115.00", rule({ percent: "4.5", rounding: "1" }))).toBe("120.00"); // 120.175
    expect(newUnitPrice("100.00", rule({ percent: "4.5", rounding: "1" }))).toBe("105.00"); // 104.50, halves up
    expect(newUnitPrice("45.00", rule({ percent: "4.5", rounding: "0.50" }))).toBe("47.00"); // 47.025
    expect(newUnitPrice("45.00", rule({ minimumIncrease: "5.00" }))).toBe("50.00");
    expect(newUnitPrice("200.00", rule({ minimumIncrease: "5.00" }))).toBe("206.00"); // 6.00 is over the minimum
    expect(newUnitPrice("100.00", rule({ percent: "-10", minimumIncrease: "5.00" }))).toBe("90.00"); // no minimum on a fall
    expect(newUnitPrice("100.00", rule({ percent: "-100" }))).toBe("0.00");
    expect(newUnitPrice("100.00", rule({ method: "fixed", percent: null, fixedPrice: "110" }))).toBe("110.00");
  });

  it("RP1: the preview shows each line and invoice total before and after, and saves nothing", async () => {
    const w = await setup();
    const response = await previewRoute.POST(
      apiRequest("/api/repeating-invoices/price-changes/preview", {
        method: "POST",
        cookie: await sessionCookieFor(owner),
        body: { organisationId: w.org, repeatingInvoiceIds: w.ids, method: "percent", percent: "3", effectiveDate: "2026-03-05" },
      }),
      noContext,
    );
    expect(response.status).toBe(200);
    const { preview } = (await response.json()) as { preview: Awaited<ReturnType<typeof previewPriceChange>> };
    expect(preview.linesChanged).toBe(3);
    expect(preview.templates.map((t) => [t.contactName, t.totalBefore, t.totalAfter])).toEqual([
      ["Kobe Cafe", "115.00", "118.45"],
      ["Paw Walkers", "115.00", "118.45"],
      ["Kobe Cafe", "93.15", "95.94"],
    ]);
    expect(preview.templates[1].lines.map((l) => [l.description, l.oldUnitPrice, l.newUnitPrice, l.notChanged])).toEqual([
      ["Dog walking", "115.00", "118.45", null],
    ]);
    expect(await w.totals()).toEqual(["115.00", "115.00", "93.15"]);
    expect((await w.as((tx) => tx.query("select 1 from repeating_price_changes"))).rowCount).toBe(0);
    // Viewers can't preview or save.
    const asViewer = await previewRoute.POST(
      apiRequest("/api/repeating-invoices/price-changes/preview", {
        method: "POST",
        cookie: await sessionCookieFor(viewer),
        body: { organisationId: w.org, repeatingInvoiceIds: w.ids, method: "percent", percent: "3", effectiveDate: "2026-03-05" },
      }),
      noContext,
    );
    expect(asViewer.status).toBe(403);
  });

  it("RP2 and RP3: rounding to the dollar, and a minimum increase", async () => {
    const w = await setup();
    const rounded = await w.as((tx) => previewPriceChange(tx, { repeatingInvoiceIds: w.ids, method: "percent", percent: "4.5", rounding: "1", effectiveDate: "2026-03-05" }));
    expect(rounded.templates.map((t) => t.lines[0].newUnitPrice)).toEqual(["105.00", "120.00", "47.00"]);
    const minimum = await w.as((tx) => previewPriceChange(tx, { repeatingInvoiceIds: w.ids, method: "percent", percent: "3", minimumIncrease: "5.00", effectiveDate: "2026-03-05" }));
    expect(minimum.templates.map((t) => t.lines[0].newUnitPrice)).toEqual(["105.00", "120.00", "50.00"]);
  });

  it("RP4: a fixed price for one item changes only that item's lines", async () => {
    const w = await setup();
    const change = await w.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: w.ids, method: "fixed", itemId: w.ret.id, fixedPrice: "110.00", effectiveDate: "2026-03-31" }));
    expect(change.lines.map((l) => [l.contactName, l.oldUnitPrice, l.newUnitPrice, l.status])).toEqual([["Kobe Cafe", "100.00", "110.00", "made"]]);
    expect(await w.totals()).toEqual(["126.50", "115.00", "93.15"]);
    await expect(w.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: w.ids, method: "fixed", fixedPrice: "110.00", effectiveDate: "2026-03-31" }))).rejects.toThrow(/item/);
  });

  it("RP5: from the next invoice date the templates change straight away; from a later date the change waits for it", async () => {
    const w = await setup();
    // From 31 Mar: Retainer is 103.00 now, and the 31 Mar invoice is 118.45.
    await w.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: [w.retainer.id], method: "percent", percent: "3", effectiveDate: "2026-03-31" }));
    expect(await w.prices(w.retainer.id)).toEqual(["103"]);
    await w.run("2026-03-31");
    expect(await w.invoicesFor(w.retainer.id)).toEqual([["2026-01-31", "115.00"], ["2026-02-28", "115.00"], ["2026-03-31", "118.45"]]);

    // From 1 Apr, saved before the 31 Mar invoice is made.
    const v = await setup();
    const change = await v.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: [v.retainer.id], method: "percent", percent: "3", effectiveDate: "2026-04-01" }));
    expect(change.lines.map((l) => l.status)).toEqual(["waiting"]);
    expect(await v.prices(v.retainer.id)).toEqual(["100"]);
    // Run only on 5 May: 31 Mar at the old price, then 30 Apr at the new one.
    await v.run("2026-05-05");
    expect(await v.invoicesFor(v.retainer.id)).toEqual([["2026-01-31", "115.00"], ["2026-02-28", "115.00"], ["2026-03-31", "115.00"], ["2026-04-30", "118.45"]]);
    expect(await v.prices(v.retainer.id)).toEqual(["103"]);
    // Nothing posted: the invoices are drafts and the change is only on templates.
    expect((await v.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);
  });

  it("RP6: a line edited after the change was saved is left alone, with why", async () => {
    const w = await setup();
    const change = await w.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: [w.retainer.id], method: "percent", percent: "3", effectiveDate: "2026-04-01" }));
    const current = await w.as((tx) => getRepeatingInvoice(tx, w.retainer.id));
    await w.as((tx) =>
      updateRepeatingInvoice(tx, w.retainer.id, {
        lines: [{ description: "Monthly retainer", quantity: "1", unitPrice: "101.00", accountCode: "4000", taxCode: "GST", itemId: current.lines[0].itemId }],
      }),
    );
    await w.run("2026-04-30");
    expect(await w.invoicesFor(w.retainer.id)).toEqual([["2026-01-31", "115.00"], ["2026-02-28", "115.00"], ["2026-03-31", "116.15"], ["2026-04-30", "116.15"]]);
    const after = (await changesRoute.GET(apiRequest(`/api/repeating-invoices/price-changes?organisationId=${w.org}`, { cookie: await sessionCookieFor(viewer) }), noContext)) as Response;
    const { priceChanges } = (await after.json()) as { priceChanges: Array<{ id: string; lines: Array<{ status: string; message: string }> }> };
    expect(priceChanges.find((p) => p.id === change.id)!.lines).toMatchObject([{ status: "skipped", message: "Changed to 101.00 after this price change was saved." }]);
  });

  it("RP7: cancelling a waiting change, undoing a made one, and invoices keep their prices", async () => {
    const w = await setup();
    const waiting = await w.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: [w.retainer.id], method: "percent", percent: "3", effectiveDate: "2026-04-01" }));
    const cancelled = await undoRoute.POST(
      apiRequest(`/api/repeating-invoices/price-changes/${waiting.id}/undo`, { method: "POST", cookie: await sessionCookieFor(owner), body: { organisationId: w.org } }),
      params({ priceChangeId: waiting.id }),
    );
    expect(((await cancelled.json()) as { priceChange: { status: string } }).priceChange.status).toBe("cancelled");
    await w.run("2026-04-30");
    expect((await w.invoicesFor(w.retainer.id)).at(-1)).toEqual(["2026-04-30", "115.00"]);

    const v = await setup();
    const made = await v.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: v.ids, method: "percent", percent: "3", effectiveDate: "2026-03-05" }));
    expect(made.lines.map((l) => l.status)).toEqual(["made", "made", "made"]);
    await v.run("2026-03-31");
    // Retainer edited to 101.00 since: the undo leaves it and says so.
    const current = await v.as((tx) => getRepeatingInvoice(tx, v.retainer.id));
    await v.as((tx) =>
      updateRepeatingInvoice(tx, v.retainer.id, {
        lines: [{ description: "Monthly retainer", quantity: "1", unitPrice: "101.00", accountCode: "4000", taxCode: "GST", itemId: current.lines[0].itemId }],
      }),
    );
    const undone = await v.as((tx) => undoPriceChange(tx, made.id));
    expect(undone.status).toBe("undone");
    expect(undone.lines.map((l) => [l.description, l.status])).toEqual([
      ["Monthly retainer", "kept"],
      ["Dog walking", "undone"],
      ["Shampoo", "undone"],
    ]);
    expect(await v.totals()).toEqual(["116.15", "115.00", "93.15"]);
    // The 31 Mar invoice made at the new price stays at it.
    expect((await v.invoicesFor(v.retainer.id)).at(-1)).toEqual(["2026-03-31", "118.45"]);
    await expect(v.as((tx) => undoPriceChange(tx, made.id))).rejects.toThrow(/already undone/);
  });

  it("RP8: ended templates aren't changed; paused ones wait; every change is in the audit trail", async () => {
    const w = await setup();
    await w.as((tx) => setRepeatingStatus(tx, w.grooming.id, "ended"));
    await expect(w.as((tx) => previewPriceChange(tx, { repeatingInvoiceIds: w.ids, method: "percent", percent: "3", effectiveDate: "2026-03-05" }))).rejects.toThrow(/has ended/);
    await w.as((tx) => setRepeatingStatus(tx, w.walking.id, "paused", "2026-03-05"));
    const change = await w.as((tx) => savePriceChange(tx, { repeatingInvoiceIds: [w.retainer.id, w.walking.id], method: "percent", percent: "3", effectiveDate: "2026-03-05" }));
    expect(change.lines.map((l) => [l.contactName, l.status])).toEqual([
      ["Kobe Cafe", "made"],
      ["Paw Walkers", "waiting"],
    ]);
    // Resumed on 10 Mar: its next invoice (31 Mar) is made at the new price.
    await w.as((tx) => setRepeatingStatus(tx, w.walking.id, "active", "2026-03-10"));
    await w.run("2026-03-31");
    expect((await w.invoicesFor(w.walking.id)).at(-1)).toEqual(["2026-03-31", "118.45"]);
    const events = await w.as((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where event_type like 'repeating_price_change.%' order by id"));
    expect(events.rows.map((row) => row.event_type)).toEqual(["repeating_price_change.saved", "repeating_price_change.made", "repeating_price_change.made"]);
    expect((await w.as((tx) => tx.query("select 1 from ledger_journals"))).rowCount).toBe(0);
  });
});
