import { businessTimeZone } from "@/lib/dates";
import { type GstRegistration, isRegisteredOn } from "@/lib/tax/registration";
import { type AmountsMode, calculateInvoice } from "@/lib/invoices/amounts";
import {
  abs,
  add,
  cmp,
  dec,
  type Decimal,
  divideTruncated,
  isNegative,
  isPositive,
  isZero,
  mul,
  sub,
  sum,
  toFixedString,
  toPlainString,
  ZERO_DECIMAL,
} from "@/lib/money/decimal";
import type {
  PlatformBalanceTransaction,
  PlatformOrder,
  PlatformOrderLine,
  PlatformPayout,
  PlatformRefund,
  PlatformTaxLine,
  PlatformTransaction,
} from "@/lib/sales-platforms/connector";

/**
 * Turning a platform's order, refund or payout into Tohyee's documents
 * (examples SPC11-SPC23, decisions 52-55). Pure: no database, no network, so
 * the line maths is tested on its own. A plan is either the lines to post or
 * the reason nothing is posted, which goes in the sync log.
 */

const SCALE = 2;

/** What the connection's settings and the organisation say, for planning. */
export type PostingRules = {
  baseCurrency: string;
  /** Registered for GST (issue #180). When `gstRegistration` is given, each order uses its own date instead. */
  gstRegistered: boolean;
  /** The organisation's GST registration, so an order dated before or after it isn't taxed (NR5, NR6). */
  gstRegistration?: GstRegistration;
  foreignTrade: boolean;
  exportTaxCode: string | null;
  /** For lines Shopify charged no tax on. */
  untaxedTaxCode: string | null;
  /** Shopify's rate (a fraction, "0.15") -> the Tohyee code mapped to it and that code's rate. */
  taxCodes: ReadonlyArray<{ rate: string; code: string; codeRate: string }>;
  salesAccountCode: string;
  shippingAccountCode: string;
  /** The platform's name in messages ("Shopify", "WooCommerce"); Shopify when not given. */
  platformName?: string;
};

/** A variant linked to an item. */
export type LinkedItem = { id: string; code: string; itemType: string; incomeAccountCode: string | null };

export type PlannedLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string | null;
  itemId: string | null;
};

export type Refusal = { ok: false; reason: string };

export type OrderPlan =
  | {
      ok: true;
      amountsMode: AmountsMode;
      lines: PlannedLine[];
      total: string;
      /** Things the sync log should say (tax rounding, tax that's part of the sale). */
      notes: string[];
    }
  | Refusal;

const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** Plain money text, two places: "46.00". */
export const money = (value: Decimal | string): string => toFixedString(typeof value === "string" ? dec(value) : value, SCALE);

// ---------------------------------------------------------------------------
// Dates (New Zealand dates from the platform's timestamps)

function partsIn(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = Number(part.value);
  return out;
}

