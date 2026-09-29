import { afterAll, beforeAll, expect, it } from "vitest";
import * as fieldsRoute from "@/app/api/custom-fields/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { listBankAccounts } from "@/lib/bank/accounts";
import { createBankTransaction } from "@/lib/bank/transactions";
import { createBill } from "@/lib/bills/service";
import { createContact, listContacts, updateContact } from "@/lib/contacts/service";
import { createCreditNote } from "@/lib/credit-notes/service";
import {
  addCustomFieldOption,
  createCustomField,
  getCustomFieldSetup,
  updateCustomField,
  updateCustomFieldOption,
} from "@/lib/custom-fields/service";
import { type CustomFieldSetup, copyableValuesFor } from "@/lib/custom-fields/values";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { approveInvoice, createInvoice, getInvoice, updateInvoice } from "@/lib/invoices/service";
import { correctJournal, getJournal, postJournal } from "@/lib/ledger/journals";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { profitAndLossSplit } from "@/lib/reports/financial";
import { createTaxCode } from "@/lib/tax/codes";
import {
  createTrackingCategory,
  createTrackingValue,
  getTrackingSetup,
  MAX_CUSTOM_SEGMENTS,
  updateTrackingCategory,
} from "@/lib/tracking/service";
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

/**
 * Examples CS1-CS3 and CF1-CF10 in docs/ACCOUNTING-EXAMPLES.md ("Custom
 * segments and custom fields"). Each test gets its own organisation.
 */
