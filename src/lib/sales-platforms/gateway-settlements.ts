/**
 * Payment gateway settlements (GS1-GS6, decision 1591; Jess's issue 5). A
 * gateway such as Afterpay pays each order into the bank on its own, less
 * its fee. The order's payment is already in the gateway's clearing account
 * (SPC43), so a deposit is matched to the payments it settles: a transfer
 * from the clearing account for the deposit, and the difference posted from
 * the clearing account to the fees account. Suggested by the gateway's name
 * on the line and the amounts, never by amount alone; a person confirms.
 *
 * The fee has no GST, as Shopify's payout fees (SPC15). That's for Jess to
 * confirm for each gateway.
 */
import { getStatementLine, type StatementLine } from "@/lib/bank/accounts";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { createBankTransaction } from "@/lib/bank/transactions";
import { createContact } from "@/lib/contacts/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, type Decimal, isNegative, isPositive, mul, sub, sum, toFixedString } from "@/lib/money/decimal";
import { requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

const SOURCE = "gateway-settlement";
/** Payments up to this many days before the deposit are looked at. */
export const SETTLEMENT_DAYS_BEFORE = 14;
/** A fee bigger than 10% of what's settled plus 1.00 isn't suggested (GS3). */
const FEE_RATE_LIMIT = "0.10";
const FEE_FIXED_LIMIT = "1.00";
/** At most this many payments in one deposit. */
const MAX_PAYMENTS = 20;

/** A payment is settled while the deposit that settled it is still reconciled (GS6: unmatching the deposit frees it). */
const SETTLED = `select 1 from gateway_settlement_payments sp join gateway_settlements s on s.id = sp.settlement_id
                   join bank_statement_lines b on b.id = s.statement_line_id
                  where sp.customer_payment_id = p.id and b.status = 'reconciled'`;

const money = (value: Decimal | string) => toFixedString(typeof value === "string" ? dec(value) : value, 2);

export type Gateway = {
  connectionId: string;
  method: string;
  title: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  feesAccountCode: string | null;
};

export type SettlementPayment = { paymentId: string; orderName: string | null; date: string; amount: string };

export type SettlementGuidance = {
  status: "matched" | "needs_choice" | "unmatched";
  gateway: { method: string; title: string | null; accountCode: string; accountName: string };
  reason: string;
  /** The payments that fit, one choice each (a single order, or two that make the deposit). */
  choices: Array<{ payments: SettlementPayment[]; settled: string; fee: string }>;
  feesAccountCode: string | null;
  gstNote: string;
};

const GST_NOTE = "The fee is posted with no GST, as payout fees are. Check the gateway's tax invoice if you're not sure.";

/** The gateways of each live connection that have their own clearing account (not Shopify Payments, not left owing). */
export async function listGateways(tx: OrgTx): Promise<Gateway[]> {
  const found = await tx.query<{
    connection_id: string;
    method: string;
    title: string | null;
    account_id: string;
    code: string;
    name: string;
    fees_code: string | null;
  }>(
    `select m.connection_id::text, m.method, m.title, a.id::text as account_id, a.code, a.name, f.code as fees_code
       from sales_platform_payment_methods m
       join sales_platform_connections c on c.id = m.connection_id
       join accounts a on a.id = m.account_id
       left join accounts f on f.id = c.fees_account_id
      where c.status <> 'disconnected' and not m.left_owing and m.account_id is distinct from c.clearing_account_id
      order by m.method`,
  );
  return found.rows.map((row) => ({
    connectionId: row.connection_id,
    method: row.method,
    title: row.title,
    accountId: row.account_id,
    accountCode: row.code,
    accountName: row.name,
    feesAccountCode: row.fees_code,
  }));
}

/** The words that name a gateway on a bank line (GS1): its id and the first word of its title, four letters or more. */
export function gatewayWords(gateway: Pick<Gateway, "method" | "title">): string[] {
  const words = new Set<string>();
  for (const text of [gateway.method.replace(/[_-]+/g, " "), gateway.title ?? ""]) {
    const first = text.trim().toLowerCase().split(/[^a-z0-9]+/)[0] ?? "";
    if (first.length >= 4) words.add(first);
  }
  return [...words];
}

const lineText = (line: Pick<StatementLine, "description" | "payee" | "particulars" | "code" | "reference">) =>
  [line.payee, line.description, line.particulars, line.code, line.reference].filter(Boolean).join(" ").toLowerCase();

/** Whether a fee is one a gateway would charge on what's settled (GS3): more than nothing, at most 10% + 1.00. */
export function plausibleFee(settled: Decimal, deposit: Decimal): boolean {
  const fee = sub(settled, deposit);
  if (!isPositive(fee)) return false;
  return cmp(fee, add(mul(settled, dec(FEE_RATE_LIMIT)), dec(FEE_FIXED_LIMIT))) <= 0;
}

/**
 * The single payments, then pairs, whose total less a plausible fee is the
 * deposit (GS2, GS3). Pairs are looked at only when no single payment fits.
 */
export function settlementChoices(deposit: Decimal, payments: readonly SettlementPayment[]): SettlementGuidance["choices"] {
  const choice = (chosen: SettlementPayment[]) => {
    const settled = sum(chosen.map((payment) => dec(payment.amount)));
    return { payments: chosen, settled: money(settled), fee: money(sub(settled, deposit)) };
  };
  const singles = payments.filter((payment) => plausibleFee(dec(payment.amount), deposit)).map((payment) => choice([payment]));
  if (singles.length > 0) return singles;
  const pairs = [];
  for (let i = 0; i < payments.length; i += 1) {
    for (let j = i + 1; j < payments.length; j += 1) {
      if (plausibleFee(add(dec(payments[i].amount), dec(payments[j].amount)), deposit)) pairs.push(choice([payments[i], payments[j]]));
    }
  }
  return pairs;
}

/** The gateway's payments not yet settled, from `days` before the date to the date. */
async function unsettledPayments(tx: OrgTx, gateway: Gateway, date: string, days = SETTLEMENT_DAYS_BEFORE): Promise<SettlementPayment[]> {
  const found = await tx.query<{ id: string; name: string | null; payment_date: string; amount: string }>(
    `select p.id::text, d.name, p.payment_date::text, p.amount::text
       from customer_payments p
       left join sales_platform_documents d on d.customer_payment_id = p.id and d.record_kind = 'order'
      where p.bank_account_id = $1 and p.status = 'active'
        and p.payment_date between ($2::date - $3::int) and $2::date
        and not exists (${SETTLED})
      order by p.payment_date, p.id
      limit 200`,
    [gateway.accountId, date, days],
  );
  return found.rows.map((row) => ({ paymentId: row.id, orderName: row.name, date: row.payment_date, amount: money(row.amount) }));
}

/**
 * What a deposit is, as far as gateway settlements go (GS1-GS3), or null
 * when the line doesn't name a gateway with its own clearing account.
 * Read-only.
 */
export async function settlementGuidanceForLine(tx: OrgTx, lineIdInput: unknown): Promise<SettlementGuidance | null> {
  const line = await getStatementLine(tx, lineIdInput);
  if (line.status !== "unreconciled" || !isPositive(dec(line.amount))) return null;
  const text = lineText(line);
  const gateway = (await listGateways(tx)).find((candidate) => candidate.accountId !== line.accountId && gatewayWords(candidate).some((word) => text.includes(word)));
  if (!gateway) return null;
  const deposit = dec(line.amount);
  const choices = settlementChoices(deposit, await unsettledPayments(tx, gateway, line.date));
  const label = gateway.title ?? gateway.method;
  const base = {
    gateway: { method: gateway.method, title: gateway.title, accountCode: gateway.accountCode, accountName: gateway.accountName },
    choices,
    feesAccountCode: gateway.feesAccountCode,
    gstNote: GST_NOTE,
  };
  if (choices.length === 0) {
    return {
      ...base,
      status: "unmatched",
      reason: `This looks like a ${label} deposit, but no ${label} payment in ${gateway.accountCode} from the ${SETTLEMENT_DAYS_BEFORE} days before comes to ${money(deposit)} less a fee.`,
    };
  }
  if (choices.length > 1) {
    return { ...base, status: "needs_choice", reason: `${choices.length} ${label} payments in ${gateway.accountCode} could be this deposit. Choose which.` };
  }
  const only = choices[0];
  const what = only.payments.map((payment) => payment.orderName ?? `payment ${payment.paymentId}`).join(" and ");
  return { ...base, status: "matched", reason: `${label} settling ${what} (${only.settled}), less a fee of ${only.fee}.` };
}

/** The contact for the gateway's fees: an existing one with its name, else one added. */
async function gatewayContact(tx: OrgTx, gateway: Gateway): Promise<string> {
  const name = (gateway.title ?? gateway.method).slice(0, 200);
  const found = await tx.query<{ id: string }>("select id from contacts where not is_archived and lower(name) = lower($1) order by id limit 1", [name]);
  if (found.rows[0]) return found.rows[0].id;
  const { contact } = await createContact(tx, { idempotencyKey: `gs-contact-${gateway.connectionId}-${gateway.method}`.slice(0, 120), source: SOURCE, name, isSupplier: true });
  return contact.id;
}

export type SettleResult = { settlementId: string; lineId: string; transferJournalId: string | null; feeTransactionId: string | null; settled: string; fee: string };

/**
 * GS4: settles a deposit. The line is reconciled with a transfer from the
 * gateway's clearing account for the deposit, the difference is spent from
 * the clearing account to the fees account (no GST), and the payments are
 * marked settled so they aren't suggested again. Safe to send twice with
 * the same key.
 */
export async function settleGatewayDeposit(
  tx: OrgTx,
  lineIdInput: unknown,
  command: { paymentIds: unknown; feesAccountCode?: unknown; idempotencyKey: unknown },
): Promise<SettleResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const earlier = await tx.query<{ id: string; statement_line_id: string; fee_transaction_id: string | null; settled: string; fee: string }>(
    "select id::text, statement_line_id::text, fee_transaction_id::text, settled::text, fee::text from gateway_settlements where idempotency_key = $1",
    [idempotencyKey],
  );
  if (earlier.rows[0]) {
    const row = earlier.rows[0];
    if (row.statement_line_id !== lineId) throw new ConflictError("That key was already used to settle another line.");
    const line = await getStatementLine(tx, lineId);
    return {
      settlementId: row.id,
      lineId,
      transferJournalId: line.reconciliation?.items[0]?.journalId ?? null,
      feeTransactionId: row.fee_transaction_id,
      settled: money(row.settled),
      fee: money(row.fee),
    };
  }
  const ids = [...new Set(requireArray(command.paymentIds, "paymentIds", MAX_PAYMENTS).map((id, index) => requireId(id, `paymentIds[${index}]`)))];
  if (ids.length === 0) throw new ValidationError("Choose at least one payment the deposit settles.");
  const line = await getStatementLine(tx, lineId);
  if (line.status !== "unreconciled") throw new ConflictError("That line is already reconciled.");
  const deposit = dec(line.amount);
  if (!isPositive(deposit)) throw new ValidationError("Only money in can be a gateway settlement.");

  const payments = await tx.query<{ id: string; account_id: string; amount: string; status: string; settled: boolean }>(
    `select p.id::text, p.bank_account_id::text as account_id, p.amount::text, p.status,
            exists (${SETTLED}) as settled
       from customer_payments p where p.id = any($1::bigint[]) for update`,
    [ids],
  );
  if (payments.rows.length !== ids.length) throw new ValidationError("One of those payments wasn't found.");
  if (payments.rows.some((row) => row.status !== "active")) throw new ValidationError("One of those payments is voided.");
  if (payments.rows.some((row) => row.settled)) throw new ConflictError("One of those payments is already settled by another deposit.");
  const accounts = new Set(payments.rows.map((row) => row.account_id));
  if (accounts.size !== 1) throw new ValidationError("The payments must all be in the same gateway's clearing account.");
  const gateway = (await listGateways(tx)).find((candidate) => candidate.accountId === [...accounts][0]);
  if (!gateway) throw new ValidationError("Those payments aren't in a payment gateway's clearing account.");
  if (gateway.accountId === line.accountId) throw new ValidationError("The deposit is on the gateway's own clearing account.");

  const settled = sum(payments.rows.map((row) => dec(row.amount)));
  const fee = sub(settled, deposit);
  if (isNegative(fee)) throw new ValidationError(`The deposit (${money(deposit)}) is more than the payments it settles (${money(settled)}).`);
  const feesAccountCode = command.feesAccountCode === undefined || command.feesAccountCode === null ? gateway.feesAccountCode : String(command.feesAccountCode);
  if (isPositive(fee) && !feesAccountCode) throw new ValidationError("Choose a fees account for the difference (the store's fees account isn't set).");

  const label = gateway.title ?? gateway.method;
  const reference = `${label} settlement`.slice(0, 100);
  const reconciled = await reconcileStatementLine(tx, lineId, {
    source: SOURCE,
    idempotencyKey: `${idempotencyKey}:transfer`.slice(0, 200),
    kind: "transfer",
    otherAccountCode: gateway.accountCode,
    reference,
  });
  let feeTransactionId: string | null = null;
  if (isPositive(fee)) {
    const { bankTransaction } = await createBankTransaction(tx, {
      source: SOURCE,
      idempotencyKey: `${idempotencyKey}:fee`.slice(0, 200),
      kind: "spend",
      accountId: gateway.accountId,
      contactId: await gatewayContact(tx, gateway),
      date: line.date,
      reference,
      amountsMode: "no_tax",
      lines: [{ description: `${label} fee`, accountCode: feesAccountCode!, taxCode: null, amount: money(fee) }],
    });
    feeTransactionId = bankTransaction.id;
  }
  const saved = await tx.query<{ id: string }>(
    `insert into gateway_settlements (idempotency_key, statement_line_id, clearing_account_id, method, settled, fee, fee_transaction_id, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $8) returning id::text`,
    [idempotencyKey, lineId, gateway.accountId, gateway.method, money(settled), money(fee), feeTransactionId, tx.actor.email ?? null],
  );
  for (const id of ids) {
    await tx.query("insert into gateway_settlement_payments (settlement_id, customer_payment_id) values ($1, $2)", [saved.rows[0].id, id]);
  }
  return {
    settlementId: saved.rows[0].id,
    lineId,
    transferJournalId: reconciled.line.reconciliation?.items[0]?.journalId ?? null,
    feeTransactionId,
    settled: money(settled),
    fee: money(fee),
  };
}
