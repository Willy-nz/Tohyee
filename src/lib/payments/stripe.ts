import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { writeAuditEvent } from "@/lib/audit";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import {
  createPaymentLink,
  deactivatePaymentLink,
  listCompletedSessions,
  type StripeBalanceTransaction,
  type StripeCheckoutSession,
  stripeProblem,
} from "@/lib/bank/stripe/client";
import { fromMinorUnits } from "@/lib/bank/stripe/service";
import { businessTimeZone } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { recordPayment } from "@/lib/invoices/payments";
import { getInvoice } from "@/lib/invoices/service";
import { CURRENCY_MINOR_UNITS, currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, divide, mul, sub, toFixedString, toPlainString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { decryptSecret, secretsAvailable } from "@/lib/secrets";
import { requireId } from "@/lib/validation";

/**
 * Online invoice payments with Stripe (PN1-PN12, decisions 414-419). An
 * approved invoice with something due gets a Stripe payment link for that
 * amount when it's emailed, printed or copied; every 15 minutes (and with
 * Check now) Tohyee asks Stripe for each link's completed checkout sessions
 * and records each paid one as a customer payment into the bank account
 * linked to the Stripe balance the money went to. Links whose amount no
 * longer matches are switched off. Network calls happen between short
 * database transactions, never inside one. Tohyee never refunds or charges.
 */

export const CHECK_MINUTES = 15;
/** Closed links are still looked at for this long, for a payment made just before they closed (PN6). */
const RECHECK_CLOSED_HOURS = 48;
const MAX_NOTICE = 1000;

export type OnlinePayment = {
  id: string;
  provider: "stripe" | "paypal";
  sessionId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  providerPaymentId: string | null;
  currencyCode: string;
  amount: string;
  paidDate: string;
  status: "recorded" | "notice";
  paymentId: string | null;
  notice: string | null;
  waitingForLink: boolean;
  createdAt: string;
};

export type OnlinePaymentStatus = {
  enabled: boolean;
  stripeConnected: boolean;
  liveMode: boolean;
  lastCheckAt: string | null;
  lastCheckStatus: "ok" | "failed" | null;
  lastCheckError: string | null;
  updatedByEmail: string | null;
  /** Payments that need a person (PN10, a missing balance link), not dismissed. */
  notices: OnlinePayment[];
};

export type InvoicePayNow = {
  /** Online payments are on and Stripe is connected. */
  available: boolean;
  /** This invoice offers Pay now (not left off, approved, something due). */
  offered: boolean;
  /** Left off on this invoice (question 5). */
  payNow: boolean;
  reason: string | null;
  link: { url: string; amount: string; currencyCode: string; createdAt: string } | null;
  payments: OnlinePayment[];
};

type SettingsRow = {
  enabled: boolean;
  last_check_at: string | null;
  last_check_status: "ok" | "failed" | null;
  last_check_error: string | null;
  lease_until: string | null;
  updated_by_email: string | null;
};

export type PaymentRow = {
  id: string;
  provider: "stripe" | "paypal";
  session_id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  provider_payment_id: string | null;
  currency_code: string;
  amount: string;
  paid_date: string;
  status: "recorded" | "notice";
  payment_id: string | null;
  notice: string | null;
  waiting_for_link: boolean;
  created_at: string;
};

export const PAYMENT_SELECT = `
  select p.id::text, p.provider, p.session_id, p.invoice_id::text, i.invoice_number, p.provider_payment_id, p.currency_code, p.amount::text,
         p.paid_date::text, p.status, p.payment_id::text, p.notice, p.waiting_for_link, p.created_at
    from online_payments p left join sales_invoices i on i.id = p.invoice_id`;

export function toPayment(row: PaymentRow): OnlinePayment {
  return {
    id: row.id,
    provider: row.provider,
    sessionId: row.session_id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    providerPaymentId: row.provider_payment_id,
    currencyCode: row.currency_code,
    amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
    paidDate: row.paid_date,
    status: row.status,
    paymentId: row.payment_id,
    notice: row.notice,
    waitingForLink: row.waiting_for_link,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function settingsRow(tx: OrgTx, lock = false): Promise<SettingsRow | null> {
  const found = await tx.query<SettingsRow>(
    `select enabled, last_check_at, last_check_status, last_check_error, lease_until, updated_by_email
       from online_payment_settings where provider = 'stripe' ${lock ? "for update" : ""}`,
  );
  return found.rows[0] ?? null;
}

async function stripeConnection(tx: OrgTx): Promise<{ id: string; key: string | null; liveMode: boolean } | null> {
  const found = await tx.query<{ id: string; api_key_ciphertext: string; live_mode: boolean }>(
    // With several Stripe logins (#182), online payments use the first one connected.
    "select id::text, api_key_ciphertext, live_mode from stripe_connections where status = 'active' order by stripe_connections.id limit 1",
  );
  const row = found.rows[0];
  if (!row) return null;
  return { id: row.id, key: secretsAvailable() ? decryptSecret(row.api_key_ciphertext) : null, liveMode: row.live_mode };
}

export async function getOnlinePaymentStatus(tx: OrgTx): Promise<OnlinePaymentStatus> {
  const row = await settingsRow(tx);
  const connection = await stripeConnection(tx);
  const notices = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.status = 'notice' and p.dismissed_at is null order by p.id desc limit 100`);
  return {
    enabled: row?.enabled ?? false,
    stripeConnected: connection !== null,
    liveMode: connection?.liveMode ?? true,
    lastCheckAt: row?.last_check_at ? new Date(row.last_check_at).toISOString() : null,
    lastCheckStatus: row?.last_check_status ?? null,
    lastCheckError: row?.last_check_error ?? null,
    updatedByEmail: row?.updated_by_email ?? null,
    notices: notices.rows.map(toPayment),
  };
}

/** Turns Pay now with Stripe on (PN1). Admins. Needs a Stripe connection. */
export async function enableOnlinePayments(tx: OrgTx): Promise<OnlinePaymentStatus> {
  if (!(await stripeConnection(tx))) throw new ValidationError("Connect Stripe first (Bank accounts, Stripe).");
  await tx.query(
    `insert into online_payment_settings (provider, enabled, updated_by_email) values ('stripe', true, $1)
     on conflict (provider) do update set enabled = true, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "online_payments.enabled", entityType: "online_payment_settings", entityId: "stripe", details: { provider: "stripe" } });
  return getOnlinePaymentStatus(tx);
}

export type LinkRow = {
  id: string;
  invoice_id: string;
  provider_link_id: string;
  url: string;
  currency_code: string;
  amount: string;
  status: "open" | "closed";
  created_at: string;
};

export const LINK_COLUMNS = "id::text, invoice_id::text, provider_link_id, url, currency_code, amount::text, status, created_at";

/**
 * Switches off every open link (PN11), for turning payments off or
 * disconnecting Stripe. Returns the links Stripe couldn't be reached for;
 * those are closed in Tohyee anyway, and listed so a person can switch them
 * off in Stripe's dashboard.
 */
export async function closeAllPaymentLinks(organisation: OrganisationRecord, actor: Actor, reason: string): Promise<{ closed: number; failed: string[] }> {
  const { links, key } = await withOrganisationTransaction(organisation, actor, async (tx) => ({
    links: (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from invoice_payment_links where provider = 'stripe' and status = 'open' order by id`)).rows,
    key: (await stripeConnection(tx))?.key ?? null,
  }));
  const failed: string[] = [];
  for (const link of links) {
    try {
      if (!key) throw new Error("no key");
      await deactivatePaymentLink(key, link.provider_link_id);
    } catch {
      failed.push(link.url);
    }
    await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, link.id, reason));
  }
  return { closed: links.length, failed };
}

/** Turns Pay now off (PN11): open links are switched off first. Admins. */
export async function disableOnlinePayments(organisation: OrganisationRecord, actor: Actor): Promise<{ status: OnlinePaymentStatus; failed: string[] }> {
  const { failed } = await closeAllPaymentLinks(organisation, actor, "Online payments turned off");
  const status = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      `insert into online_payment_settings (provider, enabled, updated_by_email) values ('stripe', false, $1)
       on conflict (provider) do update set enabled = false, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [tx.actor.email],
    );
    await writeAuditEvent(tx, {
      eventType: "online_payments.disabled",
      entityType: "online_payment_settings",
      entityId: "stripe",
      details: { provider: "stripe", linksNotSwitchedOff: failed.length },
    });
    return getOnlinePaymentStatus(tx);
  });
  return { status, failed };
}

export async function closeLink(tx: OrgTx, linkId: string, reason: string): Promise<void> {
  const closed = await tx.query<{ invoice_id: string; url: string }>(
    `update invoice_payment_links set status = 'closed', closed_reason = $2, closed_at = now() where id = $1 and status = 'open'
     returning invoice_id::text, url`,
    [linkId, reason.slice(0, 200)],
  );
  if (closed.rows[0]) {
    await writeAuditEvent(tx, {
      eventType: "invoice.payment_link_closed",
      entityType: "sales_invoice",
      entityId: closed.rows[0].invoice_id,
      details: { url: closed.rows[0].url, reason },
    });
  }
}

/** Whether an invoice may offer Pay now, and why not (PN2, question 5). */
async function payNowState(
  tx: OrgTx,
  invoiceId: string,
): Promise<{ invoice: Awaited<ReturnType<typeof getInvoice>>; available: boolean; payNow: boolean; offered: boolean; reason: string | null }> {
  const invoice = await getInvoice(tx, invoiceId);
  const settings = await settingsRow(tx);
  const connection = await stripeConnection(tx);
  const option = await tx.query<{ pay_now: boolean }>("select pay_now from invoice_payment_options where invoice_id = $1", [invoice.id]);
  const payNow = option.rows[0]?.pay_now ?? true;
  const available = Boolean(settings?.enabled) && connection !== null;
  const reason = !settings?.enabled
    ? "Pay now with Stripe is off (Settings, Online payments)."
    : !connection
      ? "Stripe isn't connected."
      : !payNow
        ? "Pay now is left off on this invoice."
        : invoice.status !== "approved"
          ? invoice.status === "draft"
            ? "Approve the invoice first."
            : "The invoice is voided."
          : !invoice.amountDue || cmp(dec(invoice.amountDue), dec("0")) <= 0
            ? "Nothing is due."
            : !(invoice.currencyCode in CURRENCY_MINOR_UNITS)
              ? `Stripe payments in ${invoice.currencyCode} aren't supported.`
              : null;
  return { invoice, available, payNow, offered: reason === null, reason };
}

async function openLink(tx: OrgTx, invoiceId: string): Promise<LinkRow | null> {
  return (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from invoice_payment_links where provider = 'stripe' and invoice_id = $1 and status = 'open'`, [invoiceId])).rows[0] ?? null;
}

export function linkMatches(link: LinkRow, invoice: { currencyCode: string; amountDue: string | null }): boolean {
  return link.currency_code === invoice.currencyCode && invoice.amountDue !== null && cmp(dec(link.amount), dec(invoice.amountDue)) === 0;
}

/** The open link's URL if it's still right for the invoice (printed on the PDF and in emails). */
export async function currentPaymentLinkUrl(tx: OrgTx, invoiceIdInput: unknown): Promise<string | null> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const state = await payNowState(tx, invoiceId);
  if (!state.offered) return null;
  const link = await openLink(tx, invoiceId);
  return link && linkMatches(link, state.invoice) ? link.url : null;
}

/** An invoice's Pay now: whether it's offered, its link and its online payments (PN12). */
export async function getInvoicePayNow(tx: OrgTx, invoiceIdInput: unknown): Promise<InvoicePayNow> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const state = await payNowState(tx, invoiceId);
  const link = await openLink(tx, invoiceId);
  const payments = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.invoice_id = $1 order by p.id`, [invoiceId]);
  return {
    available: state.available,
    offered: state.offered,
    payNow: state.payNow,
    reason: state.reason,
    link:
      state.offered && link && linkMatches(link, state.invoice)
        ? { url: link.url, amount: toFixedString(dec(link.amount), currencyMinorUnits(link.currency_code)), currencyCode: link.currency_code, createdAt: new Date(link.created_at).toISOString() }
        : null,
    payments: payments.rows.map(toPayment),
  };
}

/** Leaves Pay now off on one invoice, or puts it back (question 5). Bookkeepers. The link closes at the next check. */
export async function setInvoicePayNow(tx: OrgTx, invoiceIdInput: unknown, input: { payNow?: unknown }): Promise<InvoicePayNow> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  if (typeof input.payNow !== "boolean") throw new ValidationError("payNow must be true or false.");
  await getInvoice(tx, invoiceId);
  await tx.query(
    `insert into invoice_payment_options (invoice_id, pay_now, updated_by_email) values ($1, $2, $3)
     on conflict (invoice_id) do update set pay_now = excluded.pay_now, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [invoiceId, input.payNow, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: input.payNow ? "invoice.pay_now_on" : "invoice.pay_now_off", entityType: "sales_invoice", entityId: invoiceId });
  return getInvoicePayNow(tx, invoiceId);
}

/** Whole smallest units (cents) of an amount, exactly. */
function toMinorUnits(amount: string, currency: string): number {
  const places = CURRENCY_MINOR_UNITS[currency] ?? 2;
  return Number(toPlainString(mul(dec(amount), dec(`1${"0".repeat(places)}`))));
}

/**
 * The invoice's payment link (PN2, PN5): the open one when it's still for
 * the amount due; otherwise the old one is switched off and a new one made.
 * Returns null when the invoice doesn't offer Pay now. Bookkeepers, when an
 * invoice is emailed, printed or copied.
 */
export async function ensurePaymentLink(organisation: OrganisationRecord, actor: Actor, invoiceIdInput: unknown): Promise<string | null> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const before = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const state = await payNowState(tx, invoiceId);
    const link = await openLink(tx, invoiceId);
    const count = Number((await tx.query<{ n: string }>("select count(*)::text as n from invoice_payment_links where provider = 'stripe' and invoice_id = $1", [invoiceId])).rows[0].n);
    const settings = await getOrganisationSettings(tx);
    return { state, link, count, organisationName: settings.displayName, key: (await stripeConnection(tx))?.key ?? null };
  });
  const { state, link } = before;
  if (!state.offered) return null;
  if (link && linkMatches(link, state.invoice)) return link.url;
  if (!before.key) throw new ValidationError("The Stripe key can't be read on this server (is TOHYEE_SECRET_KEY set?).");
  if (link) {
    // PN5: the amount due changed. A payment made on the old link before now is still found by the check (closed links are rechecked).
    try {
      await deactivatePaymentLink(before.key, link.provider_link_id);
    } catch (error) {
      throw stripeProblem(error);
    }
    await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, link.id, "The amount due changed"));
  }
  const invoice = state.invoice;
  const amountMinor = toMinorUnits(invoice.amountDue!, invoice.currencyCode);
  let created;
  try {
    created = await createPaymentLink(before.key, {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber ?? `#${invoiceId}`,
      currency: invoice.currencyCode,
      amountMinor,
      inactiveMessage: `This invoice has been paid or has changed. Use the latest link from ${before.organisationName}.`,
      // The same request for the same invoice, amount and turn gives the same link (Stripe keeps keys for 24 hours).
      idempotencyKey: `tohyee-${organisation.id}-invoice-${invoiceId}-${invoice.currencyCode}-${amountMinor}-${before.count + 1}`,
    });
  } catch (error) {
    throw stripeProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into invoice_payment_links (invoice_id, provider_link_id, url, currency_code, amount, created_by_email)
       values ($1, $2, $3, $4, $5::numeric, $6)
       on conflict do nothing returning id::text`,
      [invoiceId, created.id, created.url, invoice.currencyCode, invoice.amountDue, tx.actor.email],
    );
    if (!inserted.rows[0]) {
      // Made by another request at the same moment: use whichever is open.
      const open = await openLink(tx, invoiceId);
      if (open) return open.url;
      throw new ConflictError("The payment link is being made by another request. Try again.");
    }
    await writeAuditEvent(tx, {
      eventType: "invoice.payment_link_created",
      entityType: "sales_invoice",
      entityId: invoiceId,
      details: { url: created.url, amount: invoice.amountDue, currencyCode: invoice.currencyCode },
    });
    return created.url;
  });
}

/** Best-effort: the invoice's link, for emails and printing; a Stripe problem doesn't stop them (the link is left out). */
export async function tryEnsurePaymentLink(organisation: OrganisationRecord, actor: Actor, invoiceId: unknown): Promise<void> {
  try {
    await ensurePaymentLink(organisation, actor, invoiceId);
  } catch (error) {
    if (!(error instanceof HttpError)) console.warn("[tohyee] Payment link:", error);
  }
}

/**
 * Switches an invoice's link off straight away when it's no longer right
 * (voided, paid, a payment recorded): best effort, after the change is
 * saved; the next check does it otherwise.
 */
export async function refreshInvoicePaymentLink(organisation: OrganisationRecord, actor: Actor, invoiceIdInput: unknown): Promise<void> {
  try {
    const invoiceId = requireId(invoiceIdInput, "invoiceId");
    const found = await withOrganisationTransaction(organisation, actor, async (tx) => {
      const link = await openLink(tx, invoiceId);
      if (!link) return null;
      const state = await payNowState(tx, invoiceId);
      const reason = !state.offered ? (state.reason ?? "No longer offered") : !linkMatches(link, state.invoice) ? "The amount due changed" : null;
      return reason ? { link, reason, key: (await stripeConnection(tx))?.key ?? null } : null;
    });
    if (!found?.key) return;
    await deactivatePaymentLink(found.key, found.link.provider_link_id);
    await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, found.link.id, found.reason));
  } catch (error) {
    if (!(error instanceof HttpError)) console.warn("[tohyee] Payment link:", error);
  }
}

// ---------------------------------------------------------------- checking

export function dateIn(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
}

type Settled = { paymentId: string | null; created: number; transaction: StripeBalanceTransaction | null };

/** The payment, its charge and the charge's balance transaction from an expanded session. */
function settledOf(session: StripeCheckoutSession): Settled {
  const intent = typeof session.payment_intent === "object" && session.payment_intent ? session.payment_intent : null;
  const charge = intent && typeof intent.latest_charge === "object" && intent.latest_charge ? intent.latest_charge : null;
  const transaction = charge && typeof charge.balance_transaction === "object" && charge.balance_transaction ? charge.balance_transaction : null;
  return {
    paymentId: intent?.id ?? (typeof session.payment_intent === "string" ? session.payment_intent : null),
    created: transaction?.created ?? charge?.created ?? session.created ?? Math.floor(Date.now() / 1000),
    transaction,
  };
}

/**
 * The rate (base per 1 unit of the invoice's currency, at most 8 decimal
 * places) that turns `amount` into exactly `settled` when rounded to cents
 * (PN7), so the payment and Stripe's feed line agree.
 */
const RATE_STEP = dec("0.00000001");

export function exactRate(amount: string, settled: string, baseScale: number): string {
  let rate = divide(dec(settled), dec(amount), 8);
  for (let step = 0; step < 1000; step += 1) {
    const converted = toFixedString(mul(dec(amount), rate), baseScale);
    const difference = cmp(dec(converted), dec(settled));
    if (difference === 0) return toPlainString(rate);
    rate = difference < 0 ? add(rate, RATE_STEP) : sub(rate, RATE_STEP);
  }
  return toPlainString(divide(dec(settled), dec(amount), 8));
}

export type Recordable = {
  provider: "stripe" | "paypal";
  sessionId: string;
  linkId: string | null;
  invoiceId: string;
  providerPaymentId: string | null;
  currencyCode: string;
  amount: string;
  paidDate: string;
  settledCurrency: string | null;
  settledAmount: string | null;
};

/**
 * Records one paid session (PN3, PN6, PN7, PN10) in its own transaction:
 * a customer payment into the account linked to the balance it went to, or
 * a notice for a person. Returns what happened.
 */
export async function recordSession(organisation: OrganisationRecord, actor: Actor, item: Recordable, existingId: string | null): Promise<"recorded" | "notice" | "waiting"> {
  const provider = PROVIDERS[item.provider];
  const notice = async (text: string, waitingForLink = false) => {
    await withOrganisationTransaction(organisation, actor, async (tx) => {
      if (existingId) {
        await tx.query("update online_payments set notice = $2, waiting_for_link = $3, updated_at = now() where id = $1", [existingId, text.slice(0, MAX_NOTICE), waitingForLink]);
        return;
      }
      await tx.query(
        `insert into online_payments (session_id, link_id, invoice_id, provider_payment_id, currency_code, amount, paid_date, settled_currency,
                                      settled_amount, waiting_for_link, status, notice, provider)
         values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::numeric, $10, 'notice', $11, $12) on conflict (session_id) do nothing`,
        [
          item.sessionId,
          item.linkId,
          item.invoiceId,
          item.providerPaymentId,
          item.currencyCode,
          item.amount,
          item.paidDate,
          item.settledCurrency,
          item.settledAmount,
          waitingForLink,
          text.slice(0, MAX_NOTICE),
          item.provider,
        ],
      );
      await writeAuditEvent(tx, {
        eventType: "invoice.online_payment_notice",
        entityType: "sales_invoice",
        entityId: item.invoiceId,
        details: { sessionId: item.sessionId, amount: item.amount, currencyCode: item.currencyCode, notice: text },
      });
    });
    return waitingForLink ? ("waiting" as const) : ("notice" as const);
  };
  try {
    return await withOrganisationTransaction(organisation, actor, async (tx) => {
      const invoiceRow = await tx.query<{ status: string; invoice_number: string | null; currency_code: string }>(
        "select status, invoice_number, currency_code from sales_invoices where id = $1",
        [item.invoiceId],
      );
      const found = invoiceRow.rows[0];
      const label = found?.invoice_number ?? `invoice #${item.invoiceId}`;
      const money = `${item.currencyCode} ${toFixedString(dec(item.amount), currencyMinorUnits(item.currencyCode))}`;
      if (!found || found.status !== "approved") {
        throw new NoticeOnly(
          `A ${provider.name} payment of ${money} arrived for ${label}, which is ${found ? found.status : "deleted"}. Refund it in ${provider.name}, or record it as a payment or overpayment by hand.`,
        );
      }
      const settledCurrency = item.settledCurrency ?? item.currencyCode;
      const settledAmount = item.settledAmount ?? item.amount;
      const linked = await tx.query<{ code: string }>(
        `select a.code from ${provider.linksTable} l join accounts a on a.id = l.account_id
          where l.active and l.currency_code = $1
            and l.connection_id = (select c.id from ${provider.connectionsTable} c where c.status = 'active' order by c.id limit 1)`,
        [settledCurrency],
      );
      const bank = linked.rows[0]?.code;
      if (!bank) {
        throw new NoticeOnly(`A ${provider.name} payment for ${label} (${money}) arrived, but no bank account is linked to ${provider.name}'s ${settledCurrency} balance.`, true);
      }
      let exchangeRate: string | undefined;
      if (settledCurrency !== found.currency_code) {
        if (settledCurrency !== tx.baseCurrency) {
          throw new NoticeOnly(
            `A ${provider.name} payment for ${label} (${money}) went to ${provider.name}'s ${settledCurrency} balance, which isn't the invoice's currency or ${tx.baseCurrency}. Record it by hand.`,
          );
        }
        exchangeRate = exactRate(item.amount, settledAmount, currencyMinorUnits(tx.baseCurrency));
      }
      const result = await recordPayment(tx, item.invoiceId, {
        source: item.provider,
        idempotencyKey: `${item.provider}-${item.sessionId}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120),
        paymentDate: item.paidDate,
        amount: item.amount,
        bankAccountCode: bank,
        reference: `${provider.name} ${item.providerPaymentId ?? item.sessionId}`.slice(0, 100),
        ...(exchangeRate ? { exchangeRate } : {}),
      });
      const overpaid = cmp(dec(result.payment.overpaymentAmount), dec("0")) > 0;
      const extra = overpaid
        ? `Paid twice: ${result.payment.overpaymentAmount} is credit on ${result.payment.contactName}'s account, to apply to another invoice or refund.`
        : null;
      const values = [
        item.sessionId,
        item.linkId,
        item.invoiceId,
        item.providerPaymentId,
        item.currencyCode,
        item.amount,
        item.paidDate,
        item.settledCurrency,
        item.settledAmount,
        result.payment.id,
        extra,
      ];
      if (existingId) {
        await tx.query(
          "update online_payments set status = 'recorded', payment_id = $2, notice = $3, waiting_for_link = false, updated_at = now() where id = $1",
          [existingId, result.payment.id, extra],
        );
      } else {
        await tx.query(
          `insert into online_payments (session_id, link_id, invoice_id, provider_payment_id, currency_code, amount, paid_date, settled_currency,
                                        settled_amount, status, payment_id, notice, provider)
           values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::numeric, 'recorded', $10, $11, $12)`,
          [...values, item.provider],
        );
      }
      await writeAuditEvent(tx, {
        eventType: "invoice.paid_online",
        entityType: "sales_invoice",
        entityId: item.invoiceId,
        details: { provider: item.provider, amount: item.amount, currencyCode: item.currencyCode, paymentDate: item.paidDate, paymentId: result.payment.id, overpaid },
      });
      return "recorded" as const;
    });
  } catch (error) {
    if (error instanceof NoticeOnly) return notice(error.message, error.waitingForLink);
    if (error instanceof HttpError) return notice(`A ${provider.name} payment of ${item.currencyCode} ${toFixedString(dec(item.amount), currencyMinorUnits(item.currencyCode))} couldn't be recorded: ${error.message}`);
    throw error;
  }
}

