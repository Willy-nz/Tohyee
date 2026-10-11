import { writeAuditEvent } from "@/lib/audit";
import { createAccount } from "@/lib/accounts/service";
import { createBankAccount } from "@/lib/bank/accounts";
import { recordSupplierPayment, voidSupplierPayment } from "@/lib/bills/payments";
import { approveBill, createBill, getBill, voidBill } from "@/lib/bills/service";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { approveInvoice, createInvoice, getInvoice, voidInvoice } from "@/lib/invoices/service";
import { add, dec, parseDecimalInput, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { optionalSource, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";
import { className, findClass, KIND_NAMES, LIVESTOCK_KINDS } from "./classes";
import { recordMovement, requireLivestock, voidMovement } from "./movements";

/*
 * Stock agent account sales (LV13-LV16, decision 506). The agent's account
 * sale is the farmer's tax invoice (buyer-created): Tohyee keeps it as an
 * approved invoice to the agent for the stock sold, an approved bill from
 * the agent for its deductions (commission, freight, yard fees), and a
 * contra through a clearing account settling the bill against the invoice.
 * The agent then owes the net, matched when it pays; GST returns see the
 * sales and the deductions on both bases; each sale line makes its
 * movement, linked to its invoice line.
 */

const SALES_ACCOUNT = { code: "4300", name: "Livestock sales", type: "revenue", accountClass: "revenue" } as const;
const CONTRA_ACCOUNT = { code: "1090", name: "Stock agent contra", type: "bank" } as const;

export type AccountSale = {
  id: string;
  contactId: string;
  contactName: string;
  reference: string;
  saleDate: string;
  invoiceId: string;
  invoiceNumber: string | null;
  billId: string | null;
  gross: string;
  deductions: string;
  net: string;
  amountDue: string;
  status: "active" | "voided";
  voidReason: string | null;
  createdByEmail: string;
  createdAt: string;
};

type SaleLine = { kind: (typeof LIVESTOCK_KINDS)[number]; classCode: string; head: number; amount: string };
type Deduction = { description: string; accountCode: string; amount: string };

async function ensureSalesAccount(tx: OrgTx): Promise<string> {
  const row = await tx.query<{ code: string; account_class: string }>("select code, account_class from accounts where lower(code) = lower($1)", [SALES_ACCOUNT.code]);
  if (row.rows[0]) {
    if (row.rows[0].account_class !== SALES_ACCOUNT.accountClass) throw new ValidationError(`Account ${SALES_ACCOUNT.code} is used for something other than livestock sales.`);
    return row.rows[0].code;
  }
  return (await createAccount(tx, { code: SALES_ACCOUNT.code, name: SALES_ACCOUNT.name, accountType: SALES_ACCOUNT.type })).code;
}

/** The clearing account the contra goes through; it always comes back to zero. */
async function ensureContraAccount(tx: OrgTx): Promise<string> {
  const row = await tx.query<{ code: string; account_type: string; currency_code: string | null }>(
    "select code, account_type, currency_code from accounts where lower(code) = lower($1)",
    [CONTRA_ACCOUNT.code],
  );
  if (row.rows[0]) {
    if (row.rows[0].account_type !== "bank" || row.rows[0].currency_code) throw new ValidationError(`Account ${CONTRA_ACCOUNT.code} is used for something other than the stock agent contra.`);
    return row.rows[0].code;
  }
  return (await createBankAccount(tx, { code: CONTRA_ACCOUNT.code, name: CONTRA_ACCOUNT.name, accountType: "bank", description: "Settles stock agents' deductions against their account sales. Always back to zero." })).code;
}

function parseLines(input: unknown): SaleLine[] {
  const lines = requireArray(input, "lines", 50);
  if (lines.length === 0) throw new ValidationError("An account sale needs at least one line of stock sold.");
  return lines.map((raw, index) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const label = `Line ${index + 1}`;
    const kind = requireOneOf(line.kind, `${label} kind`, LIVESTOCK_KINDS);
    const classCode = requireString(line.classCode, `${label} class`, { maxLength: 50 });
    if (!findClass(kind, classCode)) throw new ValidationError(`${label}: ${KIND_NAMES[kind]} has no class "${classCode}".`);
    const head = Number(parseDecimalInput(line.head, `${label} head`, { maxScale: 0 }));
    const amount = parseDecimalInput(line.amount, `${label} amount`, { maxScale: 2 });
    return { kind, classCode, head, amount };
  });
}

function parseDeductions(input: unknown): Deduction[] {
  if (input === undefined || input === null) return [];
  return requireArray(input, "deductions", 20).map((raw, index) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const label = `Deduction ${index + 1}`;
    return {
      description: requireString(line.description, `${label} description`, { maxLength: 200 }),
      accountCode: requireString(line.accountCode, `${label} account`, { maxLength: 20 }),
      amount: parseDecimalInput(line.amount, `${label} amount`, { maxScale: 2 }),
    };
  });
}

