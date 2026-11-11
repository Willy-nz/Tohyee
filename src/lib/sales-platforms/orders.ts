import { businessTimeZone } from "@/lib/dates";
import { type GstRegistration, gstStatusOn, isRegisteredOn, unconfirmedMessage } from "@/lib/tax/registration";
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
  mulDiv,
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
  /** Where gift cards sold are held (GC1), and the no-GST code for them; null refuses orders with gift cards. */
  giftCardAccountCode?: string | null;
  giftCardTaxCode?: string | null;
  /** The platform's name in messages ("Shopify", "WooCommerce"); Shopify when not given. */
  platformName?: string;
};

/** A variant linked to an item. */
export type LinkedItem = { id: string; code: string; itemType: string; incomeAccountCode: string | null };

/** The order line or shipping line a planned line came from (sales when sent, SWS1). */
export type LineSource = { kind: "line" | "shipping"; externalId: string; requiresShipping: boolean };

export type PlannedLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string | null;
  itemId: string | null;
  /** Where it came from; left off what's sent to the documents. */
  source?: LineSource;
};

export type Refusal = { ok: false; reason: string };

export type OrderPlan =
  | {
      ok: true;
      amountsMode: AmountsMode;
      lines: PlannedLine[];
      /** Each line's tax rate, in step with `lines`. */
      rates: string[];
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

type Draft = {
  what: string;
  amount: Decimal;
  quantity: string;
  shopifyTax: Decimal;
  tax: { code: string | null; rate: string | null };
  accountCode: string;
  itemId: string | null;
  description: string;
  source: LineSource;
};

/**
 * The sales order's lines for an order (SPC11-SPC13, SPC16, SPC17, SPC23),
 * or why it can't come in. `items` are the items linked to the order's
 * variants; `overseas` is whether the customer's contact is overseas.
 */
/**
 * Why a new order dated `date` waits instead of coming in (#546, GSR3): the
 * setting says registered on that date but no one has confirmed it, so
 * Tohyee doesn't decide on its own whether the order has GST. Null: go on.
 * Orders already in the books (refunds, payments) follow what they were.
 */
export function gstWaitReason(rules: PostingRules, date: string): string | null {
  if (!rules.gstRegistration || gstStatusOn(rules.gstRegistration, date) !== "unconfirmed") return null;
  return unconfirmedMessage(rules.gstRegistration.organisationName);
}

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
  if (order.lines.some((line) => line.isGiftCard) && !rules.giftCardAccountCode) {
    return refuse(`${name} sells a gift card; choose where gift cards are held in the Shopify settings to bring it in.`);
  }
  if (order.lines.some((line) => line.isGiftCard) && rules.gstRegistered && !rules.giftCardTaxCode) {
    return refuse(`${name} sells a gift card, which has no GST, but there's no active "no GST (out of scope)" tax code to put it on.`);
  }
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
    source: LineSource,
  ): Draft | Refusal => {
    if (isNegative(gross)) return refuse(`${what} comes to less than nothing (${money(gross)}).`);
    const tax = taxCodeFor(taxLines, rules, overseas, what);
    if (!tax.ok) return tax;
    const shopifyTax = taxOf(taxLines);
    // Not GST registered: tax Shopify added on top is part of the sale (decision 53).
    const amount = amountsMode === "no_tax" && !order.taxesIncluded ? add(gross, shopifyTax) : gross;
    return { what, amount, quantity, shopifyTax, tax: { code: tax.code, rate: tax.rate }, accountCode, itemId, description, source };
  };

  for (const line of order.lines) {
    if (!isPositive(dec(line.quantity))) continue;
    if (line.isGiftCard) {
      // GC1: a gift card sold is money held for whoever spends it, not a sale. No GST now; the things it's spent on carry it (GC2).
      const gross = sub(dec(line.originalTotal), dec(line.discount));
      if (isNegative(gross)) return refuse(`${name} line "${line.name}" comes to less than nothing (${money(gross)}).`);
      if (isPositive(taxOf(line.taxLines))) return refuse(`${name} charged tax on gift card "${line.name}"; gift cards with tax aren't supported.`);
      drafts.push({
        what: `${name} gift card "${line.name}"`,
        amount: gross,
        quantity: line.quantity,
        shopifyTax: ZERO_DECIMAL,
        tax: rules.gstRegistered ? { code: rules.giftCardTaxCode!, rate: "0" } : { code: null, rate: null },
        accountCode: rules.giftCardAccountCode!,
        itemId: null,
        description: line.name,
        source: { kind: "line", externalId: line.externalId, requiresShipping: false },
      });
      continue;
    }
    const item = line.variantId ? items.get(line.variantId) ?? null : null;
    const draft = draftFor(
      `${name} line "${line.name}"`,
      line.name,
      sub(dec(line.originalTotal), dec(line.discount)),
      line.quantity,
      line.taxLines,
      item?.incomeAccountCode ?? rules.salesAccountCode,
      item?.id ?? null,
      { kind: "line", externalId: line.externalId, requiresShipping: line.requiresShipping !== false },
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
      { kind: "shipping", externalId: shipping.externalId, requiresShipping: true },
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
      lines.push({
        description: draft.description,
        quantity: part.quantity,
        unitPrice: part.unitPrice,
        accountCode: draft.accountCode,
        taxCode: draft.tax.code,
        itemId: draft.itemId,
        source: draft.source,
      });
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
  return { ok: true, amountsMode, lines, rates, total, notes };
}

// ---------------------------------------------------------------------------
// Payments

const succeeded = (transaction: PlatformTransaction) => transaction.status === "SUCCESS" && !transaction.test;

/** The money received for an order: its successful sales and captures (SPC11). */
export function orderPayments(order: PlatformOrder): { amount: Decimal; lastAt: string | null; giftCard: boolean; giftCardAmount: Decimal } {
  const received = order.transactions.filter((t) => succeeded(t) && (t.kind === "SALE" || t.kind === "CAPTURE"));
  let lastAt: string | null = null;
  for (const t of received) if (t.processedAt && (!lastAt || Date.parse(t.processedAt) > Date.parse(lastAt))) lastAt = t.processedAt;
  return {
    amount: sum(received.map((t) => dec(t.amount))),
    lastAt,
    giftCard: received.some((t) => t.gateway === "gift_card"),
    giftCardAmount: sum(received.filter((t) => t.gateway === "gift_card").map((t) => dec(t.amount))),
  };
}

/** Shopify Payments' gateway name on an order's transactions: its money is paid out by Shopify Payments payouts, through the clearing account. */
export const SHOPIFY_PAYMENTS_GATEWAY = "shopify_payments";

/**
 * The gateway a Shopify order was paid through (SPC42-SPC46): the gateway
 * of its successful sales and captures, or null when nothing was paid
 * (a 0.00 order). Refused when it was split across gateways, which Tohyee
 * doesn't post yet. Gift cards are refused on their own (SPC23).
 */
export function paymentGateway(order: PlatformOrder): { ok: true; gateway: string | null } | Refusal {
  const gateways = [
    ...new Set(order.transactions.filter((t) => succeeded(t) && (t.kind === "SALE" || t.kind === "CAPTURE") && t.gateway !== "gift_card").map((t) => t.gateway ?? "")),
  ];
  if (gateways.length > 1) {
    return refuse(`${order.name} was paid through more than one payment method (${gateways.map((g) => g || "unnamed").join(", ")}); split payments aren't supported yet, so it isn't invoiced.`);
  }
  if (gateways.length === 1 && gateways[0] === "") return refuse(`${order.name}'s payment doesn't say which payment method it came through, so Tohyee can't tell where its money went.`);
  return { ok: true, gateway: gateways[0] ?? null };
}

/** Shopify's financial statuses for an order that's been paid in full (some may since have been refunded). */
export const PAID_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

// ---------------------------------------------------------------------------
// Refunds

/**
 * What an order still holds for sales when sent (SWS5, SWS6): each order line's
 * quantity not yet sent or refunded, and its shipping lines not yet counted.
 */
export type RefundHeld = { accountCode: string; lines: ReadonlyMap<string, Decimal>; shipping: ReadonlySet<string> };
/** A part of a refund taken from what's held: its credit note lines (indexes) and the quantity. */
export type HeldUse = { kind: "line" | "shipping"; externalId: string; quantity: string; lineIndexes: number[] };

export type RefundPlan =
  | { ok: true; lines: PlannedLine[]; rates: Array<string | null>; amountsMode: AmountsMode; total: string; refunded: string; date: string; held: HeldUse[] }
  | Refusal
  | { ok: "nothing"; reason: string };

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
  held: RefundHeld | null = null,
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
  const uses: HeldUse[] = [];
  for (const entry of refund.lines) {
    if (!isPositive(dec(entry.quantity)) && isZero(dec(entry.subtotal))) continue;
    const line = byId.get(entry.lineItemId);
    if (!line) return refuse(`${what} refunds a line that isn't on the order.`);
    if (line.isGiftCard) {
      // GC4: a gift card refunded comes back out of what's held for it, with no GST, as it went in.
      if (!rules.giftCardAccountCode || (rules.gstRegistered && !rules.giftCardTaxCode)) return refuse(`${what} refunds a gift card, and gift cards aren't set up.`);
      for (const part of splitAmount(money(dec(entry.subtotal)), isPositive(dec(entry.quantity)) ? entry.quantity : "1")) {
        lines.push({ description: line.name, quantity: part.quantity, unitPrice: part.unitPrice, accountCode: rules.giftCardAccountCode, taxCode: rules.gstRegistered ? rules.giftCardTaxCode! : null, itemId: null });
        rates.push(rules.gstRegistered ? "0" : null);
      }
      continue;
    }
    const item = line.variantId ? items.get(line.variantId) ?? null : null;
    const tax = taxCodeFor(line.taxLines, rules, overseas, `${what} line "${line.name}"`);
    if (!tax.ok) return tax;
    const amount = amountsMode === "no_tax" && !order.taxesIncluded ? add(dec(entry.subtotal), dec(entry.tax)) : dec(entry.subtotal);
    // A restocked stock item comes back into stock at the sale's cost (ST5); anything else is a line without the item.
    const keepItem = item !== null && (item.itemType !== "stock" || entry.restocked);
    // Still held (SWS5, SWS6): the part not yet sent comes out of Income in advance, without the item (it never left stock).
    const unsent = held?.lines.get(line.externalId) ?? ZERO_DECIMAL;
    const quantity = dec(entry.quantity);
    const parts: Array<{ amount: Decimal; quantity: string; held: boolean; heldQuantity: string }> = [];
    if (!isPositive(unsent)) {
      parts.push({ amount, quantity: isPositive(quantity) ? entry.quantity : "1", held: false, heldQuantity: "0" });
    } else if (!isPositive(quantity)) {
      // An amount only (a goodwill refund) on a line still to be sent: all of it from what's held.
      parts.push({ amount, quantity: "1", held: true, heldQuantity: "0" });
    } else {
      const fromHeld = cmp(quantity, unsent) <= 0 ? quantity : unsent;
      const heldAmount = cmp(fromHeld, quantity) === 0 ? amount : mulDiv(amount, fromHeld, quantity, 2);
      parts.push({ amount: heldAmount, quantity: toPlainString(fromHeld), held: true, heldQuantity: toPlainString(fromHeld) });
      const restQuantity = sub(quantity, fromHeld);
      if (isPositive(restQuantity)) parts.push({ amount: sub(amount, heldAmount), quantity: toPlainString(restQuantity), held: false, heldQuantity: "0" });
    }
    for (const portion of parts) {
      const indexes: number[] = [];
      for (const part of splitAmount(money(portion.amount), portion.quantity)) {
        indexes.push(lines.length);
        lines.push({
          description: line.name,
          quantity: part.quantity,
          unitPrice: part.unitPrice,
          accountCode: portion.held ? held!.accountCode : (item?.incomeAccountCode ?? rules.salesAccountCode),
          taxCode: tax.code,
          itemId: portion.held ? null : keepItem ? item!.id : null,
        });
        rates.push(tax.rate);
      }
      if (portion.held) uses.push({ kind: "line", externalId: line.externalId, quantity: portion.heldQuantity, lineIndexes: indexes });
    }
  }
  for (const entry of refund.shipping) {
    const shipping = order.shipping.find((s) => s.externalId === entry.shippingLineId) ?? order.shipping.find((s) => !s.removed) ?? null;
    const tax = taxCodeFor(shipping?.taxLines ?? [], rules, overseas, `${what} shipping`);
    if (!tax.ok) return tax;
    const amount = amountsMode === "no_tax" && !order.taxesIncluded ? add(dec(entry.subtotal), dec(entry.tax)) : dec(entry.subtotal);
    if (isZero(amount)) continue;
    // Shipping not yet counted (nothing sent yet) comes out of Income in advance (SWS5).
    const shippingHeld = shipping !== null && held !== null && held.shipping.has(shipping.externalId);
    if (shippingHeld) uses.push({ kind: "shipping", externalId: shipping!.externalId, quantity: "0", lineIndexes: [lines.length] });
    lines.push({
      description: `Shipping: ${shipping?.title ?? "shipping"}`,
      quantity: "1",
      unitPrice: money(amount),
      accountCode: shippingHeld ? held!.accountCode : rules.shippingAccountCode,
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
  return { ok: true, lines, rates, amountsMode, total, refunded: money(refunded), date: localDate(at), held: uses };
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
      /** The payout's amount, always positive: what reached the bank, or (a withdrawal) what Shopify took from it. */
      net: string;
      /** A deposit moves the net from the clearing account to the bank; a withdrawal moves it from the bank into the clearing account (SPC40). */
      direction: "deposit" | "withdrawal";
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

/**
 * The payout's own movement of money (SPC38). Shopify lists it among the
 * payout's balance transactions as TRANSFER ("a payout to the bank or a
 * withdrawal into the balance; the sign shows the direction"). It is the
 * clearing-to-bank transfer itself, so it is checked against the payout and
 * never posted as a line of its own.
 */
export const PAYOUT_TRANSFER_TYPE = "TRANSFER";

const DISPUTES = ["DISPUTE_WITHDRAWAL", "DISPUTE_REVERSAL", "CHARGEBACK_FEE", "CHARGEBACK_FEE_REFUND"];

/** A payout's amount as it moves money to the bank: positive for a deposit, negative for a withdrawal, whichever sign Shopify gave it. */
export function signedPayoutNet(net: string, direction: string): Decimal {
  const amount = abs(dec(net));
  return direction === "WITHDRAWAL" ? sub(ZERO_DECIMAL, amount) : amount;
}

/**
 * A Shopify Payments payout (SPC15, SPC25-SPC31, SPC38-SPC41): the transfer
 * to the bank for its net (a withdrawal: from the bank); the fees,
 * adjustments, chargebacks and chargeback fees as one spend money from the
 * clearing account; won disputes and chargeback fees given back as one
 * receive money; and reserves held or released as transfers to or from the
 * reserve account. The payout's own TRANSFER row must equal the payout: it
 * is the transfer itself. Refused if anything else in it is another type or
 * has an unexpected sign, or the balance transactions don't add up to it.
 */
export function planPayout(payout: PlatformPayout, baseCurrency: string): PayoutPlan {
  const what = `Payout ${payout.externalId}`;
  if (payout.direction !== "DEPOSIT" && payout.direction !== "WITHDRAWAL") {
    return refuse(`${what} is a ${payout.direction.toLowerCase()} payout, a kind Tohyee doesn't know, so record this payout by hand.`);
  }
  if (payout.currency !== baseCurrency) return refuse(`${what} is in ${payout.currency}; Tohyee only brings in payouts in ${baseCurrency}.`);
  if (payout.incomplete) return refuse(`${what} has more balance transactions than Tohyee reads.`);
  const withdrawal = payout.direction === "WITHDRAWAL";
  const signed = signedPayoutNet(payout.net, payout.direction);
  if (isZero(signed)) return refuse(`${what} is ${money(signed)}; only payouts of more than nothing are posted.`);
  // SPC38: the payout's own transfer, the payout the other way round (out of Shopify's balance for a deposit).
  const transfers = payout.transactions.filter((t) => t.type === PAYOUT_TRANSFER_TYPE);
  const rows = payout.transactions.filter((t) => t.type !== PAYOUT_TRANSFER_TYPE);
  if (transfers.length > 0) {
    const moved = sum(transfers.map((t) => dec(t.amount)));
    const expected = sub(ZERO_DECIMAL, signed);
    if (transfers.length > 1 || cmp(moved, expected) !== 0) {
      return refuse(
        `${what}'s transfer rows come to ${money(moved)}, but Tohyee expects one transfer of ${money(expected)} for this payout, so record this payout by hand.`,
      );
    }
    const transferFee = sum(transfers.map((t) => dec(t.fee)));
    if (!isZero(transferFee)) {
      return refuse(`${what}'s transfer has a fee of ${money(transferFee)} (an instant payout?); fees on the transfer itself aren't supported yet, so record this payout by hand.`);
    }
  }
  const others = [...new Set(rows.filter((t) => !(t.type in POSTABLE)).map((t) => t.type))];
  if (others.length > 0) {
    return refuse(
      `${what} has transactions of a type Tohyee doesn't post (${others.join(", ")}); only charges, refunds, adjustments, chargebacks, reserves and the payout's own transfer are posted, so record this payout by hand.`,
    );
  }
  for (const t of rows) {
    const sign = POSTABLE[t.type];
    const amount = dec(t.amount);
    if ((sign === "negative" && !isNegative(amount)) || (sign === "positive" && !isPositive(amount))) {
      return refuse(`${what} has a ${t.type.toLowerCase()} transaction of ${money(amount)}; Tohyee expects it to be ${sign}, so record this payout by hand.`);
    }
  }
  const nets = sum(rows.map((t) => dec(t.net)));
  if (cmp(nets, signed) !== 0) return refuse(`${what}'s transactions come to ${money(nets)} but the payout is ${money(signed)}, so nothing was posted.`);
  const net = abs(signed);
  const fees = sum(rows.map((t) => dec(t.fee)));
  if (isNegative(fees)) return refuse(`${what}'s fees come to ${money(fees)} (fees given back); that isn't supported yet.`);
  const charges: PayoutLine[] = [];
  const receipts: PayoutLine[] = [];
  if (isPositive(fees)) charges.push({ description: `Shopify Payments fees, payout ${payout.externalId}`, amount: money(fees), account: "fees" });
  for (const t of rows.filter((entry) => entry.type === "ADJUSTMENT")) {
    // An adjustment's own fee is already in the fees; its amount is what's left.
    const amount = sub(dec(t.net), sub(ZERO_DECIMAL, dec(t.fee)));
    if (isPositive(amount)) return refuse(`${what} has an adjustment that adds ${money(amount)}; adjustments in Tohyee's favour aren't supported yet.`);
    if (isZero(amount)) continue;
    charges.push({ description: `Shopify adjustment${t.adjustmentReason ? `: ${t.adjustmentReason}` : ""}, payout ${payout.externalId}`, amount: money(sub(ZERO_DECIMAL, amount)), account: "fees" });
  }
  const on = (t: PlatformBalanceTransaction) => (t.orderName ? ` on ${t.orderName}` : "");
  for (const t of rows.filter((entry) => DISPUTES.includes(entry.type))) {
    // Each one's fee is already in the fees; its amount (taken or given back) is the line.
    const amount = dec(t.amount);
    const line: PayoutLine =
      t.type === "DISPUTE_WITHDRAWAL" || t.type === "DISPUTE_REVERSAL"
        ? { description: `${t.type === "DISPUTE_WITHDRAWAL" ? "Chargeback" : "Chargeback won"}${on(t)}, payout ${payout.externalId}`, amount: money(abs(amount)), account: "chargebacks" }
        : { description: `${t.type === "CHARGEBACK_FEE" ? "Chargeback fee" : "Chargeback fee given back"}${on(t)}, payout ${payout.externalId}`, amount: money(abs(amount)), account: "fees" };
    (isNegative(amount) ? charges : receipts).push(line);
  }
  const reserve = (type: string) => {
    const total = sum(rows.filter((t) => t.type === type).map((t) => abs(dec(t.amount))));
    return isZero(total) ? null : money(total);
  };
  return { ok: true, date: localDate(payout.issuedAt), net: money(net), direction: withdrawal ? "withdrawal" : "deposit", charges, receipts, reserveHeld: reserve("RESERVED_FUNDS"), reserveReleased: reserve("RESERVED_FUNDS_REVERSAL") };
}

/** Orders by when they were placed (processed, else created), then by number, so the first sync numbers them in date order (decision 1341). */
export function oldestFirst<T extends { processedAt: string; name: string; externalId: string }>(orders: readonly T[]): T[] {
  const number = (order: T) => Number(order.name.match(/\d+/)?.[0] ?? Number.NaN);
  return [...orders].sort((a, b) => {
    const byDate = Date.parse(a.processedAt) - Date.parse(b.processedAt);
    if (byDate !== 0) return byDate;
    const byNumber = number(a) - number(b);
    if (!Number.isNaN(byNumber) && byNumber !== 0) return byNumber;
    return a.externalId.localeCompare(b.externalId, "en", { numeric: true });
  });
}
