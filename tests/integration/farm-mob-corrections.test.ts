import { afterAll, beforeAll, expect, it } from "vitest";
import * as actionsRoute from "@/app/api/farming/mobs/[mobId]/actions/route";
import * as voidRoute from "@/app/api/livestock/movements/[movementId]/void/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { createMob, getMob, mobAction } from "@/lib/farming/mobs";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { approveInvoice, createInvoice } from "@/lib/invoices/service";
import { headCount, listMovements, recordMovement, setOpenings, updateLivestockSettings, voidMovement } from "@/lib/livestock/movements";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

/**
 * Issue #609 items 1 and 2 (MOB11-MOB14, common NZ practice, not yet
 * reviewed; decisions 1500-1505): a mob-linked livestock movement is only
 * voided by reversing the mob's event, and a linked class change must
 * match its destination class.
 */
describeWithDatabase("mob corrections (#609)", () => {
  let server: TestServer;
  let owner: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("mob-corrections@example.com", { serverAdmin: true });
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `mobfix-${organisations}-co`;
    await createTestOrganisation(owner, org);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) => setFarmingEnabled(tx, { enabled: true }));
    await as((tx) => updateOrganisationSettings(tx, { financialYearEndMonth: 5 }));
    await as((tx) => updateLivestockSettings(tx, { enabled: true, firstYearStart: "2026-06-01" }));
    await as((tx) =>
      setOpenings(tx, {
        lines: [
          { kind: "dairy_cattle", classCode: "ma_cows", head: 100, value: "250000.00" },
          { kind: "dairy_cattle", classCode: "breeding_bulls", head: 40, value: "50000.00" },
        ],
      }),
    );
    const farm = (await as((tx) => saveFarm(tx, { name: "Home block" })))[0];
    const a = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "A", effectiveHa: "10.00", onDate: "2026-06-01" }));
    const b = await as((tx) => addPaddock(tx, { farmId: farm.id, name: "B", effectiveHa: "10.00", onDate: "2026-06-01" }));
    const cows = (await as((tx) => createMob(tx, { farmId: farm.id, name: "Milkers", kind: "dairy_cattle", classCode: "ma_cows", head: 100, paddockId: a.id, onDate: "2026-07-01" }))).mob;
    const agent = (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Stock agent", isCustomer: true, isSupplier: true }))).contact;
    return { org, as, farm, a, b, cows, agent };
  }

  const cowsRow = async (as: <T>(work: (tx: OrgTx) => Promise<T>) => Promise<T>) =>
    (await as((tx) => headCount(tx, { yearEnd: "2027-05-31" }))).rows.find((row) => row.kind === "dairy_cattle" && row.classCode === "ma_cows")!;

  async function invoiceLine(w: Awaited<ReturnType<typeof setup>>, agent: Contact) {
    const draft = await w.as((tx) =>
      createInvoice(tx, { idempotencyKey: key("inv"), contactId: agent.id, invoiceDate: "2026-08-10", dueDate: "2026-08-31", amountsMode: "exclusive", lines: [{ description: "Cull cows", quantity: "10", unitPrice: "1100.00", accountCode: "4000", taxCode: "GST" }] }),
    );
    await w.as((tx) => approveInvoice(tx, draft.invoice.id, { idempotencyKey: key("ap") }));
    return (await w.as((tx) => tx.query<{ id: string }>("select id::text from sales_invoice_lines where invoice_id = $1", [draft.invoice.id]))).rows[0].id;
  }

  async function billLine(w: Awaited<ReturnType<typeof setup>>, agent: Contact) {
    const draft = await w.as((tx) =>
      createBill(tx, { idempotencyKey: key("bill"), contactId: agent.id, billDate: "2026-08-10", dueDate: "2026-08-31", supplierInvoiceNumber: key("B"), amountsMode: "exclusive", lines: [{ description: "Cows bought", quantity: "5", unitPrice: "2000.00", accountCode: "5000", taxCode: "GST" }] }),
    );
    await w.as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("ap") }));
    return (await w.as((tx) => tx.query<{ id: string }>("select id::text from bill_lines where bill_id = $1", [draft.bill.id]))).rows[0].id;
  }

  it("MOB11 a movement a mob sale made can't be voided on its own; reversing the sale puts both back", async () => {
    const w = await setup();
    const sale = await w.as((tx) => mobAction(tx, w.cows.id, { action: "sell", head: 10, onDate: "2026-08-10" }));
    expect(sale.mob.head).toBe(90);
    const movement = (await w.as((tx) => listMovements(tx)))[0];
    expect((await cowsRow(w.as)).sold).toBe(10);
    // Voiding it alone would leave the books at 100 and the mob at 90: refused, pointing to the mob.
    await expect(w.as((tx) => voidMovement(tx, movement.id, { reason: "Entered twice" }))).rejects.toThrow("Reverse the sale on Milkers");
    // Through the API too: nothing changes.
    const cookie = await sessionCookieFor(owner);
    const refused = await voidRoute.POST(apiRequest(`/api/livestock/movements/${movement.id}/void`, { method: "POST", cookie, body: { organisationId: w.org, reason: "Entered twice" } }), params({ movementId: movement.id }));
    expect(refused.status).toBe(409);
    expect((await w.as((tx) => listMovements(tx)))[0].voided).toBe(false);
    expect((await w.as((tx) => getMob(tx, w.cows.id))).mob.head).toBe(90);

    const saleEvent = (await w.as((tx) => getMob(tx, w.cows.id))).events.find((event) => event.eventType === "sold")!;
    await expect(w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: saleEvent.id }))).rejects.toThrow("Say why");
    const reversed = await w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: saleEvent.id, reason: "Entered twice", onDate: "2026-08-12" }));
    expect(reversed.mob.head).toBe(100);
    expect(reversed.livestock).toBe("reversed");
    expect((await w.as((tx) => listMovements(tx, { includeVoided: true })))[0]).toMatchObject({ voided: true, voidReason: "Mob sale reversed: Entered twice" });
    expect((await cowsRow(w.as)).sold).toBe(0);
    // History is kept: the sale and its reversal are both there.
    const events = (await w.as((tx) => getMob(tx, w.cows.id))).events;
    expect(events.slice(0, 2).map((event) => [event.eventType, event.headChange, event.headAfter])).toEqual([
      ["reversed", 10, 100],
      ["sold", -10, 90],
    ]);
    await expect(w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: saleEvent.id, reason: "Again" }))).rejects.toThrow("already reversed");
  });

  it("MOB12 an invoice's and a bill's linked movements are reversed the same way", async () => {
    const w = await setup();
    const saleLine = await invoiceLine(w, w.agent);
    const { movement: sold } = await w.as((tx) => recordMovement(tx, { idempotencyKey: key("lv"), movementType: "sale", movementDate: "2026-08-10", kind: "dairy_cattle", classCode: "ma_cows", head: 10, amount: "11000.00", salesInvoiceLineId: saleLine }));
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "sell", head: 10, onDate: "2026-08-10", movementId: sold.id }));
    await expect(w.as((tx) => voidMovement(tx, sold.id, { reason: "Wrong cows" }))).rejects.toThrow("Reverse the sale on Milkers");
    const buyLine = await billLine(w, w.agent);
    const { movement: bought } = await w.as((tx) => recordMovement(tx, { idempotencyKey: key("lv"), movementType: "purchase", movementDate: "2026-08-10", kind: "dairy_cattle", classCode: "ma_cows", head: 5, amount: "10000.00", billLineId: buyLine }));
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "buy", head: 5, onDate: "2026-08-10", movementId: bought.id }));
    await expect(w.as((tx) => voidMovement(tx, bought.id, { reason: "Wrong cows" }))).rejects.toThrow("Reverse the purchase on Milkers");
    expect((await w.as((tx) => getMob(tx, w.cows.id))).mob.head).toBe(95);
    const events = (await w.as((tx) => getMob(tx, w.cows.id))).events;
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: events.find((event) => event.eventType === "bought")!.id, reason: "Wrong cows" }));
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: events.find((event) => event.eventType === "sold")!.id, reason: "Wrong cows" }));
    expect((await w.as((tx) => getMob(tx, w.cows.id))).mob.head).toBe(100);
    const movements = await w.as((tx) => listMovements(tx, { includeVoided: true }));
    expect(movements.every((movement) => movement.voided)).toBe(true);
    // The invoice and bill lines can be linked again, once.
    const again = await w.as((tx) => recordMovement(tx, { idempotencyKey: key("lv"), movementType: "sale", movementDate: "2026-08-10", kind: "dairy_cattle", classCode: "ma_cows", head: 10, amount: "11000.00", salesInvoiceLineId: saleLine }));
    expect(again.created).toBe(true);
  });

  it("MOB13 a reversal after a move, split, merge or close needs the mob to put them back into", async () => {
    const w = await setup();
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "sell", head: 10, onDate: "2026-08-10" }));
    const saleEvent = (await w.as((tx) => getMob(tx, w.cows.id))).events.find((event) => event.eventType === "sold")!;
    await w.as((tx) => mobAction(tx, w.cows.id, { action: "split", head: 30, name: "Culls", onDate: "2026-08-11" }));
    await expect(w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: saleEvent.id, reason: "Not sold" }))).rejects.toThrow("Milkers has been split since");
    const culls = (await w.as((tx) => getMob(tx, w.cows.id))).events.find((event) => event.eventType === "split_out")!.otherMobId!;
    // Into a mob of another class: refused, and nothing changes.
    const bulls = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Bulls", kind: "dairy_cattle", classCode: "breeding_bulls", head: 40, onDate: "2026-07-01" }))).mob;
    await expect(w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: saleEvent.id, reason: "Not sold", intoMobId: bulls.id }))).rejects.toThrow("mixed-age cows");
    const put = await w.as((tx) => mobAction(tx, w.cows.id, { action: "reverse", eventId: saleEvent.id, reason: "Not sold", intoMobId: culls, onDate: "2026-08-12" }));
    expect(put.message).toContain("10 back into Culls");
    expect((await w.as((tx) => getMob(tx, culls))).mob.head).toBe(40);
    expect((await w.as((tx) => getMob(tx, w.cows.id))).mob.head).toBe(60);
    expect((await cowsRow(w.as)).sold).toBe(0);
    // A closed mob (all sold) needs another mob too.
    const oldCows = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Old cows", kind: "dairy_cattle", classCode: "ma_cows", head: 5, onDate: "2026-07-01" }))).mob;
    await w.as((tx) => mobAction(tx, oldCows.id, { action: "sell", head: 5, onDate: "2026-08-20" }));
    const closedSale = (await w.as((tx) => getMob(tx, oldCows.id))).events.find((event) => event.eventType === "sold")!;
    await expect(w.as((tx) => mobAction(tx, oldCows.id, { action: "reverse", eventId: closedSale.id, reason: "Not sold" }))).rejects.toThrow("is closed");
    // A move since also asks for the mob (the animals sold weren't moved with it).
    await w.as((tx) => mobAction(tx, bulls.id, { action: "deaths", head: 2, onDate: "2026-08-20" }));
    const death = (await w.as((tx) => getMob(tx, bulls.id))).events.find((event) => event.eventType === "died")!;
    await w.as((tx) => mobAction(tx, bulls.id, { action: "move", toPaddockId: w.b.id, onDate: "2026-08-21" }));
    await expect(w.as((tx) => mobAction(tx, bulls.id, { action: "reverse", eventId: death.id, reason: "Miscounted" }))).rejects.toThrow("moved since");
    await w.as((tx) => mobAction(tx, bulls.id, { action: "reverse", eventId: death.id, reason: "Miscounted", intoMobId: bulls.id }));
    expect((await w.as((tx) => getMob(tx, bulls.id))).mob.head).toBe(40);
  });

  it("MOB14 a linked class change must match the movement's new class, through the API; a mismatch changes nothing", async () => {
    const w = await setup();
    const bulls = (await w.as((tx) => createMob(tx, { farmId: w.farm.id, name: "Bulls", kind: "dairy_cattle", classCode: "breeding_bulls", head: 40, onDate: "2026-07-01" }))).mob;
    const { movement } = await w.as((tx) => recordMovement(tx, { idempotencyKey: key("lv"), movementType: "reclass", movementDate: "2026-09-01", kind: "dairy_cattle", classCode: "breeding_bulls", toClassCode: "r3_steers_bulls", head: 40 }));
    const cookie = await sessionCookieFor(owner);
    const send = (toClassCode: string) =>
      actionsRoute.POST(apiRequest(`/api/farming/mobs/${bulls.id}/actions`, { method: "POST", cookie, body: { organisationId: w.org, action: "reclass", toClassCode, movementId: movement.id, onDate: "2026-09-01" } }), params({ mobId: bulls.id }));
    const mismatch = await send("ma_cows");
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toContain("is to rising three-year and older steers and bulls, not mixed-age cows");
    const after = await w.as((tx) => getMob(tx, bulls.id));
    expect([after.mob.classCode, after.events.length]).toEqual(["breeding_bulls", 1]);
    expect((await w.as((tx) => listMovements(tx))).length).toBe(1);
    const match = await send("r3_steers_bulls");
    expect(match.status).toBe(201);
    expect((await w.as((tx) => getMob(tx, bulls.id))).mob.classCode).toBe("r3_steers_bulls");
    expect((await w.as((tx) => listMovements(tx))).length).toBe(1);
  });
});