const money = (value: string) => toFixedString(dec(value), 2);

export async function getAccountSale(tx: OrgTx, idInput: unknown): Promise<AccountSale> {
  const id = requireId(idInput, "accountSaleId");
  const row = await tx.query<{
    id: string;
    contact_id: string;
    contact_name: string;
    reference: string;
    sale_date: string;
    invoice_id: string;
    bill_id: string | null;
    status: "active" | "voided";
    void_reason: string | null;
    created_by_email: string;
    created_at: string;
  }>(
    `select s.id::text, s.contact_id::text, c.name as contact_name, s.reference, s.sale_date::text, s.invoice_id::text, s.bill_id::text, s.status,
            s.void_reason, s.created_by_email, s.created_at::text
       from livestock_account_sales s join contacts c on c.id = s.contact_id where s.id = $1`,
    [id],
  );
  const sale = row.rows[0];
  if (!sale) throw new NotFoundError("Account sale not found.");
  const invoice = await getInvoice(tx, sale.invoice_id);
  const bill = sale.bill_id ? await getBill(tx, sale.bill_id) : null;
  const gross = invoice.total;
  const deductions = bill ? bill.total : "0.00";
  return {
    id: sale.id,
    contactId: sale.contact_id,
    contactName: sale.contact_name,
    reference: sale.reference,
    saleDate: sale.sale_date,
    invoiceId: sale.invoice_id,
    invoiceNumber: invoice.invoiceNumber ?? null,
    billId: sale.bill_id,
    gross: money(gross),
    deductions: money(deductions),
    net: toFixedString(add(dec(gross), dec(`-${deductions}`)), 2),
    amountDue: money(invoice.amountDue ?? "0"),
    status: sale.status,
    voidReason: sale.void_reason,
    createdByEmail: sale.created_by_email,
    createdAt: sale.created_at,
  };
}

export async function listAccountSales(tx: OrgTx): Promise<AccountSale[]> {
  const rows = await tx.query<{ id: string }>("select id::text from livestock_account_sales order by sale_date desc, livestock_account_sales.id desc limit 500");
  const result: AccountSale[] = [];
  for (const row of rows.rows) result.push(await getAccountSale(tx, row.id));
  return result;
}

/**
 * Enters an agent's account sale once (LV13, LV15): its stock lines become
 * an invoice to the agent and sale movements; its deductions a bill from
 * the agent, settled against the invoice by a contra. Bookkeepers and up.
 */
