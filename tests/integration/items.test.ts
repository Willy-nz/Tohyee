import { afterAll, beforeAll, expect, it } from "vitest";
import * as itemsRoute from "@/app/api/items/route";
import * as lineDefaultsRoute from "@/app/api/items/line-defaults/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { approveBill, createBill } from "@/lib/bills/service";
import { type Contact, createContact, updateContact } from "@/lib/contacts/service";
import { approveCreditNote, createCreditNote } from "@/lib/credit-notes/service";
import { createPriceLevel } from "@/lib/customers/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, updateInvoice } from "@/lib/invoices/service";
import { itemLineDefaults } from "@/lib/items/lines";
import { addItemUnit, createItem, type Item, listItems, updateItem, updateItemUnit } from "@/lib/items/service";
import { getJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { approveSupplierCreditNote, createSupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { createTaxCode } from "@/lib/tax/codes";
import {
  apiRequest,
  createTestOrganisation,
  createTestUser,
  describeWithDatabase,
  inOrganisation,
  key,
  sessionCookieFor,
  startTestServer,
  type TestServer,
} from "../helpers/test-server";

const noContext = undefined as unknown;

/** Examples IT1-IT9 in docs/ACCOUNTING-EXAMPLES.md ("Products and services"). Each test gets its own organisation. */
describeWithDatabase("products and services", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("items-owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("items-viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup(options: { advanced?: boolean } = {}) {
    organisations += 1;
    const org = `items-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    if (options.advanced) await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const contact = async (name: string, extra: Record<string, unknown>): Promise<Contact> =>
      (await as((tx) => createContact(tx, { idempotencyKey: key("c"), name, ...extra }))).contact;
    const paw = await contact("Paw Supplies", { isSupplier: true });
    const kobe = await contact("Kobe Ltd", { isCustomer: true });
    const rata = await contact("Rata Ltd", { isCustomer: true });
    const item = async (fields: Record<string, unknown>): Promise<Item> =>
      (await as((tx) => createItem(tx, { idempotencyKey: key("item"), ...fields }))).item;
    const widget = await item({
      code: "WIDGET",
      name: "Widget",
      itemType: "stock",
      salePrice: "12.00",
      purchasePrice: "5.00",
      incomeAccountCode: "4000",
      purchaseAccountCode: "1400",
      salesTaxCode: "GST",
      purchaseTaxCode: "GST",
    });
    const invoice = (contactId: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
      as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("inv"),
          contactId,
          invoiceDate: "2026-06-15",
          dueDate: "2026-07-15",
          amountsMode: "exclusive",
          lines,
          ...extra,
        }),
      ).then((result) => result.invoice);
    const bill = (contactId: string, lines: unknown[]) =>
      as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId,
          billDate: "2026-06-15",
          dueDate: "2026-07-15",
          supplierInvoiceNumber: key("S"),
          amountsMode: "exclusive",
          lines,
        }),
      ).then((result) => result.bill);
    // Stock to sell (stock tracking, ST1): a bill of 10 WIDGETs at 5.00.
    const receive = async (quantity = "10") => {
      const draft = await as((tx) =>
        createBill(tx, { idempotencyKey: key("bill"), contactId: paw.id, billDate: "2026-06-01", dueDate: "2026-07-15", supplierInvoiceNumber: key("S"), amountsMode: "exclusive", lines: [{ itemId: widget.id, quantity }] }),
      );
      await as((tx) => approveBill(tx, draft.bill.id, { idempotencyKey: key("a") }));
    };
    const journalLines = async (journalId: string) =>
      (await as((tx) => getJournal(tx, journalId))).lines.map((line) => [line.accountCode, line.debitAmount, line.creditAmount]);
    return { org, as, paw, kobe, rata, item, widget, invoice, bill, contact, journalLines, receive };
  }

  it("IT1: the item list for everyone: unique codes, archived never deleted, type fixed once used, idempotent", async () => {
    const w = await setup();
    expect(w.widget).toMatchObject({ code: "WIDGET", itemType: "stock", salePrice: "12", purchasePrice: "5", incomeAccountCode: "4000", purchaseAccountCode: "1400", baseUnit: "each" });
    await w.item({ code: "ENGRAVE", name: "Engraving", itemType: "service", salePrice: "25", incomeAccountCode: "4000", salesTaxCode: "GST" });
    await w.item({ code: "GIFTBOX", name: "Gift box", itemType: "non_stock", purchasePrice: "2", purchaseAccountCode: "5100", purchaseTaxCode: "GST" });
    await expect(w.item({ code: "widget", name: "Other", itemType: "service" })).rejects.toThrow("already an item with the code widget");
    await expect(w.item({ code: "BAD", name: "Bad", itemType: "service", incomeAccountCode: "6010" })).rejects.toThrow("must be a revenue account");
    await expect(w.item({ code: "BAD", name: "Bad", itemType: "service", purchaseAccountCode: "1100" })).rejects.toThrow("accounts receivable");

    // Idempotent.
    const retryKey = key("retry");
    const first = await w.as((tx) => createItem(tx, { idempotencyKey: retryKey, code: "MUG", name: "Mug", itemType: "non_stock" }));
    const again = await w.as((tx) => createItem(tx, { idempotencyKey: retryKey, code: "MUG", name: "Mug", itemType: "non_stock" }));
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    await expect(w.as((tx) => createItem(tx, { idempotencyKey: retryKey, code: "MUG2", name: "Mug", itemType: "non_stock" }))).rejects.toThrow(
      "already used for a different item",
    );

    // A draft with WIDGET, then WIDGET archived: the draft can still be saved and approved, but a new line can't pick it.
    await w.receive();
    const draft = await w.invoice(w.kobe.id, [{ itemId: w.widget.id, quantity: "1" }]);
    await w.as((tx) => updateItem(tx, w.widget.id, { isActive: false }));
    await expect(w.as((tx) => updateItem(tx, w.widget.id, { itemType: "non_stock" }))).rejects.toThrow("type can't change");
    await expect(w.invoice(w.kobe.id, [{ itemId: w.widget.id, quantity: "1" }])).rejects.toThrow("WIDGET is archived");
    await w.as((tx) => updateInvoice(tx, draft.id, { reference: "Kept" }));
    expect((await w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("a") }))).invoice.status).toBe("approved");
    expect((await w.as((tx) => listItems(tx))).items.map((i) => i.code)).not.toContain("WIDGET");
    expect((await w.as((tx) => listItems(tx, { includeArchived: "true" }))).items.map((i) => i.code)).toContain("WIDGET");
    await expect(w.as((tx) => tx.query("delete from items where id = $1", [w.widget.id]))).rejects.toThrow("can't be deleted");
  });

  it("IT2: picking an item fills an invoice line; the draft can change it; journals as usual", async () => {
    const w = await setup();
    const draft = await w.invoice(w.kobe.id, [
      { itemId: w.widget.id, quantity: "4" },
      { description: "Postage", quantity: "1", unitPrice: "5", accountCode: "4100", taxCode: "GST" },
    ]);
    expect(draft.lines[0]).toMatchObject({
      itemId: w.widget.id,
      itemCode: "WIDGET",
      description: "Widget",
      unitPrice: "12",
      accountCode: "4000",
      taxCode: "GST",
      lineAmount: "48.00",
      taxAmount: "7.20",
      unitId: null,
      baseQuantity: "4",
    });
    expect(draft.lines[1]).toMatchObject({ itemId: null, baseQuantity: null, lineAmount: "5.00" });

    const cheaper = await w.as((tx) =>
      updateInvoice(tx, draft.id, { lines: [{ itemId: w.widget.id, quantity: "4", unitPrice: "11.50", description: "Widget (special)" }] }),
    );
    expect(cheaper.lines[0]).toMatchObject({ unitPrice: "11.5", description: "Widget (special)", lineAmount: "46.00" });

    await w.receive();
    const plain = await w.invoice(w.kobe.id, [{ itemId: w.widget.id, quantity: "4" }]);
    const approved = (await w.as((tx) => approveInvoice(tx, plain.id, { idempotencyKey: key("a") }))).invoice;
    expect(await w.journalLines(approved.approvalJournalId!)).toEqual([
      ["1100", "55.20", "0.00"],
      ["4000", "0.00", "48.00"],
      ["2100", "0.00", "7.20"],
      // WIDGET is a stock item, so stock tracking adds its cost of sales (ST2).
      ["5000", "20.00", "0.00"],
      ["1400", "0.00", "20.00"],
    ]);

    const credit = await w.as((tx) =>
      createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: w.kobe.id,
        creditNoteDate: "2026-06-20",
        amountsMode: "exclusive",
        lines: [{ itemId: w.widget.id, quantity: "1" }],
        returnInvoiceId: approved.id,
      }),
    );
    const cn = (await w.as((tx) => approveCreditNote(tx, credit.creditNote.id, { idempotencyKey: key("a") }))).creditNote;
    expect(cn.lines[0]).toMatchObject({ itemId: w.widget.id, unitPrice: "12", lineAmount: "12.00" });
    expect(await w.journalLines(cn.approvalJournalId!)).toEqual([
      ["4000", "12.00", "0.00"],
      ["2100", "1.80", "0.00"],
      ["1100", "0.00", "13.80"],
      // The returned WIDGET goes back into stock at its sale's cost (ST5).
      ["1400", "5.00", "0.00"],
      ["5000", "0.00", "5.00"],
    ]);

    // An item with no sale price needs the price typed.
    const noPrice = await w.item({ code: "CUSTOM", name: "Custom piece", itemType: "service", incomeAccountCode: "4000", salesTaxCode: "GST" });
    await expect(w.invoice(w.kobe.id, [{ itemId: noPrice.id, quantity: "1" }])).rejects.toThrow("no sale price, so type a unit price");
    // A unit with no item is refused.
    await expect(w.invoice(w.kobe.id, [{ unitId: "1", description: "x", quantity: "1", unitPrice: "1", accountCode: "4000", taxCode: "GST" }])).rejects.toThrow(
      "has a unit but no item",
    );
  });

  it("IT3: picking an item fills bill and supplier credit note lines", async () => {
    const w = await setup();
    const giftBox = await w.item({ code: "GIFTBOX", name: "Gift box", itemType: "non_stock", purchasePrice: "2.00", purchaseAccountCode: "5100", purchaseTaxCode: "GST" });
    const draft = await w.bill(w.paw.id, [{ itemId: giftBox.id, quantity: "10" }]);
    expect(draft.lines[0]).toMatchObject({ description: "Gift box", unitPrice: "2", accountCode: "5100", taxCode: "GST", lineAmount: "20.00" });
    const approved = (await w.as((tx) => approveBill(tx, draft.id, { idempotencyKey: key("a") }))).bill;
    expect(await w.journalLines(approved.approvalJournalId!)).toEqual([
      ["5100", "20.00", "0.00"],
      ["2100", "3.00", "0.00"],
      ["2000", "0.00", "23.00"],
    ]);
    const scn = await w.as((tx) =>
      createSupplierCreditNote(tx, {
        idempotencyKey: key("scn"),
        contactId: w.paw.id,
        creditNoteDate: "2026-06-20",
        supplierCreditNoteNumber: "CR-1",
        amountsMode: "exclusive",
        lines: [{ itemId: giftBox.id, quantity: "1" }],
      }),
    );
    const approvedCredit = (await w.as((tx) => approveSupplierCreditNote(tx, scn.creditNote.id, { idempotencyKey: key("a") }))).creditNote;
    expect(approvedCredit.lines[0]).toMatchObject({ itemId: giftBox.id, lineAmount: "2.00" });
    expect(await w.journalLines(approvedCredit.approvalJournalId!)).toEqual([
      ["2000", "2.30", "0.00"],
      ["5100", "0.00", "2.00"],
      ["2100", "0.00", "0.30"],
    ]);
  });

  it("IT4: price levels price items, with an item's own price for a level winning", async () => {
    const w = await setup({ advanced: true });
    const levels = await w.as((tx) => createPriceLevel(tx, { name: "Wholesale", markupPercent: "-10" }));
    const wholesale = levels.priceLevels.find((l) => l.name === "Wholesale")!;
    const tradePlus = (await w.as((tx) => createPriceLevel(tx, { name: "Trade plus", markupPercent: "5" }))).priceLevels.find((l) => l.name === "Trade plus")!;
    const kobe = await w.as((tx) => updateContact(tx, w.kobe.id, { priceLevelId: wholesale.id }));
    await w.as((tx) => updateContact(tx, w.rata.id, { priceLevelId: tradePlus.id }));
    const other = await w.contact("Third Ltd", { isCustomer: true });
    const price = (contactId: string, itemId = w.widget.id) =>
      w.as((tx) => itemLineDefaults(tx, { itemId, side: "sale", contactId })).then((d) => d.unitPrice);
    expect(await price(kobe.id)).toBe("10.8");
    expect(await price(w.rata.id)).toBe("12.6");
    expect(await price(other.id)).toBe("12");
    const cheap = await w.item({ code: "CHEAP", name: "Cheap", itemType: "service", salePrice: "9.99", incomeAccountCode: "4000", salesTaxCode: "GST" });
    expect(await price(kobe.id, cheap.id)).toBe("8.99");
    expect(await price(w.rata.id, cheap.id)).toBe("10.49");

    // The invoice line picks up the level's price.
    const draft = await w.invoice(kobe.id, [{ itemId: w.widget.id, quantity: "4" }]);
    expect(draft.lines[0]).toMatchObject({ unitPrice: "10.8", lineAmount: "43.20" });

    await w.as((tx) => updateItem(tx, w.widget.id, { levelPrices: [{ priceLevelId: wholesale.id, price: "10.00" }] }));
    expect(await price(kobe.id)).toBe("10");
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    expect(await price(kobe.id)).toBe("12");
    // The item keeps its level price while the switch is off.
    expect((await w.as((tx) => listItems(tx))).items.find((i) => i.code === "WIDGET")!.levelPrices).toEqual([
      { priceLevelId: wholesale.id, priceLevelName: "Wholesale", price: "10" },
    ]);
  });

  it("IT5: units of measure: lines record the unit and the exact base quantity", async () => {
    const w = await setup({ advanced: true });
    const withBox = await w.as((tx) => addItemUnit(tx, w.widget.id, { name: "Box of 12", factor: "12" }));
    const box = withBox.units[0];
    expect(box).toMatchObject({ name: "Box of 12", factor: "12" });
    const draft = await w.invoice(w.kobe.id, [{ itemId: w.widget.id, unitId: box.id, quantity: "2" }]);
    expect(draft.lines[0]).toMatchObject({ unitId: box.id, unitName: "Box of 12", unitPrice: "144", lineAmount: "288.00", baseQuantity: "24" });
    const pack = (await w.as((tx) => addItemUnit(tx, w.widget.id, { name: "Pack of 3", factor: "3" }))).units.find((u) => u.name === "Pack of 3")!;
    const exact = await w.invoice(w.kobe.id, [{ itemId: w.widget.id, unitId: pack.id, quantity: "0.3333", unitPrice: "36" }]);
    expect(exact.lines[0].baseQuantity).toBe("0.9999");

    await expect(w.as((tx) => updateItemUnit(tx, box.id, { factor: "10" }))).rejects.toThrow("size can't change");
    await expect(w.as((tx) => tx.query("update item_units set factor = 10 where id = $1", [box.id]))).rejects.toThrow("size can't change");
    await expect(w.as((tx) => addItemUnit(tx, w.widget.id, { name: "Each", factor: "2" }))).rejects.toThrow("already the base unit");
    const candle = await w.item({ code: "CANDLE", name: "Candle", itemType: "stock", salePrice: "4", incomeAccountCode: "4000", salesTaxCode: "GST" });
    await expect(w.invoice(w.kobe.id, [{ itemId: candle.id, unitId: box.id, quantity: "1" }])).rejects.toThrow("isn't one of CANDLE's units");
    // The item's sale unit is where sales start.
    await w.as((tx) => updateItem(tx, w.widget.id, { saleUnitId: box.id }));
    expect(await w.as((tx) => itemLineDefaults(tx, { itemId: w.widget.id, side: "sale", contactId: w.kobe.id }))).toMatchObject({ unitId: box.id, unitPrice: "144" });
    // Archived units can't be picked on new lines.
    await expect(w.as((tx) => updateItemUnit(tx, box.id, { isActive: false }))).rejects.toThrow("sale or purchase unit");
    await w.as((tx) => updateItemUnit(tx, pack.id, { isActive: false }));
    await expect(w.invoice(w.kobe.id, [{ itemId: w.widget.id, unitId: pack.id, quantity: "1" }])).rejects.toThrow("Pack of 3 is archived");

    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    await expect(w.as((tx) => addItemUnit(tx, w.widget.id, { name: "Crate", factor: "48" }))).rejects.toThrow("Advanced reporting is off");
  });

  it("IT6: supplier prices fill bill lines; one preferred", async () => {
    const w = await setup({ advanced: true });
    const otago = await w.contact("Otago Wholesale", { isSupplier: true });
    await w.as((tx) =>
      updateItem(tx, w.widget.id, {
        suppliers: [
          { contactId: w.paw.id, price: "4.80", supplierItemCode: "PS-W1", isPreferred: true },
          { contactId: otago.id, price: null },
        ],
      }),
    );
    const fromPaw = await w.bill(w.paw.id, [{ itemId: w.widget.id, quantity: "10" }]);
    expect(fromPaw.lines[0]).toMatchObject({ unitPrice: "4.8", accountCode: "1400", lineAmount: "48.00" });
    const fromOtago = await w.bill(otago.id, [{ itemId: w.widget.id, quantity: "10" }]);
    expect(fromOtago.lines[0]).toMatchObject({ unitPrice: "5", lineAmount: "50.00" });
    await expect(
      w.as((tx) => updateItem(tx, w.widget.id, { suppliers: [{ contactId: w.paw.id, isPreferred: true }, { contactId: otago.id, isPreferred: true }] })),
    ).rejects.toThrow("Only one supplier can be preferred");
    await expect(w.as((tx) => updateItem(tx, w.widget.id, { suppliers: [{ contactId: w.kobe.id }] }))).rejects.toThrow("isn't a supplier");
    const saved = (await w.as((tx) => listItems(tx))).items.find((i) => i.code === "WIDGET")!;
    expect(saved.suppliers).toEqual([
      { contactId: w.paw.id, contactName: "Paw Supplies", price: "4.8", supplierItemCode: "PS-W1", isPreferred: true },
      { contactId: otago.id, contactName: "Otago Wholesale", price: null, supplierItemCode: null, isPreferred: false },
    ]);
  });

  it("IT7: kits bundle other items; no kits in kits; kits aren't bought", async () => {
    const w = await setup({ advanced: true });
    const candle = await w.item({ code: "CANDLE", name: "Candle", itemType: "stock", salePrice: "6", purchasePrice: "2", incomeAccountCode: "4000", purchaseAccountCode: "1400", salesTaxCode: "GST", purchaseTaxCode: "GST" });
    const kit = await w.item({
      code: "GIFT-SET",
      name: "Gift set",
      itemType: "kit",
      salePrice: "30.00",
      incomeAccountCode: "4100",
      salesTaxCode: "GST",
      components: [
        { itemId: w.widget.id, quantity: "1" },
        { itemId: candle.id, quantity: "2" },
      ],
    });
    expect(kit.components.map((c) => [c.code, c.quantity])).toEqual([
      ["CANDLE", "2"],
      ["WIDGET", "1"],
    ]);
    const draft = await w.invoice(w.kobe.id, [{ itemId: kit.id, quantity: "1" }]);
    expect(draft.lines[0]).toMatchObject({ unitPrice: "30", accountCode: "4100", lineAmount: "30.00" });

    await expect(w.item({ code: "BIG-SET", name: "Big set", itemType: "kit", components: [{ itemId: kit.id, quantity: "1" }] })).rejects.toThrow(
      "Kits can't be inside other kits",
    );
    await expect(w.item({ code: "EMPTY", name: "Empty", itemType: "kit", components: [] })).rejects.toThrow("needs at least one component");
    await expect(w.bill(w.paw.id, [{ itemId: kit.id, quantity: "1", unitPrice: "10", accountCode: "5100", taxCode: "GST" }])).rejects.toThrow("Kits are sold, not bought");
    await expect(w.as((tx) => updateItem(tx, candle.id, { itemType: "kit" }))).rejects.toThrow("part of a kit");
    await expect(w.as((tx) => tx.query("insert into kit_components (kit_item_id, component_item_id, quantity) values ($1, $1, 1)", [kit.id]))).rejects.toThrow();
  });

  it("IT8: with Advanced reporting off, NetSuite's extras can't be set but are kept", async () => {
    const w = await setup({ advanced: true });
    const levels = await w.as((tx) => createPriceLevel(tx, { name: "Wholesale", markupPercent: "-10" }));
    const wholesale = levels.priceLevels[0];
    await w.as((tx) => updateItem(tx, w.widget.id, { levelPrices: [{ priceLevelId: wholesale.id, price: "10" }], suppliers: [{ contactId: w.paw.id, price: "4.5" }] }));
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    await expect(w.item({ code: "KIT", name: "Kit", itemType: "kit", components: [{ itemId: w.widget.id, quantity: "1" }] })).rejects.toThrow("Advanced reporting is off");
    await expect(w.as((tx) => updateItem(tx, w.widget.id, { levelPrices: [{ priceLevelId: wholesale.id, price: "9" }] }))).rejects.toThrow("Advanced reporting is off");
    await expect(w.as((tx) => updateItem(tx, w.widget.id, { suppliers: [{ contactId: w.paw.id, price: "4" }] }))).rejects.toThrow("Advanced reporting is off");
    // Other changes still save, and the extras are kept.
    const renamed = await w.as((tx) => updateItem(tx, w.widget.id, { name: "Widget (blue)" }));
    expect(renamed.levelPrices).toHaveLength(1);
    expect(renamed.suppliers).toHaveLength(1);
    // Bills use the item's own purchase price while the switch is off.
    const bill = await w.bill(w.paw.id, [{ itemId: w.widget.id, quantity: "1" }]);
    expect(bill.lines[0].unitPrice).toBe("5");
  });

  it("IT9: the items API: list for viewers, add for bookkeepers, and line defaults", async () => {
    const w = await setup();
    const cookie = await sessionCookieFor(owner);
    const viewerCookie = await sessionCookieFor(viewer);
    const list = await itemsRoute.GET(apiRequest(`/api/items?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: Item[] }).items.map((i) => i.code)).toEqual(["WIDGET"]);
    const body = { organisationId: w.org, idempotencyKey: key("api"), code: "ENGRAVE", name: "Engraving", itemType: "service", salePrice: "25" };
    expect((await itemsRoute.POST(apiRequest("/api/items", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    expect((await itemsRoute.POST(apiRequest("/api/items", { method: "POST", cookie, body }), noContext)).status).toBe(201);
    expect((await itemsRoute.POST(apiRequest("/api/items", { method: "POST", cookie, body }), noContext)).status).toBe(200);
    const defaults = await lineDefaultsRoute.GET(
      apiRequest(`/api/items/line-defaults?organisationId=${w.org}&itemId=${w.widget.id}&side=sale&contactId=${w.kobe.id}`, { cookie: viewerCookie }),
      noContext,
    );
    expect(await defaults.json()).toEqual({ itemId: w.widget.id, unitId: null, description: "Widget", unitPrice: "12", accountCode: "4000", taxCode: "GST" });
  });
});