describeWithDatabase("custom segments and custom fields", () => {
  let server: TestServer;
  let owner: SessionUser;
  let viewer: SessionUser;
  let organisations = 0;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("owner@example.com", { serverAdmin: true });
    viewer = await createTestUser("viewer@example.com");
  });

  afterAll(async () => {
    await server?.teardown();
  });

  async function setup() {
    organisations += 1;
    const org = `custom-${organisations}-co`;
    await createTestOrganisation(owner, org);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')", [org, viewer.id]);
    const as = <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(org, { userId: owner.id, email: owner.email }, work);
    await as((tx) =>
      createTaxCode(tx, { idempotencyKey: key("tax"), code: "GST", label: "GST (15%)", category: "standard", rate: "0.15", effectiveFrom: "2026-01-01" }),
    );
    await as((tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const field = async (input: Parameters<typeof createCustomField>[1]) => {
      const s = await as((tx) => createCustomField(tx, input));
      return s.fields.find((entry) => entry.label === input.label && entry.record === input.record)!;
    };
    const petName = await field({ record: "contact", label: "Pet name", type: "text", usedOn: ["customer"] });
    const channel = await field({
      record: "contact",
      label: "Channel",
      type: "list",
      usedOn: ["customer"],
      isRequired: true,
      showInList: true,
      options: ["Shopify", "Market", "Wholesale"],
    });
    const opt = (name: string) => channel.options.find((option) => option.name === name)!.id;
    const proofSent = await field({ record: "document", label: "Engraving proof sent", type: "checkbox", usedOn: ["invoice"] });
    const grantCode = await field({ record: "document", label: "Grant code", type: "text", usedOn: ["bill", "spend"], defaultValue: "GEN" });
    const approvedBy = await field({ record: "document", label: "Approved by", type: "text", usedOn: ["journal"] });
    const engraving = await field({ record: "line", label: "Engraving text", type: "text", usedOn: ["invoice", "credit_note"], isRequired: true });
    const hours = await field({ record: "line", label: "Hours", type: "decimal", usedOn: ["bill", "journal"] });
    const kobe = (
      await as((tx) =>
        createContact(tx, {
          idempotencyKey: key("contact"),
          name: "Kobe Ltd",
          isCustomer: true,
          isSupplier: true,
          customFields: { [petName.id]: "Rex", [channel.id]: opt("Market") },
        }),
      )
    ).contact;
    const line = (amount: string, customFields?: Record<string, unknown>, accountCode = "4000") => ({
      description: "Item",
      quantity: "1",
      unitPrice: amount,
      accountCode,
      taxCode: "GST",
      ...(customFields ? { customFields } : {}),
    });
    const draftInvoice = (lines: unknown[], customFields?: Record<string, unknown>) =>
      as((tx) =>
        createInvoice(tx, {
          idempotencyKey: key("invoice"),
          contactId: kobe.id,
          invoiceDate: "2026-06-10",
          dueDate: "2026-07-10",
          amountsMode: "exclusive",
          lines,
          ...(customFields ? { customFields } : {}),
        }),
      );
    let bills = 0;
    const draftBill = (lines: unknown[], customFields?: Record<string, unknown>) => {
      bills += 1;
      return as((tx) =>
        createBill(tx, {
          idempotencyKey: key("bill"),
          contactId: kobe.id,
          billDate: "2026-06-12",
          dueDate: "2026-07-12",
          supplierInvoiceNumber: `B-${bills}`,
          amountsMode: "exclusive",
          lines,
          ...(customFields ? { customFields } : {}),
        }),
      );
    };
    return { org, as, kobe, petName, channel, opt, proofSent, grantCode, approvedBy, engraving, hours, line, draftInvoice, draftBill, field };
  }

  it("CS1: a custom segment works like the built-in categories", async () => {
    const w = await setup();
    let s = await w.as((tx) => createTrackingCategory(tx, { name: "Grant" }));
    const grant = s.categories.find((c) => c.name === "Grant")!;
    expect(grant.kind).toBe("custom");
    s = await w.as((tx) => createTrackingValue(tx, { categoryId: grant.id, name: "Lotteries" }));
    await w.as((tx) => createTrackingValue(tx, { categoryId: grant.id, name: "Council" }));
    const lotteries = s.categories.find((c) => c.id === grant.id)!.values.find((v) => v.name === "Lotteries")!.id;
    const { invoice } = await w.draftInvoice([{ ...w.line("100.00", { [w.engraving.id]: "Kobe" }), tracking: { [grant.id]: lotteries } }]);
    const approved = (await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }))).invoice;
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.find((l) => l.accountCode === "4000")).toMatchObject({ creditAmount: "100.00", tracking: { [grant.id]: lotteries } });
    const split = await w.as((tx) => profitAndLossSplit(tx, { from: "2026-06-01", to: "2026-06-30", categoryId: grant.id }));
    expect(split.revenue.totals[lotteries]).toBe("100.00");
    await expect(w.as((tx) => createTrackingCategory(tx, { name: "grant" }))).rejects.toThrow("There's already a category called grant.");
  });

  it("CS2: archiving a segment hides it from new lines but keeps old ones", async () => {
    const w = await setup();
    let s = await w.as((tx) => createTrackingCategory(tx, { name: "Grant" }));
    const grant = s.categories.find((c) => c.name === "Grant")!;
    s = await w.as((tx) => createTrackingValue(tx, { categoryId: grant.id, name: "Lotteries" }));
    const lotteries = s.categories.find((c) => c.id === grant.id)!.values[0].id;
    const tagged = (lines: number) =>
      Array.from({ length: lines }, () => ({ ...w.line("100.00", { [w.engraving.id]: "Kobe" }), tracking: { [grant.id]: lotteries } }));
    const approvedFirst = (await w.draftInvoice(tagged(1))).invoice;
    await w.as((tx) => approveInvoice(tx, approvedFirst.id, { idempotencyKey: key("approve") }));
    const draft = (await w.draftInvoice(tagged(1))).invoice;
    await w.as((tx) => updateTrackingCategory(tx, grant.id, { isActive: false }));
    await expect(w.draftInvoice(tagged(1))).rejects.toThrow("Line 1: Grant is archived.");
    const split = await w.as((tx) => profitAndLossSplit(tx, { from: "2026-06-01", to: "2026-06-30", categoryId: grant.id }));
    expect(split.revenue.totals[lotteries]).toBe("100.00");
    await w.as((tx) => approveInvoice(tx, draft.id, { idempotencyKey: key("approve") }));
    await w.as((tx) => updateTrackingCategory(tx, grant.id, { isActive: true }));
    await w.draftInvoice(tagged(1));
    const department = (await w.as((tx) => getTrackingSetup(tx))).categories.find((c) => c.kind === "department")!;
    await expect(w.as((tx) => updateTrackingCategory(tx, department.id, { isActive: false }))).rejects.toThrow(
      "Department, Class and Location can't be archived.",
    );
    await expect(w.as((tx) => tx.query("delete from tracking_categories where id = $1", [grant.id]))).rejects.toThrow(/can't be deleted/);
  });

  it("CS3: at most 20 segments of the organisation's own", async () => {
    const w = await setup();
    for (let i = 1; i <= MAX_CUSTOM_SEGMENTS; i += 1) await w.as((tx) => createTrackingCategory(tx, { name: `Segment ${i}` }));
    await expect(w.as((tx) => createTrackingCategory(tx, { name: "One too many" }))).rejects.toThrow("at most 20 segments");
  });

  it("CF1: field set-up rules", async () => {
    const w = await setup();
    await expect(w.field({ record: "contact", label: "pet name", type: "text", usedOn: ["supplier"] })).rejects.toThrow(
      "There's already a contact field called pet name.",
    );
    await w.field({ record: "line", label: "Pet name", type: "text", usedOn: ["invoice"] });
    await expect(w.as((tx) => updateCustomField(tx, w.petName.id, { type: "long_text" }))).rejects.toThrow("type and what it's on can't be changed");
    await expect(w.as((tx) => updateCustomField(tx, w.petName.id, { record: "line" }))).rejects.toThrow("type and what it's on can't be changed");
    await expect(w.as((tx) => tx.query("update custom_fields set field_type = 'date' where id = $1", [w.petName.id]))).rejects.toThrow(
      /type and what it's on can't change/,
    );
    await expect(w.field({ record: "document", label: "Checked", type: "checkbox", usedOn: ["bill"], isRequired: true })).rejects.toThrow(
      "A check box can't be required",
    );
    await expect(w.field({ record: "contact", label: "Tier", type: "list", usedOn: ["customer"] })).rejects.toThrow("A list needs at least one option.");
    await expect(w.field({ record: "line", label: "Weight", type: "decimal", usedOn: ["bill"], defaultValue: "abc" })).rejects.toThrow(
      "Weight default: must be a number",
    );
    expect(w.grantCode.defaultValue).toBe("GEN");
    await expect(w.as((tx) => tx.query("delete from custom_fields where id = $1", [w.petName.id]))).rejects.toThrow(/archive them instead/);
    const tier = await w.field({ record: "contact", label: "Tier", type: "list", usedOn: ["customer"], options: ["Gold", "Silver"], defaultValue: "Silver" });
    expect(tier.defaultValue).toBe(tier.options.find((o) => o.name === "Silver")!.id);
  });

  it("CF2: values are checked by type and stored as typed", async () => {
    const w = await setup();
    const make = (type: Parameters<typeof createCustomField>[1]["type"], label: string) =>
      w.field({ record: "contact", label, type, usedOn: ["customer"] });
    const f = {
      text: w.petName,
      integer: await make("integer", "Count"),
      decimal: await make("decimal", "Weight"),
      money: await make("money", "Deposit"),
      percent: await make("percent", "Discount"),
      date: await make("date", "Since"),
      checkbox: await make("checkbox", "VIP"),
      email: await make("email", "Invoice email"),
      url: await make("url", "Website"),
    };
    const save = (values: Record<string, unknown>) => w.as((tx) => updateContact(tx, w.kobe.id, { customFields: { [w.channel.id]: w.opt("Market"), ...values } }));
    const refused: Array<[string, unknown, string]> = [
      [f.text.id, "x".repeat(301), "Pet name: can be at most 300 characters."],
      [f.integer.id, "12.5", "Count: must be a whole number"],
      [f.decimal.id, "1.1234567", "Weight: must be a number with at most 6 decimal places"],
      [f.money.id, "12.345", "Deposit: must be an amount with at most 2 decimal places"],
      [f.money.id, "1,234.50", "Deposit: must be an amount"],
      [f.percent.id, "101", "Discount: must be a percent from 0 to 100"],
      [f.date.id, "2026-02-30", "Since is not a real date."],
      [w.channel.id, "999999", "Channel: choose one of its options."],
      [f.email.id, "not an email", "Invoice email: must be an email address"],
      [f.url.id, "ftp://x", "Website: must be a web address"],
    ];
    for (const [id, value, message] of refused) await expect(save({ [id]: value })).rejects.toThrow(message);
    const saved = await save({
      [f.money.id]: "12.5",
      [f.decimal.id]: "3.250",
      [f.integer.id]: "012",
      [f.percent.id]: "12.50",
      [f.checkbox.id]: true,
      [f.date.id]: "2026-06-01",
    });
    expect(saved.customFields).toMatchObject({
      [f.money.id]: "12.50",
      [f.decimal.id]: "3.25",
      [f.integer.id]: "12",
      [f.percent.id]: "12.5",
      [f.checkbox.id]: true,
      [f.date.id]: "2026-06-01",
    });
    // An unticked box and blanks are "not set".
    const cleared = await save({ [f.checkbox.id]: false, [f.money.id]: "" });
    expect(cleared.customFields[f.checkbox.id]).toBeUndefined();
    expect(cleared.customFields[f.money.id]).toBeUndefined();
  });

  it("CF3: contacts: required, defaults, roles, list column and history", async () => {
    const w = await setup();
    await expect(w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "No channel", isCustomer: true, customFields: {} }))).rejects.toThrow(
      "Channel is required.",
    );
    await w.as((tx) => updateCustomField(tx, w.channel.id, { defaultValue: w.opt("Shopify") }));
    const defaulted = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Defaulted", isCustomer: true }))).contact;
    expect(defaulted.customFields).toEqual({ [w.channel.id]: w.opt("Shopify") });
    const supplier = (await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Supplies Ltd", isSupplier: true }))).contact;
    expect(supplier.customFields).toEqual({});
    await expect(w.as((tx) => updateContact(tx, supplier.id, { customFields: { [w.petName.id]: "Rex" } }))).rejects.toThrow(
      "Pet name isn't used on suppliers.",
    );
    const listed = await w.as((tx) => listContacts(tx));
    expect(listed.find((c) => c.id === w.kobe.id)!.customFields[w.channel.id]).toBe(w.opt("Market"));
    expect(w.channel.showInList).toBe(true);
    await w.as((tx) => updateContact(tx, w.kobe.id, { customFields: { [w.petName.id]: "Rex", [w.channel.id]: w.opt("Shopify") } }));
    const history = await w.as((tx) =>
      tx.query<{ details: { changes: Record<string, { from: Record<string, unknown>; to: Record<string, unknown> }> } }>(
        "select details from audit_events where event_type = 'contact.updated' and entity_id = $1 order by id",
        [w.kobe.id],
      ),
    );
    const change = history.rows.at(-1)!.details.changes.customFields;
    expect(change.from[w.channel.id]).toBe(w.opt("Market"));
    expect(change.to[w.channel.id]).toBe(w.opt("Shopify"));
  });

  it("CF4: invoice fields; required line field at approval; the journal is unchanged", async () => {
    const w = await setup();
    const { invoice } = await w.draftInvoice([w.line("100.00", { [w.engraving.id]: "Kobe" }), w.line("50.00", {})], { [w.proofSent.id]: true });
    expect(invoice.customFields).toEqual({ [w.proofSent.id]: true });
    expect(invoice.lines.map((l) => l.customFields)).toEqual([{ [w.engraving.id]: "Kobe" }, {}]);
    await expect(w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }))).rejects.toThrow("Line 2 needs Engraving text.");
    await w.as((tx) =>
      updateInvoice(tx, invoice.id, { lines: [w.line("100.00", { [w.engraving.id]: "Kobe" }), w.line("50.00", { [w.engraving.id]: "Rex" })] }),
    );
    const approved = (await w.as((tx) => approveInvoice(tx, invoice.id, { idempotencyKey: key("approve") }))).invoice;
    expect(approved.customFields).toEqual({ [w.proofSent.id]: true });
    const journal = await w.as((tx) => getJournal(tx, approved.approvalJournalId!));
    expect(journal.lines.map((l) => [l.accountCode, l.debitAmount, l.creditAmount, l.customFields])).toEqual([
      ["1100", "172.50", "0.00", {}],
      ["4000", "0.00", "150.00", {}],
      ["2100", "0.00", "22.50", {}],
    ]);
    expect(journal.customFields).toEqual({});
    await expect(w.as((tx) => updateInvoice(tx, invoice.id, { customFields: {} }))).rejects.toThrow(/can't be edited/);
  });

  it("CF5: bill default, a bill line field, and a field not used on bills", async () => {
    const w = await setup();
    const { bill } = await w.draftBill([w.line("40.00", { [w.hours.id]: "2.5" }, "6010")]);
    expect(bill.customFields).toEqual({ [w.grantCode.id]: "GEN" });
    expect(bill.lines[0].customFields).toEqual({ [w.hours.id]: "2.5" });
    await expect(w.draftBill([w.line("40.00", { [w.engraving.id]: "Kobe" }, "6010")])).rejects.toThrow(
      "Line 1: Engraving text isn't used on bill lines.",
    );
  });

  it("CF6: a credit note from an invoice copies only fields used on credit notes", async () => {
    const w = await setup();
    const { invoice } = await w.draftInvoice([w.line("100.00", { [w.engraving.id]: "Kobe" })], { [w.proofSent.id]: true });
    const fields = (await w.as((tx) => getCustomFieldSetup(tx))).fields;
    const body = copyableValuesFor(fields, invoice.customFields, "document", "credit_note");
    const lineValues = copyableValuesFor(fields, invoice.lines[0].customFields, "line", "credit_note");
    expect(body).toEqual({});
    expect(lineValues).toEqual({ [w.engraving.id]: "Kobe" });
    const { creditNote } = await w.as((tx) =>
      createCreditNote(tx, {
        idempotencyKey: key("cn"),
        contactId: w.kobe.id,
        creditNoteDate: "2026-06-15",
        amountsMode: "exclusive",
        lines: [w.line("100.00", lineValues)],
        customFields: body,
      }),
    );
    expect(creditNote.lines[0].customFields).toEqual({ [w.engraving.id]: "Kobe" });
  });

  it("CF7: archived fields and options stay on records that have them", async () => {
    const w = await setup();
    await w.as((tx) => updateCustomField(tx, w.petName.id, { isActive: false }));
    await w.as((tx) => updateCustomFieldOption(tx, w.opt("Market"), { isActive: false }));
    const kept = await w.as((tx) =>
      updateContact(tx, w.kobe.id, { name: "Kobe Limited", customFields: { [w.petName.id]: "Rex", [w.channel.id]: w.opt("Market") } }),
    );
    expect(kept.customFields).toEqual({ [w.petName.id]: "Rex", [w.channel.id]: w.opt("Market") });
    await expect(w.as((tx) => updateContact(tx, w.kobe.id, { customFields: { [w.petName.id]: "Max", [w.channel.id]: w.opt("Market") } }))).rejects.toThrow(
      "Pet name is archived.",
    );
    await expect(
      w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "New", isCustomer: true, customFields: { [w.channel.id]: w.opt("Market") } })),
    ).rejects.toThrow("Channel: Market is archived.");
    const s = await w.as((tx) => addCustomFieldOption(tx, w.channel.id, { name: "Etsy" }));
    expect(s.fields.find((f) => f.id === w.channel.id)!.options.map((o) => o.name)).toEqual(["Shopify", "Market", "Wholesale", "Etsy"]);
    await expect(w.as((tx) => tx.query("delete from custom_field_options where id = $1", [w.opt("Market")]))).rejects.toThrow(/archive them instead/);
  });

  it("CF8: with the setting off, existing values are kept but new ones refused", async () => {
    const w = await setup();
    await w.as((tx) => updateOrganisationSettings(tx, { advancedFeatures: false }));
    const saved = await w.as((tx) => updateContact(tx, w.kobe.id, { phone: "03 555 0000" }));
    expect(saved.customFields).toEqual({ [w.petName.id]: "Rex", [w.channel.id]: w.opt("Market") });
    await w.as((tx) => updateContact(tx, w.kobe.id, { customFields: { [w.petName.id]: "Rex", [w.channel.id]: w.opt("Market") } }));
    await expect(w.as((tx) => updateContact(tx, w.kobe.id, { customFields: { [w.petName.id]: "Max", [w.channel.id]: w.opt("Market") } }))).rejects.toThrow(
      "advanced features are off, so Pet name can't be set.",
    );
    // Required fields aren't asked for while it's off.
    await w.as((tx) => createContact(tx, { idempotencyKey: key("c"), name: "Plain", isCustomer: true }));
  });

  it("CF9: manual journals and corrections", async () => {
    const w = await setup();
    const posted = await w.as((tx) =>
      postJournal(tx, {
        idempotencyKey: key("journal"),
        postingDate: "2026-06-15",
        reference: "Fees",
        customFields: { [w.approvedBy.id]: "Jess" },
        lines: [
          { accountCode: "6010", debitAmount: "25.00", customFields: { [w.hours.id]: "1.5" } },
          { accountCode: "1000", creditAmount: "25.00" },
        ],
      }),
    );
    expect(posted.journal.customFields).toEqual({ [w.approvedBy.id]: "Jess" });
    expect(posted.journal.lines.map((l) => l.customFields)).toEqual([{ [w.hours.id]: "1.5" }, {}]);
    await w.as((tx) => updateCustomField(tx, w.approvedBy.id, { isActive: false }));
    const corrected = await w.as((tx) =>
      correctJournal(tx, {
        idempotencyKey: key("correct"),
        originalJournalId: posted.journal.id,
        postingDate: "2026-06-16",
        reference: "Fees",
        customFields: { [w.approvedBy.id]: "Jess" },
        lines: [
          { accountCode: "6010", debitAmount: "30.00", customFields: { [w.hours.id]: "2" } },
          { accountCode: "1000", creditAmount: "30.00" },
        ],
      }),
    );
    expect(corrected.replacementJournal.customFields).toEqual({ [w.approvedBy.id]: "Jess" });
    expect(corrected.replacementJournal.lines[0].customFields).toEqual({ [w.hours.id]: "2" });
    expect(corrected.reversalJournal.customFields).toEqual({});
    expect(corrected.reversalJournal.lines.every((l) => Object.keys(l.customFields).length === 0)).toBe(true);
  });

  it("CF10: spend money keeps its grant code; receive money can't have it", async () => {
    const w = await setup();
    const bank = (await w.as((tx) => listBankAccounts(tx))).find((account) => account.code === "1000")!;
    const money = (kind: "spend" | "receive", customFields: Record<string, unknown>) =>
      w.as((tx) =>
        createBankTransaction(tx, {
          idempotencyKey: key(kind),
          kind,
          accountId: bank.id,
          contactId: w.kobe.id,
          date: "2026-06-15",
          amountsMode: "exclusive",
          customFields,
          lines: [{ description: "Thing", accountCode: kind === "spend" ? "6010" : "4000", taxCode: "GST", amount: "30.00", customFields: kind === "receive" ? { [w.engraving.id]: "x" } : undefined }],
        }),
      );
    const spend = await money("spend", { [w.grantCode.id]: "LOT-22" });
    expect(spend.bankTransaction.customFields).toEqual({ [w.grantCode.id]: "LOT-22" });
    await expect(money("receive", { [w.grantCode.id]: "LOT-22" })).rejects.toThrow("Grant code isn't used on receive money.");
  });

  it("over HTTP: viewers read the fields; only admins add them", async () => {
    const w = await setup();
    const viewerCookie = await sessionCookieFor(viewer);
    const cookie = await sessionCookieFor(owner);
    const read = await fieldsRoute.GET(apiRequest(`/api/custom-fields?organisationId=${w.org}`, { cookie: viewerCookie }), noContext);
    expect(read.status).toBe(200);
    expect(((await read.json()) as CustomFieldSetup).fields.length).toBe(7);
    const body = { organisationId: w.org, record: "contact", label: "Birthday", type: "date", usedOn: ["customer"] };
    expect((await fieldsRoute.POST(apiRequest("/api/custom-fields", { method: "POST", cookie: viewerCookie, body }), noContext)).status).toBe(403);
    expect((await fieldsRoute.POST(apiRequest("/api/custom-fields", { method: "POST", cookie, body }), noContext)).status).toBe(201);
    // The invoice helper still works for an invoice read back.
    const { invoice } = await w.draftInvoice([w.line("10.00", { [w.engraving.id]: "Kobe" })]);
    expect((await w.as((tx) => getInvoice(tx, invoice.id))).lines[0].customFields).toEqual({ [w.engraving.id]: "Kobe" });
  });
});
