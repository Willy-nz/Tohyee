import { writeAuditEvent } from "@/lib/audit";
import { updateContact } from "@/lib/contacts/service";
import type { CrmScope } from "@/lib/crm/access";
import { getOpportunity, type Opportunity, updateOpportunity } from "@/lib/crm/service";
import { requireCrm } from "@/lib/crm/switch";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { discountedLineAmount } from "@/lib/invoices/amounts";
import { parseDiscountPercent } from "@/lib/invoices/service";
import { getItem } from "@/lib/items/service";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, dec, parseDecimalInput, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { requireAccounting } from "@/lib/organisations/accounting-switch";
import { createQuote, deleteQuote, declineQuote, getQuote, type Quote } from "@/lib/quotes/service";
import { contactSalesTaxCodeFor } from "@/lib/tax/contact-tax";
import { optionalId, optionalString, requireArray } from "@/lib/validation";

/**
 * Deal products (decision 502, examples DS7-DS9, approved by Jess
 * 10 Oct 2026). A deal can have product lines (item, description, quantity,
 * unit price and discount, all excluding GST); with lines, its amount is
 * their line amounts added (the DS rules: quantity x price less the
 * discount, rounded once), and can't be typed. "Make quote" makes a draft
 * quote from them; a new revision declines (or deletes, if a draft) the
 * deal's open quote first. Accepting the quote wins the deal
 * (`src/lib/crm/quote-deals.ts`).
 */

export const MAX_DEAL_LINES = 100;

export type DealLine = {
  lineOrder: number;
  itemId: string | null;
  itemCode: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  lineAmount: string;
};

export async function listDealLines(tx: OrgTx, opportunityId: string): Promise<DealLine[]> {
  const rows = await tx.query<{
    line_order: number;
    item_id: string | null;
    item_code: string | null;
    description: string;
    quantity: string;
    unit_price: string;
    discount_percent: string;
    line_amount: string;
    currency_code: string;
  }>(
    `select l.line_order, l.item_id::text, i.code as item_code, l.description, l.quantity::text, l.unit_price::text, l.discount_percent::text,
            l.line_amount::text, o.currency_code
       from crm_opportunity_lines l join crm_opportunities o on o.id = l.opportunity_id left join items i on i.id = l.item_id
      where l.opportunity_id = $1 order by l.line_order`,
    [opportunityId],
  );
  return rows.rows.map((row) => ({
    lineOrder: row.line_order,
    itemId: row.item_id,
    itemCode: row.item_code,
    description: row.description,
    quantity: toPlainString(dec(row.quantity)),
    unitPrice: toPlainString(dec(row.unit_price)),
    discountPercent: toFixedString(dec(row.discount_percent), 2),
    lineAmount: toFixedString(dec(row.line_amount), currencyMinorUnits(row.currency_code)),
  }));
}

/** Whether a deal's amount comes from its lines (decision 502). */
export async function dealLinesTotal(tx: OrgTx, opportunityId: string): Promise<string | null> {
  const row = (await tx.query<{ count: number; total: string | null }>("select count(*)::int as count, sum(line_amount)::text as total from crm_opportunity_lines where opportunity_id = $1", [opportunityId])).rows[0];
  return row.count === 0 ? null : (row.total ?? "0");
}

/**
 * Replaces a deal's product lines and sets its amount to their total
 * (DS7). An empty list removes them, and the amount can be typed again.
 * A line with an item can leave its description and price blank: the item's
 * name and sale price fill them (a deal in another currency needs a price).
 */