export async function recordAccountSale(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; contactId: unknown; reference: unknown; saleDate: unknown; dueDate?: unknown; lines: unknown; deductions?: unknown },
): Promise<{ created: boolean; accountSale: AccountSale }> {
  await requireLivestock(tx);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const contactId = requireId(input.contactId, "The agent");
  const reference = requireString(input.reference, "The account sale's reference", { maxLength: 100 });
  const saleDate = parseIsoDate(input.saleDate, "The sale date");
  const dueDate = input.dueDate ? parseIsoDate(input.dueDate, "The due date") : saleDate;
  if (dueDate < saleDate) throw new ValidationError("The due date can't be before the sale date.");
  const lines = parseLines(input.lines);
  const deductions = parseDeductions(input.deductions);
  const hash = requestHash("livestock_account_sale", { contactId, reference: reference.toLowerCase(), saleDate, dueDate, lines, deductions });

  const replay = async () => {
    const earlier = await tx.query<{ id: string; request_hash: string }>(
      "select id::text, request_hash from livestock_account_sales where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    );
    if (!earlier.rows[0]) return null;
    assertSameRequest(earlier.rows[0].request_hash, hash, "account sale");
    return { created: false, accountSale: await getAccountSale(tx, earlier.rows[0].id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  await tx.query("select 1 from livestock_settings where id = true for update");
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;

  const contact = await tx.query<{ name: string; is_archived: boolean; is_customer: boolean; is_supplier: boolean; currency_code: string | null }>(
    "select name, is_archived, is_customer, is_supplier, currency_code from contacts where id = $1",
    [contactId],
  );
  if (!contact.rows[0]) throw new ValidationError("That agent wasn't found.");
  if (contact.rows[0].is_archived) throw new ValidationError(`${contact.rows[0].name} is archived.`);
  if (contact.rows[0].currency_code && contact.rows[0].currency_code !== tx.baseCurrency) {
    throw new ValidationError(`${contact.rows[0].name} trades in ${contact.rows[0].currency_code}. Account sales are in ${tx.baseCurrency} only.`);
  }
  const duplicate = await tx.query("select 1 from livestock_account_sales where contact_id = $1 and lower(reference) = lower($2) and status = 'active'", [contactId, reference]);
  if (duplicate.rowCount) throw new ConflictError(`${contact.rows[0].name}'s account sale ${reference} is already entered. It's only counted once.`);
  // The agent buys the stock and sells the farmer its services.
  if (!contact.rows[0].is_customer || !contact.rows[0].is_supplier) {
    await tx.query("update contacts set is_customer = true, is_supplier = true where id = $1", [contactId]);
    await writeAuditEvent(tx, { eventType: "contact.updated", entityType: "contact", entityId: contactId, details: { isCustomer: true, isSupplier: true, reason: "Stock agent" } });
  }

  const organisation = await getOrganisationSettings(tx);
  const gst = organisation.gstRegistered;
  const salesAccount = await ensureSalesAccount(tx);
  const key = (part: string) => `${idempotencyKey}:${part}`.slice(0, 120);

  const invoice = (
    await createInvoice(tx, {
      source: "livestock_account_sale",
      idempotencyKey: key("invoice"),
      contactId,
      invoiceDate: saleDate,
      dueDate,
      reference: `Account sale ${reference}`.slice(0, 100),
      amountsMode: gst ? "exclusive" : "no_tax",
      lines: lines.map((line) => ({
        description: `${line.head} ${className(line.kind, line.classCode).toLowerCase()} (${KIND_NAMES[line.kind].toLowerCase()})`,
        quantity: "1",
        unitPrice: line.amount,
        accountCode: salesAccount,
        taxCode: gst ? "GST" : null,
      })),
    })
  ).invoice;
  await approveInvoice(tx, invoice.id, { source: "livestock_account_sale", idempotencyKey: key("approve-invoice") });
  const lineIds = await tx.query<{ id: string }>("select id::text from sales_invoice_lines where invoice_id = $1 order by line_order", [invoice.id]);

  let billId: string | null = null;
  let customerPaymentId: string | null = null;
  let supplierPaymentId: string | null = null;
  if (deductions.length > 0) {
    const bill = (
      await createBill(tx, {
        source: "livestock_account_sale",
        idempotencyKey: key("bill"),
        contactId,
        billDate: saleDate,
        dueDate,
        supplierInvoiceNumber: reference,
        amountsMode: gst ? "exclusive" : "no_tax",
        lines: deductions.map((line) => ({ description: line.description, quantity: "1", unitPrice: line.amount, accountCode: line.accountCode, taxCode: gst ? "GST" : null })),
      })
    ).bill;
    const approvedBill = (await approveBill(tx, bill.id, { source: "livestock_account_sale", idempotencyKey: key("approve-bill"), approveDespiteWarnings: true })).bill;
    billId = bill.id;
    const contra = await ensureContraAccount(tx);
    const reference_ = `Contra: account sale ${reference}`.slice(0, 100);
    customerPaymentId = (
      await recordPayment(tx, invoice.id, { source: "livestock_account_sale", idempotencyKey: key("contra-in"), paymentDate: saleDate, amount: approvedBill.total, bankAccountCode: contra, reference: reference_ })
    ).payment.id;
    supplierPaymentId = (
      await recordSupplierPayment(tx, bill.id, { source: "livestock_account_sale", idempotencyKey: key("contra-out"), paymentDate: saleDate, amount: approvedBill.total, bankAccountCode: contra, reference: reference_ })
    ).payment.id;
  }

  for (const [index, line] of lines.entries()) {
    await recordMovement(tx, {
      source: "livestock_account_sale",
      idempotencyKey: key(`movement-${index + 1}`),
      movementType: "sale",
      movementDate: saleDate,
      kind: line.kind,
      classCode: line.classCode,
      head: line.head,
      amount: line.amount,
      salesInvoiceLineId: lineIds.rows[index].id,
      note: `Account sale ${reference}`,
    });
  }

  const row = await tx.query<{ id: string }>(
    `insert into livestock_account_sales (command_source, idempotency_key, request_hash, contact_id, reference, sale_date, invoice_id, bill_id,
       customer_payment_id, supplier_payment_id, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id::text`,
    [source, idempotencyKey, hash, contactId, reference, saleDate, invoice.id, billId, customerPaymentId, supplierPaymentId, tx.actor.userId, tx.actor.email],
  );
  const id = row.rows[0].id;
  const gross = sum(lines.map((line) => dec(line.amount)));
  await writeAuditEvent(tx, {
    eventType: "livestock.account_sale_recorded",
    entityType: "livestock_account_sale",
    entityId: id,
    details: { contactId, reference, saleDate, gross: toFixedString(gross, 2), deductions: toFixedString(deductions.reduce((total, line) => add(total, dec(line.amount)), ZERO_DECIMAL), 2) },
  });
  return { created: true, accountSale: await getAccountSale(tx, id) };
}

/**
 * Voids an account sale (LV16): its movements, the contra, the bill and the
 * invoice, each reversed, never deleted. Refused once the agent has paid
 * any of the net (void that payment first) or the year's valuation is
 * approved.
 */
export async function voidAccountSale(tx: OrgTx, idInput: unknown, input: { reason: unknown; voidDate?: unknown }): Promise<AccountSale> {
  await requireLivestock(tx);
  const sale = await getAccountSale(tx, idInput);
  const reason = requireString(input.reason, "A reason", { maxLength: 500 });
  if (sale.status === "voided") return sale;
  const voidDate = input.voidDate ? parseIsoDate(input.voidDate, "The void date") : sale.saleDate;
  const ids = await tx.query<{ customer_payment_id: string | null; supplier_payment_id: string | null }>(
    "select customer_payment_id::text, supplier_payment_id::text from livestock_account_sales where id = $1",
    [sale.id],
  );
  const invoice = await getInvoice(tx, sale.invoiceId);
  const contraPaid = sale.billId ? dec(sale.deductions) : ZERO_DECIMAL;
  const otherPaid = add(dec(invoice.total), dec(`-${invoice.amountDue ?? "0"}`));
  if (toFixedString(otherPaid, 2) !== toFixedString(contraPaid, 2)) {
    throw new ConflictError(`${sale.contactName} has paid some of account sale ${sale.reference}. Void that payment first.`);
  }
  const movements = await tx.query<{ id: string }>(
    `select m.id::text from livestock_movements m join sales_invoice_lines l on l.id = m.sales_invoice_line_id
      where l.invoice_id = $1 and m.voided_at is null order by m.id`,
    [sale.invoiceId],
  );
  for (const movement of movements.rows) await voidMovement(tx, movement.id, { reason: `Account sale ${sale.reference} voided: ${reason}` });
  const key = (part: string) => `livestock-account-sale-${sale.id}-void-${part}`;
  if (sale.billId && ids.rows[0].customer_payment_id && ids.rows[0].supplier_payment_id) {
    await voidPayment(tx, sale.invoiceId, ids.rows[0].customer_payment_id, { source: "livestock_account_sale", idempotencyKey: key("contra-in"), voidDate });
    await voidSupplierPayment(tx, sale.billId, ids.rows[0].supplier_payment_id, { source: "livestock_account_sale", idempotencyKey: key("contra-out"), voidDate });
    await voidBill(tx, sale.billId, { source: "livestock_account_sale", idempotencyKey: key("bill"), voidDate });
  }
  await voidInvoice(tx, sale.invoiceId, { source: "livestock_account_sale", idempotencyKey: key("invoice"), voidDate });
  await tx.query("update livestock_account_sales set status = 'voided', voided_at = now(), voided_by_email = $2, void_reason = $3 where id = $1", [sale.id, tx.actor.email, reason]);
  await writeAuditEvent(tx, { eventType: "livestock.account_sale_voided", entityType: "livestock_account_sale", entityId: sale.id, details: { reason } });
  return getAccountSale(tx, sale.id);
}
