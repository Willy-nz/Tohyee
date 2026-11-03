/**
 * Matching a bank deposit to a platform payout (#548, examples SPR1-SPR10,
 * decisions 1300-1307). Pure functions, shared with the browser: the
 * settlement a payout's balance transactions add up to, and what a bank
 * line most likely is. Nothing here posts. A match needs more than the
 * amount: the payout's ID on the line, or the platform's name on it with the
 * amount inside the timing window. Anything less is offered for a person to
 * choose, or left unresolved with its reason.
 */
import { abs, add, cmp, dec, isZero, neg, sum, toFixedString, ZERO_DECIMAL, type Decimal } from "@/lib/money/decimal";

/** How many days before the bank line a payout can be issued (banks take a few working days, longer over holidays). */
export const PAYOUT_DAYS_BEFORE = 10;
/** How many days after the bank line (a payout dated in the store's time zone can land the day before). */
export const PAYOUT_DAYS_AFTER = 1;
/** The most payouts one deposit is looked at as combining. */
const MOST_COMBINED = 4;
/** The payouts nearest the line considered for a combination. */
const COMBINATION_POOL = 12;

/** A payout's settlement, signed as it moves the payout: sales add, the rest mostly take away. */
export type Settlement = {
  grossSales: string;
  refunds: string;
  fees: string;
  adjustments: string;
  chargebacks: string;
  reserves: string;
  /** Transaction types Tohyee doesn't post (the payout is refused and recorded by hand). */
  other: string;
  net: string;
  transactionCount: number;
  /** Whether the parts add up to the payout's net. */
  addsUp: boolean;
  /** Orders whose charges are in it ("#1001"). */
  orderNames: string[];
};

export type SettlementTransaction = { type: string; amount: string; fee: string; net: string; orderName: string | null };

const CHARGEBACK_TYPES = ["DISPUTE_WITHDRAWAL", "DISPUTE_REVERSAL"];
const CHARGEBACK_FEE_TYPES = ["CHARGEBACK_FEE", "CHARGEBACK_FEE_REFUND"];
const RESERVE_TYPES = ["RESERVED_FUNDS", "RESERVED_FUNDS_REVERSAL"];
const KNOWN = ["CHARGE", "REFUND", "ADJUSTMENT", ...CHARGEBACK_TYPES, ...CHARGEBACK_FEE_TYPES, ...RESERVE_TYPES];
/** The payout's own transfer to (or from) the bank (SPC38): the payout itself, so not part of its settlement. */
const TRANSFER_TYPE = "TRANSFER";

/** A payout's net as it moves money to the bank: a withdrawal's is negative, whichever sign the store gave (SPC40). */
export function signedNet(net: string, direction: string): Decimal {
  return direction === "WITHDRAWAL" ? neg(abs(dec(net))) : abs(dec(net));
}

const money = (value: Decimal) => toFixedString(value, 2);

/**
 * The settlement of a payout from its balance transactions (SPR1): charges
 * are gross sales; each transaction's fee, and chargeback fees, are fees;
 * disputes are chargebacks. Each transaction's net is its amount less its
 * fee, so the parts add up to the net when Shopify's figures agree.
 */
export function summariseSettlement(all: readonly SettlementTransaction[], net: string, direction = "DEPOSIT"): Settlement {
  // The payout's own TRANSFER row is the payout leaving the balance, not part of what it's made of (SPC38).
  const transactions = all.filter((t) => t.type !== TRANSFER_TYPE);
  const amounts = (match: (type: string) => boolean) => sum(transactions.filter((t) => match(t.type)).map((t) => dec(t.amount)));
  const grossSales = amounts((type) => type === "CHARGE");
  const refunds = amounts((type) => type === "REFUND");
  const fees = add(neg(sum(transactions.map((t) => dec(t.fee)))), amounts((type) => CHARGEBACK_FEE_TYPES.includes(type)));
  const adjustments = amounts((type) => type === "ADJUSTMENT");
  const chargebacks = amounts((type) => CHARGEBACK_TYPES.includes(type));
  const reserves = amounts((type) => RESERVE_TYPES.includes(type));
  const other = amounts((type) => !KNOWN.includes(type));
  const total = sum([grossSales, refunds, fees, adjustments, chargebacks, reserves, other]);
  const orderNames = [...new Set(transactions.filter((t) => t.type === "CHARGE" && t.orderName).map((t) => t.orderName!))];
  return {
    grossSales: money(grossSales),
    refunds: money(refunds),
    fees: money(fees),
    adjustments: money(adjustments),
    chargebacks: money(chargebacks),
    reserves: money(reserves),
    other: money(other),
    net: money(signedNet(net, direction)),
    transactionCount: transactions.length,
    addsUp: cmp(total, signedNet(net, direction)) === 0,
    orderNames,
  };
}