export async function setDealLines(tx: OrgTx, idInput: unknown, input: { lines?: unknown }, scope?: CrmScope): Promise<{ opportunity: Opportunity; lines: DealLine[] }> {
  await requireCrm(tx);
  const deal = await getOpportunity(tx, idInput, scope);
  if (deal.stageType !== "open") throw new ConflictError("This deal is closed, so its products don't change.");
  const raw = requireArray(input.lines, "lines", MAX_DEAL_LINES);
  const scale = currencyMinorUnits(deal.currencyCode);
  const foreign = deal.currencyCode !== tx.baseCurrency;
  const lines: Array<Omit<DealLine, "lineOrder" | "itemCode">> = [];
  for (const [index, entry] of raw.entries()) {
    const label = `Line ${index + 1}`;
    if (typeof entry !== "object" || entry === null) throw new ValidationError(`${label} must be an object.`);
    const line = entry as Record<string, unknown>;
    const itemId = optionalId(line.itemId === "" ? null : line.itemId, `${label} item`);
    const item = itemId ? await getItem(tx, itemId) : null;
    if (item && !item.isActive) throw new ValidationError(`${label}: ${item.name} is archived.`);
    const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    const description = blank(line.description) && item ? (item.description ?? item.name) : optionalString(line.description, `${label} description`, { maxLength: 500 });
    if (!description) throw new ValidationError(`${label} needs a description.`);
    let unitPrice: string;
    if (blank(line.unitPrice)) {
      if (!item?.salePrice) throw new ValidationError(`${label} needs a unit price.`);
      if (foreign) throw new ValidationError(`${label} needs a unit price: item prices are in ${tx.baseCurrency} and this deal is in ${deal.currencyCode}.`);
      unitPrice = toPlainString(dec(item.salePrice));
    } else {
      unitPrice = parseDecimalInput(line.unitPrice, `${label} unit price`, { maxScale: 4 });
    }
    const quantity = parseDecimalInput(line.quantity ?? "1", `${label} quantity`, { maxScale: 4 });
    if (!(Number(quantity) > 0)) throw new ValidationError(`${label} quantity must be more than 0.`);
    if (!(Number(unitPrice) > 0)) throw new ValidationError(`${label} unit price must be more than 0.`);
    const discountPercent = parseDiscountPercent(line.discountPercent, label) ?? "0.00";
    lines.push({
      itemId,
      description,
      quantity,
      unitPrice,
      discountPercent,
      lineAmount: toFixedString(discountedLineAmount(quantity, unitPrice, discountPercent, scale), scale),
    });
  }
  await tx.query("delete from crm_opportunity_lines where opportunity_id = $1", [deal.id]);
  for (const [index, line] of lines.entries()) {
    await tx.query(
      `insert into crm_opportunity_lines (opportunity_id, line_order, item_id, description, quantity, unit_price, discount_percent, line_amount)
       values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric)`,
      [deal.id, index + 1, line.itemId, line.description, line.quantity, line.unitPrice, line.discountPercent, line.lineAmount],
    );
  }
  let opportunity = deal;
  if (lines.length > 0) {
    const total = toFixedString(lines.reduce((sum, line) => add(sum, dec(line.lineAmount)), ZERO_DECIMAL), scale);
    // Through the usual update, so the stage history keeps the amount change (CRMS6).
    if (total !== deal.amount) opportunity = await updateOpportunity(tx, deal.id, { amount: total }, { scope, fromLines: true });
  }
  await writeAuditEvent(tx, { eventType: "crm.opportunity_lines_set", entityType: "crm_opportunity", entityId: deal.id, details: { lines } });
  return { opportunity, lines: await listDealLines(tx, deal.id) };
}

export type DealQuote = { id: string; quoteNumber: string | null; status: string; total: string; quoteDate: string; expiryDate: string | null; isOpen: boolean };

/** The quotes made from a deal, newest first. */
export async function dealQuotes(tx: OrgTx, opportunityId: string): Promise<DealQuote[]> {
  const rows = await tx.query<{ id: string; quote_number: string | null; status: string; total: string; quote_date: string; expiry_date: string | null }>(
    `select q.id::text, q.quote_number, q.status, q.total::text, q.quote_date::text, q.expiry_date::text
       from quotes q where q.opportunity_id = $1 order by q.id desc`,
    [opportunityId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    quoteNumber: row.quote_number,
    status: row.status,
    total: row.total,
    quoteDate: row.quote_date,
    expiryDate: row.expiry_date,
    isOpen: row.status === "draft" || row.status === "finalised",
  }));
}

/**
 * Makes a draft quote from a deal (DS7, DS8): its product lines, or one line
 * with its name and amount when it has none, tax exclusive, for its company.
 * Lines with an item take the item's account and tax code, as an invoice
 * line would; others the first active revenue account and the company's (or
 * the standard) GST code. A deal has at most one open quote: making another
 * declines the finalised one, or deletes the draft, first.
 */