/** The date (YYYY-MM-DD) an instant falls on in the business time zone: 2026-10-05T22:00Z is 2026-10-06 in NZDT. */
export function localDate(instant: string, timeZone = businessTimeZone()): string {
  const p = partsIn(new Date(instant), timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The instant a date starts in the business time zone: 2026-10-01 is 2026-09-30T11:00:00Z in NZDT. */
export function startOfLocalDate(date: string, timeZone = businessTimeZone()): string {
  const [year, month, day] = date.split("-").map(Number);
  const wanted = Date.UTC(year, month - 1, day);
  let guess = wanted;
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const next = guess - (shown - wanted);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

// ---------------------------------------------------------------------------
// Orders

/** A line's amount split so quantity x unit price gives it exactly: 22.00 for 3 is 2 x 7.33 and 1 x 7.34 (SPC13). */
export function splitAmount(amount: string, quantity: string): Array<{ quantity: string; unitPrice: string }> {
  const total = dec(amount);
  const q = dec(quantity);
  const unit = divideTruncated(total, q, SCALE);
  if (cmp(mul(unit, q), total) === 0) return [{ quantity: toPlainString(q), unitPrice: money(unit) }];
  // Whole quantities only: Shopify's line quantities are whole numbers.
  const rest = sub(total, mul(unit, sub(q, dec("1"))));
  return [
    { quantity: toPlainString(sub(q, dec("1"))), unitPrice: money(unit) },
    { quantity: "1", unitPrice: money(rest) },
  ];
}

const taxed = (lines: readonly PlatformTaxLine[]) => lines.filter((line) => isPositive(dec(line.rate)) || isPositive(dec(line.amount)));
const taxOf = (lines: readonly PlatformTaxLine[]) => sum(lines.map((line) => dec(line.amount)));

/** "15%" from "0.15". */
export function percent(rate: string): string {
  return `${toPlainString(mul(dec(rate), dec("100")))}%`;
}

type TaxChoice = { ok: true; code: string | null; rate: string | null } | Refusal;

/** The Tohyee tax code for a line Shopify charged `taxLines` on (decision 53). */
export function taxCodeFor(taxLines: readonly PlatformTaxLine[], rules: PostingRules, overseas: boolean, what: string): TaxChoice {
  if (!rules.gstRegistered) return { ok: true, code: null, rate: null };
  const charged = taxed(taxLines);
  if (charged.length > 1) {
    return refuse(`${what} has more than one tax (${charged.map((line) => `${line.title ?? "tax"} ${percent(line.rate)}`).join(", ")}); Tohyee only handles one tax per line.`);
  }
  if (charged.length === 1) {
    const rate = charged[0].rate;
    const mapped = rules.taxCodes.find((entry) => cmp(dec(entry.rate), dec(rate)) === 0);
    if (!mapped) {
      return refuse(`${what} has ${rules.platformName ?? "Shopify"}'s ${percent(rate)} tax, which isn't matched to a Tohyee tax code in the connection's settings.`);
    }
    return { ok: true, code: mapped.code, rate: mapped.codeRate };
  }
  if (overseas && rules.foreignTrade && rules.exportTaxCode) return { ok: true, code: rules.exportTaxCode, rate: "0" };
  if (!rules.untaxedTaxCode) return refuse(`${what} has no tax, and the connection's settings have no tax code for untaxed sales.`);
  return { ok: true, code: rules.untaxedTaxCode, rate: "0" };
}

type Draft = { what: string; amount: Decimal; quantity: string; shopifyTax: Decimal; tax: { code: string | null; rate: string | null }; accountCode: string; itemId: string | null; description: string };

/**
 * The sales order's lines for an order (SPC11-SPC13, SPC16, SPC17, SPC23),
 * or why it can't come in. `items` are the items linked to the order's
 * variants; `overseas` is whether the customer's contact is overseas.
 */
/** The rules as they apply on a date: registered for GST on that date or not (issue #180). */
function rulesOn(rules: PostingRules, date: string): PostingRules {
  return rules.gstRegistration ? { ...rules, gstRegistered: isRegisteredOn(rules.gstRegistration, date) } : rules;
}

export function planOrder(order: PlatformOrder, givenRules: PostingRules, items: ReadonlyMap<string, LinkedItem>, overseas: boolean): OrderPlan {
  const rules = rulesOn(givenRules, localDate(order.processedAt));
  const name = order.name;
  if (order.test) return refuse(`${name} is a test order, so it isn't brought in.`);
  if (order.currency !== rules.baseCurrency) return refuse(`${name} is in ${order.currency}; Tohyee only brings in orders in ${rules.baseCurrency}.`);
  if (order.presentmentCurrency && order.presentmentCurrency !== order.currency) {
    return refuse(`${name} was paid in ${order.presentmentCurrency}; Tohyee only brings in orders in ${rules.baseCurrency}.`);
  }
  if (order.incomplete) return refuse(`${name} ${order.incomplete}`);
  if (order.lines.some((line) => line.isGiftCard)) return refuse(`${name} sells a gift card; gift cards aren't supported yet.`);
  const amountsMode: AmountsMode = !rules.gstRegistered ? "no_tax" : order.taxesIncluded ? "inclusive" : "exclusive";
  const notes: string[] = [];
  const drafts: Draft[] = [];

  const draftFor = (
    what: string,
    description: string,
    gross: Decimal,
    quantity: string,
    taxLines: readonly PlatformTaxLine[],
    accountCode: string,
    itemId: string | null,
  ): Draft | Refusal => {
    if (isNegative(gross)) return refuse(`${what} comes to less than nothing (${money(gross)}).`);
    const tax = taxCodeFor(taxLines, rules, overseas, what);
    if (!tax.ok) return tax;
    const shopifyTax = taxOf(taxLines);
    // Not GST registered: tax Shopify added on top is part of the sale (decision 53).
    const amount = amountsMode === "no_tax" && !order.taxesIncluded ? add(gross, shopifyTax) : gross;
    return { what, amount, quantity, shopifyTax, tax: { code: tax.code, rate: tax.rate }, accountCode, itemId, description };
  };

  for (const line of order.lines) {
    if (!isPositive(dec(line.quantity))) continue;
    const item = line.variantId ? items.get(line.variantId) ?? null : null;
    const draft = draftFor(
      `${name} line "${line.name}"`,
      line.name,
      sub(dec(line.originalTotal), dec(line.discount)),
      line.quantity,
      line.taxLines,
      item?.incomeAccountCode ?? rules.salesAccountCode,
      item?.id ?? null,
    );
    if ("ok" in draft) return draft;
    drafts.push(draft);
  }
  for (const shipping of order.shipping) {
    if (shipping.removed) continue;
    const draft = draftFor(
      `${name} shipping "${shipping.title}"`,
      `Shipping: ${shipping.title}`,
      dec(shipping.amount),
      "1",
      shipping.taxLines,
      rules.shippingAccountCode,
      null,
    );
    if ("ok" in draft) return draft;
    drafts.push(draft);
  }
  if (drafts.length === 0) return refuse(`${name} has no lines to bring in.`);

  const lines: PlannedLine[] = [];
  const rates: string[] = [];
  for (const draft of drafts) {
    const parts = splitAmount(money(draft.amount), draft.quantity);
    const amounts = calculateInvoice(
      amountsMode,
      parts.map((part) => ({ quantity: part.quantity, unitPrice: part.unitPrice, taxRate: draft.tax.rate ?? "0" })),
      SCALE,
    );
    const ours = sum(amounts.lines.map((line) => dec(line.taxAmount)));
    if (amountsMode === "no_tax") {
      if (isPositive(draft.shopifyTax)) {
        notes.push(`${draft.what}: ${rules.platformName ?? "Shopify"} charged ${money(draft.shopifyTax)} tax; it's part of the sale because the organisation isn't GST registered.`);
      }
    } else if (cmp(ours, draft.shopifyTax) !== 0) {
      notes.push(`${draft.what}: Tohyee works out GST of ${money(ours)} (per line, as on every invoice); ${rules.platformName ?? "Shopify"}'s tax line says ${money(draft.shopifyTax)}.`);
    }
    for (const part of parts) {
      lines.push({ description: draft.description, quantity: part.quantity, unitPrice: part.unitPrice, accountCode: draft.accountCode, taxCode: draft.tax.code, itemId: draft.itemId });
      rates.push(draft.tax.rate ?? "0");
    }
  }
  const total = calculateInvoice(
    amountsMode,
    lines.map((line, index) => ({ quantity: line.quantity, unitPrice: line.unitPrice, taxRate: rates[index] })),
    SCALE,
  ).total;
  if (cmp(dec(total), dec(order.total)) !== 0) {
    return refuse(`${name}'s lines come to ${total} in Tohyee but ${rules.platformName ?? "Shopify"}'s order total is ${money(order.total)} (tips, duties or other charges aren't supported yet), so it isn't brought in.`);
  }
  return { ok: true, amountsMode, lines, total, notes };
}

// ---------------------------------------------------------------------------
// Payments

const succeeded = (transaction: PlatformTransaction) => transaction.status === "SUCCESS" && !transaction.test;

/** The money received for an order: its successful sales and captures (SPC11). */
export function orderPayments(order: PlatformOrder): { amount: Decimal; lastAt: string | null; giftCard: boolean } {
  const received = order.transactions.filter((t) => succeeded(t) && (t.kind === "SALE" || t.kind === "CAPTURE"));
  let lastAt: string | null = null;
  for (const t of received) if (t.processedAt && (!lastAt || Date.parse(t.processedAt) > Date.parse(lastAt))) lastAt = t.processedAt;
  return {
    amount: sum(received.map((t) => dec(t.amount))),
    lastAt,
    giftCard: received.some((t) => t.gateway === "gift_card"),
  };
}

/** Shopify's financial statuses for an order that's been paid in full (some may since have been refunded). */
export const PAID_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

// ---------------------------------------------------------------------------
// Refunds

export type RefundPlan = { ok: true; lines: PlannedLine[]; total: string; refunded: string; date: string } | Refusal | { ok: "nothing"; reason: string };

/**
 * A refund's credit note lines (SPC14): each refunded line at Shopify's
 * subtotal (plus its tax when the order's prices exclude tax and the
 * organisation isn't GST registered), and refunded shipping. The total must
 * equal the money refunded.
 */
export function planRefund(
  order: PlatformOrder,
  refund: PlatformRefund,
  rules: PostingRules,
  items: ReadonlyMap<string, LinkedItem>,
  overseas: boolean,
): RefundPlan {
  const what = `${order.name}'s refund ${refund.externalId}`;
  const returned = refund.transactions.filter((t) => succeeded(t) && t.kind === "REFUND");
  const refunded = sum(returned.map((t) => dec(t.amount)));
  if (refund.incomplete) return refuse(`${what} has more lines or transactions than Tohyee reads.`);
  if (refund.adjustments > 0) return refuse(`${what} has an order adjustment (a refund that differs from its lines); refunds like that aren't supported yet.`);
  if (returned.some((t) => t.gateway === "gift_card")) return refuse(`${what} went back to a gift card; gift cards aren't supported yet.`);
  if (!isPositive(refunded)) return { ok: "nothing", reason: `${what} returned no money, so there's nothing to post.` };
  const at = refund.processedAt ?? refund.createdAt ?? returned[0]?.processedAt ?? order.processedAt;
  // A refund is taxed as the order was: registered or not on the order's date.
  rules = rulesOn(rules, localDate(order.processedAt));
  const amountsMode: AmountsMode = !rules.gstRegistered ? "no_tax" : order.taxesIncluded ? "inclusive" : "exclusive";
  const lines: PlannedLine[] = [];
  const rates: Array<string | null> = [];
  const byId = new Map<string, PlatformOrderLine>(order.lines.map((line) => [line.externalId, line]));
  for (const entry of refund.lines) {
    if (!isPositive(dec(entry.quantity)) && isZero(dec(entry.subtotal))) continue;
    const line = byId.get(entry.lineItemId);
    if (!line) return refuse(`${what} refunds a line that isn't on the order.`);
    const item = line.variantId ? items.get(line.variantId) ?? null : null;
    const tax = taxCodeFor(line.taxLines, rules, overseas, `${what} line "${line.name}"`);
    if (!tax.ok) return tax;
    const amount = amountsMode === "no_tax" && !order.taxesIncluded ? add(dec(entry.subtotal), dec(entry.tax)) : dec(entry.subtotal);
    // A restocked stock item comes back into stock at the sale's cost (ST5); anything else is a line without the item.
    const keepItem = item !== null && (item.itemType !== "stock" || entry.restocked);
    for (const part of splitAmount(money(amount), isPositive(dec(entry.quantity)) ? entry.quantity : "1")) {
      lines.push({
        description: line.name,
        quantity: part.quantity,
        unitPrice: part.unitPrice,
        accountCode: item?.incomeAccountCode ?? rules.salesAccountCode,
        taxCode: tax.code,
        itemId: keepItem ? item!.id : null,
      });
      rates.push(tax.rate);
    }
  }
  for (const entry of refund.shipping) {
    const shipping = order.shipping.find((s) => s.externalId === entry.shippingLineId) ?? order.shipping.find((s) => !s.removed) ?? null;
    const tax = taxCodeFor(shipping?.taxLines ?? [], rules, overseas, `${what} shipping`);
    if (!tax.ok) return tax;
    const amount = amountsMode === "no_tax" && !order.taxesIncluded ? add(dec(entry.subtotal), dec(entry.tax)) : dec(entry.subtotal);
    if (isZero(amount)) continue;
    lines.push({
      description: `Shipping: ${shipping?.title ?? "shipping"}`,
      quantity: "1",
      unitPrice: money(amount),
      accountCode: rules.shippingAccountCode,
      taxCode: tax.code,
      itemId: null,
    });
    rates.push(tax.rate);
  }
  if (lines.length === 0) return refuse(`${what} returned ${money(refunded)} but has no refunded lines; refunds like that aren't supported yet.`);
  const total = calculateInvoice(
    amountsMode,
    lines.map((line, index) => ({ quantity: line.quantity, unitPrice: line.unitPrice, taxRate: rates[index] ?? "0" })),
    SCALE,
  ).total;
  if (cmp(dec(total), refunded) !== 0) {
    return refuse(`${what}'s lines come to ${total} but ${rules.platformName ?? "Shopify"} refunded ${money(refunded)}, so nothing was posted.`);
  }
  return { ok: true, lines, total, refunded: money(refunded), date: localDate(at) };
}

// ---------------------------------------------------------------------------
// Payouts

/** Which settings account a payout line goes to. */
export type PayoutLineAccount = "fees" | "chargebacks";

export type PayoutLine = { description: string; amount: string; account: PayoutLineAccount };

export type PayoutPlan =
  | {
      ok: true;
      date: string;
      net: string;
      /** The spend money's lines: the fees, each adjustment, chargebacks and chargeback fees. */
      charges: PayoutLine[];
      /** The receive money's lines: won disputes and chargeback fees given back (SPC26). */
      receipts: PayoutLine[];
      /** Moved from the clearing account to the reserve account (SPC28), or back (SPC29); null for none. */
      reserveHeld: string | null;
      reserveReleased: string | null;
    }
  | Refusal;

/**
 * The balance transaction types Tohyee posts, and the sign each must have
 * (SPC25-SPC31). Shopify names the types without saying what they do, so
 * the steps and signs are Tohyee's reading of the names: a transaction
 * with the other sign refuses the payout rather than being guessed at.
 */
const POSTABLE: Record<string, "any" | "negative" | "positive"> = {
  CHARGE: "any",
  REFUND: "any",
  ADJUSTMENT: "any",
  DISPUTE_WITHDRAWAL: "negative",
  CHARGEBACK_FEE: "negative",
  DISPUTE_REVERSAL: "positive",
  CHARGEBACK_FEE_REFUND: "positive",
  RESERVED_FUNDS: "negative",
  RESERVED_FUNDS_REVERSAL: "positive",
};

const DISPUTES = ["DISPUTE_WITHDRAWAL", "DISPUTE_REVERSAL", "CHARGEBACK_FEE", "CHARGEBACK_FEE_REFUND"];

/**
 * A Shopify Payments payout (SPC15, SPC25-SPC31): the transfer to the bank
 * for its net; the fees, adjustments, chargebacks and chargeback fees as one
 * spend money from the clearing account; won disputes and chargeback fees
 * given back as one receive money; and reserves held or released as
 * transfers to or from the reserve account. Refused if anything in it is
 * another type or has an unexpected sign, or the balance transactions don't
 * add up to the payout.
 */
export function planPayout(payout: PlatformPayout, baseCurrency: string): PayoutPlan {
  const what = `Payout ${payout.externalId}`;
  if (payout.direction !== "DEPOSIT") return refuse(`${what} is a ${payout.direction.toLowerCase()} (money taken from the bank); those aren't supported yet.`);
  if (payout.currency !== baseCurrency) return refuse(`${what} is in ${payout.currency}; Tohyee only brings in payouts in ${baseCurrency}.`);
  if (payout.incomplete) return refuse(`${what} has more balance transactions than Tohyee reads.`);
  const others = [...new Set(payout.transactions.filter((t) => !(t.type in POSTABLE)).map((t) => t.type))];
  if (others.length > 0) {
    return refuse(
      `${what} has ${others.join(", ").toLowerCase()} transactions; only charges, refunds, adjustments, chargebacks and reserves are posted, so record this payout by hand.`,
    );
  }
  for (const t of payout.transactions) {
    const sign = POSTABLE[t.type];
    const amount = dec(t.amount);
    if ((sign === "negative" && !isNegative(amount)) || (sign === "positive" && !isPositive(amount))) {
      return refuse(`${what} has a ${t.type.toLowerCase()} transaction of ${money(amount)}; Tohyee expects it to be ${sign}, so record this payout by hand.`);
    }
  }
  const net = dec(payout.net);
  const nets = sum(payout.transactions.map((t) => dec(t.net)));
  if (cmp(nets, net) !== 0) return refuse(`${what}'s transactions come to ${money(nets)} but the payout is ${money(net)}, so nothing was posted.`);
  if (!isPositive(net)) return refuse(`${what} is ${money(net)}; only payouts of more than nothing are posted.`);
  const fees = sum(payout.transactions.map((t) => dec(t.fee)));
  if (isNegative(fees)) return refuse(`${what}'s fees come to ${money(fees)} (fees given back); that isn't supported yet.`);
  const charges: PayoutLine[] = [];
  const receipts: PayoutLine[] = [];
  if (isPositive(fees)) charges.push({ description: `Shopify Payments fees, payout ${payout.externalId}`, amount: money(fees), account: "fees" });
  for (const t of payout.transactions.filter((entry) => entry.type === "ADJUSTMENT")) {
    // An adjustment's own fee is already in the fees; its amount is what's left.
    const amount = sub(dec(t.net), sub(ZERO_DECIMAL, dec(t.fee)));
    if (isPositive(amount)) return refuse(`${what} has an adjustment that adds ${money(amount)}; adjustments in Tohyee's favour aren't supported yet.`);
    if (isZero(amount)) continue;
    charges.push({ description: `Shopify adjustment${t.adjustmentReason ? `: ${t.adjustmentReason}` : ""}, payout ${payout.externalId}`, amount: money(sub(ZERO_DECIMAL, amount)), account: "fees" });
  }
  const on = (t: PlatformBalanceTransaction) => (t.orderName ? ` on ${t.orderName}` : "");
  for (const t of payout.transactions.filter((entry) => DISPUTES.includes(entry.type))) {
    // Each one's fee is already in the fees; its amount (taken or given back) is the line.
    const amount = dec(t.amount);
    const line: PayoutLine =
      t.type === "DISPUTE_WITHDRAWAL" || t.type === "DISPUTE_REVERSAL"
        ? { description: `${t.type === "DISPUTE_WITHDRAWAL" ? "Chargeback" : "Chargeback won"}${on(t)}, payout ${payout.externalId}`, amount: money(abs(amount)), account: "chargebacks" }
        : { description: `${t.type === "CHARGEBACK_FEE" ? "Chargeback fee" : "Chargeback fee given back"}${on(t)}, payout ${payout.externalId}`, amount: money(abs(amount)), account: "fees" };
    (isNegative(amount) ? charges : receipts).push(line);
  }
  const reserve = (type: string) => {
    const total = sum(payout.transactions.filter((t) => t.type === type).map((t) => abs(dec(t.amount))));
    return isZero(total) ? null : money(total);
  };
  return { ok: true, date: localDate(payout.issuedAt), net: money(net), charges, receipts, reserveHeld: reserve("RESERVED_FUNDS"), reserveReleased: reserve("RESERVED_FUNDS_REVERSAL") };
}