/** A payout as the matcher sees it. */
export type PayoutCandidate = {
  connectionId: string;
  /** "Shopify". */
  platformLabel: string;
  externalId: string;
  issuedOn: string;
  /** PAID, IN_TRANSIT, SCHEDULED, FAILED, CANCELED. */
  status: string;
  direction: string;
  net: string;
  currency: string;
  /** Null when the settlement wasn't read (posted before #548, or not paid yet). */
  settlement: Settlement | null;
  /** The posted payout's transfer line on the bank account, and the statement line it's reconciled with, if any. */
  posted: { journalLineId: string; journalId: string; reconciledLineId: string | null; reconciledLineDate: string | null } | null;
  /** Why the sync didn't post it (its latest refused or failed log line), if it said. */
  refusal: string | null;
  /** Orders in the settlement not in the books (before the start date, waiting for GST, refused). */
  ordersNotInBooks: string[];
};

/** A connection that pays out (Shopify), as the matcher needs it. */
export type PayoutConnection = {
  connectionId: string;
  platformLabel: string;
  /** Lower case words to look for on a bank line ("shopify"). */
  names: string[];
  postingOn: boolean;
  /** The bank account payouts arrive in, by id. */
  payoutAccountId: string | null;
  payoutAccountCode: string | null;
  clearingAccountCode: string | null;
  clearingAccountName: string | null;
  startDate: string | null;
  /** Settings posting still needs ("fees account"). */
  missing: string[];
  /** Whether the store gave the scopes to read payouts. */
  readsPayouts: boolean;
};

export type DepositLine = { id: string; accountId: string; date: string; amount: string; text: string };

/**
 * What a bank line is (SPR2-SPR10). `reason` is plain words for the person;
 * the status is the code MCP and tests use. The three kinds of "not
 * matched" the issue asks to tell apart: `missing_posting_setup`,
 * `missing_settlement_data` and `unmatched`.
 */
export type PayoutMatchStatus =
  | "matched"
  | "combined"
  | "needs_choice"
  | "already_matched"
  | "payout_not_posted"
  | "missing_posting_setup"
  | "missing_settlement_data"
  | "unmatched";

export type PayoutAction =
  /** Reconcile with the posted payouts' transfers (the existing "match": nothing new is posted). */
  | { kind: "match"; journalLineIds: string[] }
  /** No settlement to read: the deposit as a transfer out of the clearing account; the fees stay there until recorded. */
  | { kind: "transfer"; otherAccountCode: string };

export type PayoutGuidance = {
  status: PayoutMatchStatus;
  platformLabel: string;
  reason: string;
  /** The payouts it's matched to, or the ones to choose from. */
  payouts: PayoutCandidate[];
  /** The reconcile command that would do it, for a person to review; null when it stays unresolved. */
  action: PayoutAction | null;
  /** How sure: the payout's ID is on the line, or its platform name and amount and date fit. */
  evidence: "payout_id" | "platform_amount_date" | "amount_date" | null;
};

const cents = (amount: string) => toFixedString(dec(amount), 2);

function dayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000;
}

