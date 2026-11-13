import { afterAll, beforeAll, expect, it } from "vitest";
import { findAiTool } from "@/lib/ai/catalogue";
import type { ToolContext } from "@/lib/ai/tools";
import type { SessionUser } from "@/lib/auth/sessions";
import { updateOrganisationSettings } from "@/lib/organisations/settings";
import { createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, key, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "ai-document-actions";
type Json = Record<string, unknown>;

/** The sales, purchases and bank screens' actions as AI tools (decision 1600, part 2). Made-up figures. */
describeWithDatabase("AI tools for document actions", () => {
  let server: TestServer;
  let owner: SessionUser;
  const context = (role: ToolContext["role"] = "owner"): ToolContext => ({ role, organisationId: ORG, source: "ai-9", accessLevel: "full", grantedAccessLevel: "full" });
  const call = (name: string, args: Json, role?: ToolContext["role"]) =>
    inOrganisation(ORG, { userId: owner.id, email: owner.email, via: 'AI key "Claude"' }, (tx) => findAiTool(name)!.run(tx, args, context(role))) as Promise<Json>;
  /** First call, then the confirmed one. */
  const confirmed = async (name: string, args: Json) => {
    const first = await call(name, args);
    expect(first).toMatchObject({ preview: true });
    return call(name, { ...args, confirmHash: first.confirmHash, idempotencyKey: key("c") });
  };
  let customerId = "";

  beforeAll(async () => {
    server = await startTestServer({ separateRuntimeLogin: true });
    owner = await createTestUser("owner@document-actions.nz", { serverAdmin: true });
    await createTestOrganisation(owner, ORG);
    customerId = String(((await call("create_contact", { idempotencyKey: key("k"), name: "Aroha Made-up", isCustomer: true })).contact as Json).id);
  });
  afterAll(async () => {
    await server?.teardown();
  });

  const draftInvoice = async () =>
    String(
      (
        (
          await call("create_draft_invoice", {
            idempotencyKey: key("i"),
            contactId: customerId,
            invoiceDate: "2026-06-01",
            dueDate: "2026-06-20",
            amountsMode: "no_tax",
            lines: [{ description: "Pendant", quantity: "1", unitPrice: "100.00", accountCode: "4000" }],
          })
        ).invoice as Json
      ).id,
    );

  it("deleting a draft: shows it, refuses a changed request, then deletes; viewers can't", async () => {
    const invoiceId = await draftInvoice();
    const first = await call("delete_draft_invoice", { invoiceId });
    expect(first).toMatchObject({ preview: true, actsOn: { id: invoiceId, status: "draft", total: "100.00" } });
    await expect(call("delete_draft_invoice", { invoiceId, confirmHash: "not-it", idempotencyKey: key("x") })).rejects.toThrow("Call it again without confirmHash");
    await expect(call("delete_draft_invoice", { invoiceId }, "viewer")).rejects.toThrow("bookkeepers and up");
    expect(await call("delete_draft_invoice", { invoiceId, confirmHash: first.confirmHash, idempotencyKey: key("x") })).toEqual({ deleted: true, invoiceId });
    await expect(call("delete_draft_invoice", { invoiceId })).rejects.toThrow();
  });

  it("voiding an approved invoice reverses it and keeps it", async () => {
    const invoiceId = await draftInvoice();
    await call("approve_invoice", { invoiceId, idempotencyKey: key("a") });
    const done = await confirmed("void_invoice", { invoiceId, voidDate: "2026-06-05" });
    expect(JSON.stringify(done)).toContain("void");
    const after = (await call("get_invoice", { id: invoiceId })) as Json;
    expect(JSON.stringify(after)).toMatch(/"status":"voided"/);
  });

  it("a quote accepted becomes a draft invoice; a sales order is invoiced and closed", async () => {
    const quote = (await call("create_quote", { idempotencyKey: key("q"), contactId: customerId, quoteDate: "2026-06-02", amountsMode: "no_tax", lines: [{ description: "Kit", quantity: "2", unitPrice: "30.00", accountCode: "4000" }] })) as Json;
    const quoteId = String((quote.quote as Json).id);
    await call("finalise_quote", { quoteId, idempotencyKey: key("f") });
    const copy = await call("copy_quote", { quoteId, quoteDate: "2026-06-03", idempotencyKey: key("cq") });
    expect(JSON.stringify(copy)).toContain("draft");
    const accepted = await call("accept_quote", { quoteId, invoiceDate: "2026-06-03", dueDate: "2026-06-20", idempotencyKey: key("ac") });
    expect(JSON.stringify(accepted)).toContain("60.00");

    const order = (await call("create_sales_order", { idempotencyKey: key("so"), contactId: customerId, orderDate: "2026-06-04", amountsMode: "no_tax", lines: [{ description: "Kit", quantity: "3", unitPrice: "30.00", accountCode: "4000" }] })) as Json;
    const salesOrderId = String((order.salesOrder as Json).id);
    await call("approve_sales_order", { salesOrderId, idempotencyKey: key("aso") });
    const lineId = String((((await call("get_sales_order", { salesOrderId })) as Json).lines as Json[])[0].lineId);
    const invoiced = await call("invoice_sales_order", { salesOrderId, invoiceDate: "2026-06-06", dueDate: "2026-06-20", lines: [{ salesOrderLineId: lineId, quantity: "1" }], idempotencyKey: key("iso") });
    expect(JSON.stringify(invoiced)).toContain("30.00");
    // A draft invoice from it stops it closing, as on the screen; approved, it closes.
    await expect(call("close_sales_order", { salesOrderId, idempotencyKey: key("cs0") })).rejects.toThrow("has a draft invoice");
    await call("approve_invoice", { invoiceId: (invoiced.invoice as Json).id, idempotencyKey: key("ai") });
    const closed = await call("close_sales_order", { salesOrderId, idempotencyKey: key("cso") });
    expect(JSON.stringify(closed)).toContain("closed");
    // Another, with nothing invoiced, is cancelled.
    const other = (await call("create_sales_order", { idempotencyKey: key("so2"), contactId: customerId, orderDate: "2026-06-07", amountsMode: "no_tax", lines: [{ description: "Kit", quantity: "1", unitPrice: "30.00", accountCode: "4000" }] })) as Json;
    const otherId = String((other.salesOrder as Json).id);
    await call("approve_sales_order", { salesOrderId: otherId, idempotencyKey: key("aso2") });
    expect(JSON.stringify(await call("cancel_sales_order", { salesOrderId: otherId, idempotencyKey: key("cso2") }))).toContain("cancelled");
  });

  it("part 3: a manual journal, payment terms, and the lock date confirmed first, for owners and admins", async () => {
    const posted = await call("post_journal", {
      postingDate: "2026-06-10",
      reference: "Made-up accrual",
      lines: [
        { accountCode: "6010", debitAmount: "40.00" },
        { accountCode: "3000", creditAmount: "40.00" },
      ],
      idempotencyKey: key("pj"),
    });
    expect(JSON.stringify(posted)).toContain("Made-up accrual");
    await expect(call("create_payment_term", { name: "20th", kind: "day_of_next_month", days: 20 }, "bookkeeper")).rejects.toThrow("owners and admins");
    expect(JSON.stringify(await call("create_payment_term", { name: "20th", kind: "day_of_next_month", days: 20, idempotencyKey: key("pt") }))).toContain("20th");
    const lock = await call("set_lock_date", { lockDate: "2026-05-31", reason: "May GST filed" });
    expect(lock).toMatchObject({ preview: true, actsOn: { lockDate: null } });
    expect(await call("set_lock_date", { lockDate: "2026-05-31", reason: "May GST filed", confirmHash: lock.confirmHash, idempotencyKey: key("ld") })).toMatchObject({ lockDate: "2026-05-31" });
    await expect(
      call("post_journal", { postingDate: "2026-05-20", reference: "Too late", lines: [{ accountCode: "6010", debitAmount: "1.00" }, { accountCode: "3000", creditAmount: "1.00" }], idempotencyKey: key("pj2") }),
    ).rejects.toThrow(/lock/i);
    const unlock = await call("set_lock_date", { lockDate: null, reason: "Test done" });
    await call("set_lock_date", { lockDate: null, reason: "Test done", confirmHash: unlock.confirmHash, idempotencyKey: key("ul") });
  });

  it("custom fields: add \"Pet's name\" on invoices and a list on lines, then fill one in on an invoice", async () => {
    await expect(call("create_custom_field", { record: "document", label: "Pet's name", type: "text", usedOn: ["invoice"] }, "bookkeeper")).rejects.toThrow("owners and admins");
    // Fields on documents and lines need Advanced reporting on, as on the screen.
    await expect(call("create_custom_field", { record: "document", label: "Pet's name", type: "text", usedOn: ["invoice"], idempotencyKey: key("cf0") })).rejects.toThrow("Advanced reporting is off");
    await inOrganisation(ORG, { userId: owner.id, email: owner.email }, (tx) => updateOrganisationSettings(tx, { advancedFeatures: true }));
    const setup = await call("create_custom_field", { record: "document", label: "Pet's name", type: "text", usedOn: ["invoice"], idempotencyKey: key("cf") });
    const fields = (setup.fields as Array<{ id: string; label: string }>) ?? [];
    const petName = fields.find((field) => field.label === "Pet's name");
    expect(petName).toBeTruthy();
    await call("create_custom_field", { record: "line", label: "Print", type: "list", usedOn: ["invoice"], options: ["Paw", "Nose"], idempotencyKey: key("cf2") });
    const listed = await call("get_custom_fields", {});
    expect(JSON.stringify(listed)).toContain("Nose");
    const invoice = await call("create_draft_invoice", {
      idempotencyKey: key("ci"),
      contactId: customerId,
      invoiceDate: "2026-06-12",
      dueDate: "2026-06-30",
      amountsMode: "no_tax",
      customFields: { [petName!.id]: "Biscuit (made up)" },
      lines: [{ description: "Pendant", quantity: "1", unitPrice: "100.00", accountCode: "4000" }],
    });
    expect(JSON.stringify(invoice)).toContain("Biscuit (made up)");
    const off = await call("update_custom_field", { fieldId: petName!.id, isActive: false });
    expect(off).toMatchObject({ preview: true });
  });
});