export async function makeQuoteFromDeal(
  tx: OrgTx,
  idInput: unknown,
  input: { idempotencyKey?: unknown; quoteDate?: unknown; expiryDate?: unknown } = {},
  scope?: CrmScope,
): Promise<{ quote: Quote; replaced: string | null }> {
  await requireCrm(tx);
  await requireAccounting(tx);
  const deal = await getOpportunity(tx, idInput, scope);
  await tx.query("select id from crm_opportunities where id = $1 for update", [deal.id]);
  if (deal.stageType !== "open") throw new ConflictError("Only an open deal can have a new quote.");
  if (deal.invoiceId || deal.salesOrderId) throw new ConflictError("This deal already has an invoice or sales order.");
  // A retry with the same key returns the quote it made, without replacing anything.
  const key = typeof input.idempotencyKey === "string" && input.idempotencyKey ? input.idempotencyKey.slice(0, 200) : null;
  if (key) {
    const earlier = (await tx.query<{ id: string }>("select id::text from quotes where command_source = 'crm' and idempotency_key = $1 and opportunity_id = $2", [key, deal.id])).rows[0];
    if (earlier) return { quote: await getQuote(tx, earlier.id), replaced: null };
  }
  const today = todayIsoDate();
  const quoteDate = typeof input.quoteDate === "string" && input.quoteDate ? input.quoteDate : today;
  const expiryDate = typeof input.expiryDate === "string" && input.expiryDate ? input.expiryDate : addDays(quoteDate, 30);

  // The open quote goes first: a draft is deleted, a finalised one declined (DS8).
  let replaced: string | null = null;
  for (const open of (await dealQuotes(tx, deal.id)).filter((quote) => quote.isOpen)) {
    if (open.status === "draft") {
      await deleteQuote(tx, open.id);
    } else {
      await declineQuote(tx, open.id, { source: "crm", idempotencyKey: `deal-${deal.id}-replace-${open.id}` });
      await writeAuditEvent(tx, { eventType: "crm.quote_replaced", entityType: "quote", entityId: open.id, details: { opportunityId: deal.id, quoteNumber: open.quoteNumber } });
      replaced = open.quoteNumber;
    }
  }

  const lines = await listDealLines(tx, deal.id);
  const account = await tx.query<{ code: string }>("select code from accounts where is_active and account_class = 'revenue' order by code limit 1");
  if (!account.rows[0]) throw new ValidationError("There's no active revenue account to quote to.");
  const standard = await tx.query<{ code: string }>(
    `select code from tax_codes where is_active and category = 'standard' and available_on in ('sales', 'both') and effective_from <= $1
        and (effective_to is null or effective_to >= $1) order by id limit 1`,
    [quoteDate],
  );
  const gst = (await contactSalesTaxCodeFor(tx, deal.contactId)) ?? standard.rows[0]?.code ?? null;
  const quoteLines =
    lines.length > 0
      ? lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          ...(line.discountPercent !== "0.00" ? { discountPercent: line.discountPercent } : {}),
          // An item line takes the item's account and tax code (IT2).
          ...(line.itemId ? { itemId: line.itemId, accountCode: "", taxCode: null } : { accountCode: account.rows[0].code, taxCode: gst }),
        }))
      : [{ description: deal.name, quantity: "1", unitPrice: deal.amount, accountCode: account.rows[0].code, taxCode: gst }];
  if (lines.length === 0 && !(Number(deal.amount) > 0)) throw new ValidationError("Give the deal an amount or some products first.");
  const contact = await tx.query<{ is_customer: boolean }>("select is_customer from contacts where id = $1", [deal.contactId]);
  // A prospect becomes a customer, as when a won deal makes an invoice.
  if (!contact.rows[0]?.is_customer) await updateContact(tx, deal.contactId, { isCustomer: true });
  const idempotencyKey = key ?? `deal-${deal.id}-${Date.now()}`;
  const made = await createQuote(tx, {
    source: "crm",
    idempotencyKey,
    contactId: deal.contactId,
    quoteDate,
    expiryDate,
    reference: deal.name.slice(0, 100),
    amountsMode: gst ? "exclusive" : "no_tax",
    lines: gst ? quoteLines : quoteLines.map((line) => ({ ...line, taxCode: null })),
  });
  if (made.quote.currencyCode !== deal.currencyCode) {
    throw new ConflictError(`This deal is in ${deal.currencyCode}, but ${deal.contactName}'s quotes are in ${made.quote.currencyCode}.`);
  }
  await tx.query("update quotes set opportunity_id = $2 where id = $1", [made.quote.id, deal.id]);
  await writeAuditEvent(tx, { eventType: "crm.quote_made", entityType: "crm_opportunity", entityId: deal.id, details: { quoteId: made.quote.id, replaced } });
  return { quote: await getQuote(tx, made.quote.id), replaced };
}