/** Whether a payout issued on `issuedOn` can be the bank line on `lineDate` (SPR4). */
export function inTimingWindow(issuedOn: string, lineDate: string): boolean {
  const days = dayNumber(lineDate) - dayNumber(issuedOn);
  return days >= -PAYOUT_DAYS_AFTER && days <= PAYOUT_DAYS_BEFORE;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Whether the payout's ID is on the line as a word of its own ("PAYOUT 70001", "70001-SHOP"), not inside a longer number. */
export function mentionsId(text: string, externalId: string): boolean {
  return words(text).includes(externalId.toLowerCase());
}

function mentionsPlatform(text: string, connection: PayoutConnection): boolean {
  const lower = text.toLowerCase();
  return connection.names.some((name) => lower.includes(name));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Oct 2026", as the screens show dates. */
export function shortDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

const describe = (payout: PayoutCandidate) => `${payout.platformLabel} payout ${payout.externalId} (${payout.net}, ${shortDate(payout.issuedOn)})`;

function list(payouts: PayoutCandidate[]): string {
  return payouts.map(describe).join(", ");
}

/** The subsets of `pool` (2 to 4 payouts) whose nets add up to `target`. */
function combinations(pool: PayoutCandidate[], target: Decimal): PayoutCandidate[][] {
  const found: PayoutCandidate[][] = [];
  const walk = (start: number, chosen: PayoutCandidate[], total: Decimal) => {
    if (chosen.length >= 2 && cmp(total, target) === 0) found.push([...chosen]);
    if (chosen.length === MOST_COMBINED || found.length > 1) return;
    for (let index = start; index < pool.length; index += 1) {
      chosen.push(pool[index]);
      walk(index + 1, chosen, add(total, dec(pool[index].net)));
      chosen.pop();
    }
  };
  walk(0, [], ZERO_DECIMAL);
  return found;
}

/**
 * Turns the chosen payouts into guidance: matched (or combined) when every
 * one is posted and not yet reconciled; otherwise what stops it.
 */
function settle(chosen: PayoutCandidate[], evidence: NonNullable<PayoutGuidance["evidence"]>, label: string): PayoutGuidance {
  const reconciled = chosen.filter((payout) => payout.posted?.reconciledLineId);
  if (reconciled.length > 0) {
    const first = reconciled[0];
    return {
      status: "already_matched",
      platformLabel: label,
      reason: `${describe(first)} is already matched to the bank line on ${shortDate(first.posted!.reconciledLineDate!)}. This line may be a duplicate import: if it is, exclude it.`,
      payouts: chosen,
      action: null,
      evidence,
    };
  }
  const unposted = chosen.filter((payout) => !payout.posted);
  if (unposted.length > 0) {
    const first = unposted[0];
    const why =
      first.status !== "PAID"
        ? `${first.platformLabel} hasn't marked it paid yet (${first.status.toLowerCase().replace(/_/g, " ")}). Sync the store again later.`
        : first.refusal ?? "It hasn't been posted yet. Sync the store, or check its log.";
    return {
      status: "payout_not_posted",
      platformLabel: label,
      reason: `${describe(first)} isn't in the accounts yet. ${why}`,
      payouts: chosen,
      action: null,
      evidence,
    };
  }
  return {
    status: chosen.length > 1 ? "combined" : "matched",
    platformLabel: label,
    reason:
      chosen.length > 1
        ? `This deposit is ${chosen.length} payouts together: ${list(chosen)}. Their sales and fees are already in the accounts; matching only ties the bank line to them.`
        : `This deposit is ${describe(chosen[0])}. Its sales and fees are already in the accounts; matching only ties the bank line to it.`,
    payouts: chosen,
    action: { kind: "match", journalLineIds: chosen.map((payout) => payout.posted!.journalLineId) },
    evidence,
  };
}

/**
 * What a bank line is, as far as platform payouts go (SPR2-SPR10), or null
 * when it has nothing to do with them (no store pays into its account and
 * it doesn't name one). Money out is only looked at for a withdrawal payout
 * with its ID on the line, so a Shopify subscription bill isn't caught.
 */
export function guidePayoutLine(line: DepositLine, connections: readonly PayoutConnection[], payouts: readonly PayoutCandidate[]): PayoutGuidance | null {
  const moneyIn = !line.amount.startsWith("-");
  const named = connections.filter((connection) => mentionsPlatform(line.text, connection));
  const intoAccount = connections.filter((connection) => connection.payoutAccountId === line.accountId);
  const ids = new Set([...named, ...intoAccount].map((connection) => connection.connectionId));
  const relevant = connections.filter((connection) => ids.has(connection.connectionId));
  const ofRelevant = payouts.filter((payout) => ids.has(payout.connectionId));
  const byId = ofRelevant.filter((payout) => mentionsId(line.text, payout.externalId));

  if (!moneyIn) {
    // SPC40: a withdrawal (money taken from the bank), by its ID on the line, or Shopify's name and the amount in the window.
    const withdrawals = ofRelevant.filter((payout) => payout.direction === "WITHDRAWAL");
    const out = abs(dec(line.amount));
    const named = withdrawals.filter((payout) => mentionsId(line.text, payout.externalId));
    const fits = named.length > 0 ? named : withdrawals.filter((payout) => mentionsPlatform(line.text, connections.find((c) => c.connectionId === payout.connectionId)!) && inTimingWindow(payout.issuedOn, line.date) && cmp(abs(dec(payout.net)), out) === 0);
    if (fits.length !== 1) return null;
    const withdrawal = fits[0];
    if (cmp(abs(dec(withdrawal.net)), out) !== 0) {
      return {
        status: "unmatched",
        platformLabel: withdrawal.platformLabel,
        reason: `The line names ${describe(withdrawal)}, but it's ${cents(line.amount)}. Check the bank line and the payout in ${withdrawal.platformLabel}; nothing is matched on amount alone.`,
        payouts: [withdrawal],
        action: null,
        evidence: null,
      };
    }
    const guided = settle([withdrawal], named.length > 0 ? "payout_id" : "platform_amount_date", withdrawal.platformLabel);
    return guided.status === "matched"
      ? { ...guided, reason: `This is ${describe(withdrawal)}: ${withdrawal.platformLabel} took it from the bank to cover refunds or fees. It's already in the accounts; matching only ties the bank line to it.` }
      : guided;
  }
  if (relevant.length === 0) return null;
  const amount = dec(line.amount);
  const usable = ofRelevant.filter(
    (payout) => payout.direction === "DEPOSIT" && payout.status !== "FAILED" && payout.status !== "CANCELED" && inTimingWindow(payout.issuedOn, line.date),
  );
  const platformNamed = named.length > 0;
  // An ordinary deposit into the account payouts arrive in (a customer paying): nothing points to a payout.
  if (!platformNamed && byId.length === 0 && !usable.some((payout) => cmp(dec(payout.net), amount) === 0)) return null;
  const label = (intoAccount[0] ?? named[0]).platformLabel;

  // SPR8: the store isn't set up to post payouts into this account.
  if (intoAccount.length === 0) {
    const connection = named[0];
    return {
      status: "missing_posting_setup",
      platformLabel: label,
      reason: connection.payoutAccountCode
        ? `${label} payouts are set to arrive in ${connection.payoutAccountCode}, not this account. Change it in the ${label} settings if they now come here.`
        : `${label} isn't set up to post payouts. Choose the account they arrive in, in the ${label} settings.`,
      payouts: [],
      action: null,
      evidence: null,
    };
  }
  const settingUp = intoAccount.filter((connection) => !connection.postingOn || connection.missing.length > 0);
  if (settingUp.length === intoAccount.length) {
    const connection = settingUp[0];
    return {
      status: "missing_posting_setup",
      platformLabel: label,
      reason: !connection.postingOn
        ? `Posting ${label} sales to the accounts is off, so its sales and fees aren't in the books. Turn it on in the ${label} settings, or code this deposit by hand.`
        : `${label} posting still needs: ${connection.missing.join(", ")}.`,
      payouts: [],
      action: null,
      evidence: null,
    };
  }

  // SPR2: the payout's ID is on the line.
  if (byId.length > 0) {
    const total = sum(byId.map((payout) => dec(payout.net)));
    if (cmp(total, amount) === 0) return settle(byId, "payout_id", label);
    return {
      status: "unmatched",
      platformLabel: label,
      reason: `The line names ${list(byId)}, but it's ${cents(line.amount)}: ${money(add(amount, neg(total)))} different. Check the bank line and the payout in ${label}; nothing is matched on amount alone.`,
      payouts: byId,
      action: null,
      evidence: null,
    };
  }

  // Same amount, inside the timing window, not yet matched to another line.
  const sameAmount = usable.filter((payout) => cmp(dec(payout.net), amount) === 0);
  const open = sameAmount.filter((payout) => !payout.posted?.reconciledLineId);
  if (open.length === 1) {
    // SPR3: the platform's name is on the line too. SPR5: only the amount and date fit: offered, not assumed.
    if (platformNamed) return settle(open, "platform_amount_date", label);
    const guided = settle(open, "amount_date", label);
    if (guided.status !== "matched") return guided;
    return {
      ...guided,
      status: "needs_choice",
      reason: `Only the amount and date fit ${describe(open[0])}: the line doesn't name ${label}. Check it's the payout before matching.`,
    };
  }
  if (open.length > 1) {
    return {
      status: "needs_choice",
      platformLabel: label,
      reason: `${open.length} payouts are ${cents(line.amount)}: ${list(open)}. Choose the one this deposit is; Tohyee won't pick on amount alone.`,
      payouts: open,
      action: null,
      evidence: null,
    };
  }
  // SPR6: only payouts already matched to another line have this amount: a duplicate import.
  if (sameAmount.length > 0) return settle(sameAmount, platformNamed ? "platform_amount_date" : "amount_date", label);

  // SPR7: several payouts in one deposit.
  if (platformNamed) {
    const pool = usable
      .filter((payout) => payout.posted && !payout.posted.reconciledLineId)
      .sort((a, b) => Math.abs(dayNumber(line.date) - dayNumber(a.issuedOn)) - Math.abs(dayNumber(line.date) - dayNumber(b.issuedOn)))
      .slice(0, COMBINATION_POOL);
    const found = combinations(pool, amount);
    if (found.length === 1) return settle(found[0].sort((a, b) => a.issuedOn.localeCompare(b.issuedOn)), "platform_amount_date", label);
    if (found.length > 1) {
      return {
        status: "needs_choice",
        platformLabel: label,
        reason: `More than one set of ${label} payouts adds up to ${cents(line.amount)}. Match the right ones yourself.`,
        payouts: [...new Set(found.flat())],
        action: null,
        evidence: null,
      };
    }
  }

  // Nothing fits. Tell apart missing settlement data (SPR9) from a genuine mismatch (SPR10).
  const connection = intoAccount.find((entry) => entry.postingOn && entry.missing.length === 0) ?? intoAccount[0];
  if (connection.startDate && line.date < connection.startDate) {
    return {
      status: "missing_settlement_data",
      platformLabel: label,
      reason: `This deposit is from before the ${label} start date (${shortDate(connection.startDate)}), so its payout and sales aren't in Tohyee. Code it by hand.`,
      payouts: [],
      action: null,
      evidence: null,
    };
  }
  if (!connection.readsPayouts) {
    return {
      status: "missing_settlement_data",
      platformLabel: label,
      reason: `Tohyee can't read ${label} payouts (the store hasn't given the payout scopes), so it doesn't know this deposit's fees. You can transfer it out of ${connection.clearingAccountName ?? connection.clearingAccountCode}; the fees stay there until you record them.`,
      payouts: [],
      action: connection.clearingAccountCode && platformNamed ? { kind: "transfer", otherAccountCode: connection.clearingAccountCode } : null,
      evidence: null,
    };
  }
  const nearby = usable.filter((payout) => !payout.posted?.reconciledLineId).slice(0, 5);
  return {
    status: "unmatched",
    platformLabel: label,
    reason:
      nearby.length > 0
        ? `No ${label} payout is ${cents(line.amount)} within ${PAYOUT_DAYS_BEFORE} days. Nearby: ${list(nearby)}. Sync the store, or match by hand if you know which it is.`
        : `No ${label} payout is ${cents(line.amount)} within ${PAYOUT_DAYS_BEFORE} days. Sync the store, or code it by hand if it isn't a payout.`,
    payouts: nearby,
    action: null,
    evidence: null,
  };
}

/** The settlement as rows to show, leaving out parts that are nothing (net always shown). */
export function settlementRows(settlement: Settlement): Array<{ label: string; amount: string }> {
  const rows: Array<[string, string]> = [
    ["Gross sales", settlement.grossSales],
    ["Refunds", settlement.refunds],
    ["Fees", settlement.fees],
    ["Adjustments", settlement.adjustments],
    ["Chargebacks", settlement.chargebacks],
    ["Reserves", settlement.reserves],
    ["Other", settlement.other],
  ];
  return [...rows.filter(([, amount]) => !isZero(dec(amount))).map(([label, amount]) => ({ label, amount })), { label: "Net payout", amount: settlement.net }];
}