/** What differs between the providers when a payment is recorded. */
const PROVIDERS = {
  // Online payments use each provider's first login (#182).
  stripe: { name: "Stripe", linksTable: "stripe_links", connectionsTable: "stripe_connections" },
  paypal: { name: "PayPal", linksTable: "paypal_links", connectionsTable: "paypal_connections" },
} as const;

class NoticeOnly extends Error {
  constructor(
    message: string,
    readonly waitingForLink = false,
  ) {
    super(message);
  }
}

export type OnlinePaymentCheck = { status: "ok" | "failed"; recorded: number; notices: number; linksClosed: number; error: string | null };

/**
 * Checks Stripe now (PN3, Check now, the schedule): each open link's (and
 * each recently closed link's) completed sessions are recorded once; notices
 * waiting for a balance link are tried again; then links that are no longer
 * right (paid, changed, voided, left off) are switched off.
 */
export async function checkOnlinePayments(organisation: OrganisationRecord, actor: Actor, now = new Date()): Promise<OnlinePaymentCheck> {
  const start = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const row = await settingsRow(tx, true);
    if (!row) throw new NotFoundError("Online payments haven't been turned on.");
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("Stripe payments are already being checked.");
    await tx.query("update online_payment_settings set lease_until = now() + interval '10 minutes' where provider = 'stripe'");
    const links = await tx.query<LinkRow>(
      `select ${LINK_COLUMNS} from invoice_payment_links
        where provider = 'stripe' and (status = 'open' or closed_at > $1::timestamptz - make_interval(hours => ${RECHECK_CLOSED_HOURS})) order by id`,
      [now.toISOString()],
    );
    const seen = await tx.query<{ id: string; session_id: string; status: string; waiting_for_link: boolean }>(
      "select id::text, session_id, status, waiting_for_link from online_payments where provider = 'stripe'",
    );
    const waiting = await tx.query<{
      id: string;
      session_id: string;
      link_id: string | null;
      invoice_id: string | null;
      provider_payment_id: string | null;
      currency_code: string;
      amount: string;
      paid_date: string;
      settled_currency: string | null;
      settled_amount: string | null;
    }>(
      `select id::text, session_id, link_id::text, invoice_id::text, provider_payment_id, currency_code, amount::text, paid_date::text,
              settled_currency, settled_amount::text
         from online_payments where provider = 'stripe' and status = 'notice' and waiting_for_link and dismissed_at is null`,
    );
    return { links: links.rows, seen: seen.rows, waiting: waiting.rows, key: (await stripeConnection(tx))?.key ?? null, enabled: row.enabled };
  });
  let recorded = 0;
  let notices = 0;
  let linksClosed = 0;
  let error: string | null = null;
  try {
    if (!start.key) throw new ValidationError("Stripe isn't connected, or its key can't be read on this server.");
    const timeZone = businessTimeZone();
    const known = new Map(start.seen.map((row) => [row.session_id, row]));
    const count = (outcome: "recorded" | "notice" | "waiting") => {
      if (outcome === "recorded") recorded += 1;
      else notices += 1;
    };
    for (const row of start.waiting) {
      if (!row.invoice_id) continue;
      count(
        await recordSession(
          organisation,
          actor,
          {
            provider: "stripe",
            sessionId: row.session_id,
            linkId: row.link_id,
            invoiceId: row.invoice_id,
            providerPaymentId: row.provider_payment_id,
            currencyCode: row.currency_code,
            amount: toPlainString(dec(row.amount)),
            paidDate: row.paid_date,
            settledCurrency: row.settled_currency,
            settledAmount: row.settled_amount === null ? null : toPlainString(dec(row.settled_amount)),
          },
          row.id,
        ),
      );
    }
    for (const link of start.links) {
      let sessions: StripeCheckoutSession[];
      try {
        sessions = await listCompletedSessions(start.key, link.provider_link_id);
      } catch (caught) {
        throw stripeProblem(caught);
      }
      for (const session of sessions) {
        if (known.has(session.id)) continue;
        // A bank debit completes before it's paid; it's recorded once Stripe says it's paid.
        if (session.payment_status !== "paid") continue;
        if (typeof session.amount_total !== "number" || !session.currency) continue;
        const settled = settledOf(session);
        const currency = session.currency.toUpperCase();
        const item: Recordable = {
          provider: "stripe",
          sessionId: session.id,
          linkId: link.id,
          invoiceId: link.invoice_id,
          providerPaymentId: settled.paymentId,
          currencyCode: currency,
          amount: fromMinorUnits(session.amount_total, currency),
          paidDate: dateIn(settled.created, timeZone),
          settledCurrency: settled.transaction ? settled.transaction.currency.toUpperCase() : null,
          settledAmount: settled.transaction ? fromMinorUnits(settled.transaction.amount, settled.transaction.currency) : null,
        };
        count(await recordSession(organisation, actor, item, null));
        known.set(session.id, { id: "", session_id: session.id, status: "recorded", waiting_for_link: false });
      }
    }
    // Links no longer right are switched off (PN3, PN5, PN10, question 5).
    const stale = await withOrganisationTransaction(organisation, actor, async (tx) => {
      const open = (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from invoice_payment_links where provider = 'stripe' and status = 'open' order by id`)).rows;
      const result: Array<{ link: LinkRow; reason: string }> = [];
      for (const link of open) {
        const state = await payNowState(tx, link.invoice_id);
        if (!start.enabled) result.push({ link, reason: "Online payments turned off" });
        else if (!state.offered) result.push({ link, reason: state.reason ?? "No longer offered" });
        else if (!linkMatches(link, state.invoice)) result.push({ link, reason: "The amount due changed" });
      }
      return result;
    });
    for (const { link, reason } of stale) {
      try {
        await deactivatePaymentLink(start.key, link.provider_link_id);
      } catch (caught) {
        throw stripeProblem(caught);
      }
      await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, link.id, reason));
      linksClosed += 1;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, MAX_NOTICE) : "The check failed.";
  }
  const status = error ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      "update online_payment_settings set last_check_at = now(), last_check_status = $1, last_check_error = $2, lease_until = null where provider = 'stripe'",
      [status, error],
    ),
  );
  return { status, recorded, notices, linksClosed, error };
}

/** Puts a notice away once a person has dealt with it. Bookkeepers. */
export async function dismissOnlinePaymentNotice(tx: OrgTx, idInput: unknown): Promise<OnlinePaymentStatus> {
  const id = requireId(idInput, "noticeId");
  const updated = await tx.query(
    "update online_payments set dismissed_at = now(), dismissed_by_email = $2, waiting_for_link = false, updated_at = now() where id = $1 and status = 'notice' and dismissed_at is null",
    [id, tx.actor.email],
  );
  if (!updated.rowCount) throw new NotFoundError("Notice not found.");
  await writeAuditEvent(tx, { eventType: "online_payments.notice_dismissed", entityType: "online_payment", entityId: id });
  return getOnlinePaymentStatus(tx);
}

let running = false;

/** Checks every organisation with Pay now on, one at a time. */
export async function checkDueOnlinePayments(): Promise<{ checked: number; failed: number }> {
  if (running || !secretsAvailable()) return { checked: 0, failed: 0 };
  running = true;
  let checked = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due = false;
      try {
        due = await withOrganisationTransaction(organisation, FEED_ACTOR, async (tx) => {
          const found = await tx.query(
            `select 1 from online_payment_settings s
              where s.provider = 'stripe' and ${ACCOUNTING_ON_SQL} and (s.enabled or exists (select 1 from invoice_payment_links where provider = 'stripe' and status = 'open'))
                and (s.lease_until is null or s.lease_until < now())
                and exists (select 1 from stripe_connections where status = 'active')`,
          );
          return Boolean(found.rowCount);
        });
      } catch {
        continue;
      }
      if (!due) continue;
      try {
        const result = await checkOnlinePayments(organisation, FEED_ACTOR);
        if (result.status === "failed") failed += 1;
        checked += 1;
      } catch {
        failed += 1;
      }
    }
    return { checked, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Looks for Stripe payments every 15 minutes while the server runs (question 2: no webhooks). */
export function startOnlinePaymentScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkDueOnlinePayments().catch((caught) => console.warn("[tohyee] Online payments:", caught));
  };
  timer = setInterval(tick, CHECK_MINUTES * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 3 * 60 * 1000).unref?.();
}
