import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import { writeAuditEvent } from "@/lib/audit";
import { FEED_ACTOR } from "@/lib/bank/akahu/sync";
import {
  cancelPayPalInvoice,
  createPayableInvoice,
  getPayPalInvoice,
  getToken,
  type PayPalInvoice,
  payPalProblem,
} from "@/lib/bank/paypal/client";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { getInvoice } from "@/lib/invoices/service";
import { currencyMinorUnits } from "@/lib/money/currency";
import { cmp, dec, toFixedString, toPlainString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { closeLink, LINK_COLUMNS, type LinkRow, linkMatches, recordSession } from "@/lib/payments/stripe";
import { decryptSecret, secretsAvailable } from "@/lib/secrets";
import { requireId } from "@/lib/validation";

/**
 * Pay with PayPal (PPN1-PPN10, decisions 420-423). PayPal's payment links
 * can't show which payments came through them, so Tohyee makes a copy of
 * the invoice in the organisation's own PayPal account (one item for the
 * amount due, no customer email) and links to PayPal's page for it. Every 15
 * minutes it reads each open PayPal invoice and records new PayPal payments
 * through the same code as Stripe's (PN3), into the bank account linked to
 * PayPal's balance in the invoice's currency. Only invoices in a linked
 * currency offer it; Tohyee never guesses a rate. Network calls happen
 * between short database transactions.
 */

const RECHECK_CLOSED_HOURS = 48;
const MAX_ERROR = 1000;
/** PayPal statuses after which nothing more can be paid, so there's nothing to cancel. */
const FINISHED = new Set(["PAID", "MARKED_AS_PAID", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"]);

export type PayPalPayNowStatus = {
  enabled: boolean;
  payPalConnected: boolean;
  lastCheckAt: string | null;
  lastCheckStatus: "ok" | "failed" | null;
  lastCheckError: string | null;
};

export type InvoicePayPal = {
  available: boolean;
  offered: boolean;
  reason: string | null;
  link: { url: string; amount: string; currencyCode: string; createdAt: string } | null;
};

type SettingsRow = { enabled: boolean; last_check_at: string | null; last_check_status: "ok" | "failed" | null; last_check_error: string | null; lease_until: string | null };

async function settingsRow(tx: OrgTx, lock = false): Promise<SettingsRow | null> {
  const found = await tx.query<SettingsRow>(
    `select enabled, last_check_at, last_check_status, last_check_error, lease_until from online_payment_settings where provider = 'paypal' ${lock ? "for update" : ""}`,
  );
  return found.rows[0] ?? null;
}

async function connection(tx: OrgTx): Promise<{ clientId: string; clientSecret: string | null } | null> {
  const found = await tx.query<{ client_id: string; client_secret_ciphertext: string }>(
    // With several PayPal logins (#182), online payments use the first one connected.
    "select client_id, client_secret_ciphertext from paypal_connections where status = 'active' order by id limit 1",
  );
  const row = found.rows[0];
  if (!row) return null;
  return { clientId: row.client_id, clientSecret: secretsAvailable() ? decryptSecret(row.client_secret_ciphertext) : null };
}

async function token(credentials: { clientId: string; clientSecret: string | null } | null): Promise<string> {
  if (!credentials?.clientSecret) throw new ValidationError("PayPal isn't connected, or its secret can't be read on this server.");
  try {
    return await getToken({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
  } catch (error) {
    throw payPalProblem(error);
  }
}

export async function getPayPalPayNowStatus(tx: OrgTx): Promise<PayPalPayNowStatus> {
  const row = await settingsRow(tx);
  return {
    enabled: row?.enabled ?? false,
    payPalConnected: (await connection(tx)) !== null,
    lastCheckAt: row?.last_check_at ? new Date(row.last_check_at).toISOString() : null,
    lastCheckStatus: row?.last_check_status ?? null,
    lastCheckError: row?.last_check_error ?? null,
  };
}

/** Turns Pay with PayPal on (PPN1). Admins. Needs a PayPal connection. */
export async function enablePayPalPayNow(tx: OrgTx): Promise<PayPalPayNowStatus> {
  if (!(await connection(tx))) throw new ValidationError("Connect PayPal first (Bank accounts, PayPal).");
  await tx.query(
    `insert into online_payment_settings (provider, enabled, updated_by_email) values ('paypal', true, $1)
     on conflict (provider) do update set enabled = true, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "online_payments.enabled", entityType: "online_payment_settings", entityId: "paypal", details: { provider: "paypal" } });
  return getPayPalPayNowStatus(tx);
}

/** Cancels every open PayPal invoice (PPN9), listing the ones PayPal couldn't be reached for. */
export async function closeAllPayPalInvoices(organisation: OrganisationRecord, actor: Actor, reason: string): Promise<{ failed: string[] }> {
  const { links, credentials } = await withOrganisationTransaction(organisation, actor, async (tx) => ({
    links: (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from invoice_payment_links where provider = 'paypal' and status = 'open' order by id`)).rows,
    credentials: await connection(tx),
  }));
  const failed: string[] = [];
  let access: string | null = null;
  for (const link of links) {
    try {
      access ??= await token(credentials);
      await cancelPayPalInvoice(access, link.provider_link_id);
    } catch {
      failed.push(link.url);
    }
    await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, link.id, reason));
  }
  return { failed };
}

/** Turns Pay with PayPal off (PPN9): open PayPal invoices are cancelled first. Admins. */
export async function disablePayPalPayNow(organisation: OrganisationRecord, actor: Actor): Promise<{ status: PayPalPayNowStatus; failed: string[] }> {
  const { failed } = await closeAllPayPalInvoices(organisation, actor, "Pay with PayPal turned off");
  const status = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      `insert into online_payment_settings (provider, enabled, updated_by_email) values ('paypal', false, $1)
       on conflict (provider) do update set enabled = false, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [tx.actor.email],
    );
    await writeAuditEvent(tx, {
      eventType: "online_payments.disabled",
      entityType: "online_payment_settings",
      entityId: "paypal",
      details: { provider: "paypal", linksNotSwitchedOff: failed.length },
    });
    return getPayPalPayNowStatus(tx);
  });
  return { status, failed };
}

/** Whether an invoice offers Pay with PayPal, and why not (PPN2, PPN7, question 2). */
async function payPalState(tx: OrgTx, invoiceId: string) {
  const invoice = await getInvoice(tx, invoiceId);
  const settings = await settingsRow(tx);
  const credentials = await connection(tx);
  const option = await tx.query<{ pay_now: boolean }>("select pay_now from invoice_payment_options where invoice_id = $1", [invoice.id]);
  const linked = await tx.query(
    `select 1 from paypal_links where active and currency_code = $1
        and connection_id = (select c.id from paypal_connections c where c.status = 'active' order by c.id limit 1)`,
    [invoice.currencyCode],
  );
  const available = Boolean(settings?.enabled) && credentials !== null;
  const reason = !settings?.enabled
    ? "Pay with PayPal is off (Settings, Online payments)."
    : !credentials
      ? "PayPal isn't connected."
      : option.rows[0]?.pay_now === false
        ? "Pay now is left off on this invoice."
        : invoice.status !== "approved"
          ? invoice.status === "draft"
            ? "Approve the invoice first."
            : "The invoice is voided."
          : !invoice.amountDue || cmp(dec(invoice.amountDue), dec("0")) <= 0
            ? "Nothing is due."
            : !linked.rowCount
              ? `Link PayPal's ${invoice.currencyCode} balance to a bank account first.`
              : null;
  return { invoice, available, offered: reason === null, reason };
}

async function openLink(tx: OrgTx, invoiceId: string): Promise<LinkRow | null> {
  return (
    (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from invoice_payment_links where provider = 'paypal' and invoice_id = $1 and status = 'open'`, [invoiceId]))
      .rows[0] ?? null
  );
}

/** The open PayPal link if it's still right for the invoice (the PDF and emails). */
export async function currentPayPalUrl(tx: OrgTx, invoiceIdInput: unknown): Promise<string | null> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const state = await payPalState(tx, invoiceId);
  if (!state.offered) return null;
  const link = await openLink(tx, invoiceId);
  return link && linkMatches(link, state.invoice) ? link.url : null;
}

export async function getInvoicePayPal(tx: OrgTx, invoiceIdInput: unknown): Promise<InvoicePayPal> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const state = await payPalState(tx, invoiceId);
  const link = await openLink(tx, invoiceId);
  return {
    available: state.available,
    offered: state.offered,
    reason: state.reason,
    link:
      state.offered && link && linkMatches(link, state.invoice)
        ? { url: link.url, amount: toFixedString(dec(link.amount), currencyMinorUnits(link.currency_code)), currencyCode: link.currency_code, createdAt: new Date(link.created_at).toISOString() }
        : null,
  };
}

/**
 * The invoice's PayPal invoice (PPN2, PPN5): the open one when it's still for
 * the amount due; otherwise the old one is cancelled and a new one made.
 * PayPal keeps a cancelled invoice's number, so later copies are numbered
 * INV-0012-2, INV-0012-3. Returns null when the invoice doesn't offer it.
 */
export async function ensurePayPalInvoice(organisation: OrganisationRecord, actor: Actor, invoiceIdInput: unknown): Promise<string | null> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const before = await withOrganisationTransaction(organisation, actor, async (tx) => ({
    state: await payPalState(tx, invoiceId),
    link: await openLink(tx, invoiceId),
    count: Number((await tx.query<{ n: string }>("select count(*)::text as n from invoice_payment_links where provider = 'paypal' and invoice_id = $1", [invoiceId])).rows[0].n),
    credentials: await connection(tx),
  }));
  const { state, link } = before;
  if (!state.offered) return null;
  if (link && linkMatches(link, state.invoice)) return link.url;
  const access = await token(before.credentials);
  if (link) {
    try {
      await cancelPayPalInvoice(access, link.provider_link_id);
    } catch (error) {
      throw payPalProblem(error);
    }
    await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, link.id, "The amount due changed"));
  }
  const invoice = state.invoice;
  const number = invoice.invoiceNumber ?? `#${invoiceId}`;
  let created: PayPalInvoice;
  try {
    created = await createPayableInvoice(access, {
      invoiceNumber: before.count === 0 ? number : `${number}-${before.count + 1}`,
      currency: invoice.currencyCode,
      amount: invoice.amountDue!,
      invoiceDate: invoice.invoiceDate,
    });
  } catch (error) {
    throw payPalProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into invoice_payment_links (invoice_id, provider, provider_link_id, url, currency_code, amount, created_by_email)
       values ($1, 'paypal', $2, $3, $4, $5::numeric, $6) on conflict do nothing returning id::text`,
      [invoiceId, created.id, created.url, invoice.currencyCode, invoice.amountDue, tx.actor.email],
    );
    if (!inserted.rows[0]) {
      const open = await openLink(tx, invoiceId);
      if (open) return open.url;
      throw new ConflictError("The PayPal invoice is being made by another request. Try again.");
    }
    await writeAuditEvent(tx, {
      eventType: "invoice.payment_link_created",
      entityType: "sales_invoice",
      entityId: invoiceId,
      details: { provider: "paypal", url: created.url, amount: invoice.amountDue, currencyCode: invoice.currencyCode },
    });
    return created.url!;
  });
}

/** Best effort, for emails and printing: a PayPal problem doesn't stop them. */
export async function tryEnsurePayPalInvoice(organisation: OrganisationRecord, actor: Actor, invoiceId: unknown): Promise<void> {
  try {
    await ensurePayPalInvoice(organisation, actor, invoiceId);
  } catch (error) {
    if (!(error instanceof HttpError)) console.warn("[tohyee] PayPal invoice:", error);
  }
}

/** Cancels an invoice's PayPal invoice straight away when it's no longer right (voided, paid). Best effort. */
export async function refreshInvoicePayPal(organisation: OrganisationRecord, actor: Actor, invoiceIdInput: unknown): Promise<void> {
  try {
    const invoiceId = requireId(invoiceIdInput, "invoiceId");
    const found = await withOrganisationTransaction(organisation, actor, async (tx) => {
      const link = await openLink(tx, invoiceId);
      if (!link) return null;
      const state = await payPalState(tx, invoiceId);
      const reason = !state.offered ? (state.reason ?? "No longer offered") : !linkMatches(link, state.invoice) ? "The amount due changed" : null;
      return reason ? { link, reason, credentials: await connection(tx) } : null;
    });
    if (!found) return;
    await cancelPayPalInvoice(await token(found.credentials), found.link.provider_link_id);
    await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, found.link.id, found.reason));
  } catch (error) {
    if (!(error instanceof HttpError)) console.warn("[tohyee] PayPal invoice:", error);
  }
}

export type PayPalCheck = { status: "ok" | "failed"; recorded: number; notices: number; linksClosed: number; error: string | null };

/**
 * Checks PayPal now (PPN3): each open (or recently closed) PayPal invoice is
 * read, and each new PayPal payment on it recorded once; notices waiting for
 * a balance link are tried again; then PayPal invoices no longer right are
 * cancelled (or just closed when PayPal has finished with them).
 */
export async function checkPayPalPayments(organisation: OrganisationRecord, actor: Actor, now = new Date()): Promise<PayPalCheck> {
  const start = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const row = await settingsRow(tx, true);
    if (!row) throw new NotFoundError("Pay with PayPal hasn't been turned on.");
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("PayPal payments are already being checked.");
    await tx.query("update online_payment_settings set lease_until = now() + interval '10 minutes' where provider = 'paypal'");
    const links = await tx.query<LinkRow>(
      `select ${LINK_COLUMNS} from invoice_payment_links
        where provider = 'paypal' and (status = 'open' or closed_at > $1::timestamptz - make_interval(hours => ${RECHECK_CLOSED_HOURS})) order by id`,
      [now.toISOString()],
    );
    const seen = await tx.query<{ session_id: string }>("select session_id from online_payments where provider = 'paypal'");
    const waiting = await tx.query<{
      id: string;
      session_id: string;
      link_id: string | null;
      invoice_id: string | null;
      provider_payment_id: string | null;
      currency_code: string;
      amount: string;
      paid_date: string;
    }>(
      `select id::text, session_id, link_id::text, invoice_id::text, provider_payment_id, currency_code, amount::text, paid_date::text
         from online_payments where provider = 'paypal' and status = 'notice' and waiting_for_link and dismissed_at is null`,
    );
    return { links: links.rows, seen: new Set(seen.rows.map((entry) => entry.session_id)), waiting: waiting.rows, credentials: await connection(tx), enabled: row.enabled };
  });
  let recorded = 0;
  let notices = 0;
  let linksClosed = 0;
  let error: string | null = null;
  const count = (outcome: "recorded" | "notice" | "waiting") => {
    if (outcome === "recorded") recorded += 1;
    else notices += 1;
  };
  try {
    const access = await token(start.credentials);
    for (const row of start.waiting) {
      if (!row.invoice_id) continue;
      count(
        await recordSession(
          organisation,
          actor,
          {
            provider: "paypal",
            sessionId: row.session_id,
            linkId: row.link_id,
            invoiceId: row.invoice_id,
            providerPaymentId: row.provider_payment_id,
            currencyCode: row.currency_code,
            amount: toPlainString(dec(row.amount)),
            paidDate: row.paid_date,
            settledCurrency: null,
            settledAmount: null,
          },
          row.id,
        ),
      );
    }
    const statuses = new Map<string, string>();
    for (const link of start.links) {
      let invoice: PayPalInvoice;
      try {
        invoice = await getPayPalInvoice(access, link.provider_link_id);
      } catch (caught) {
        throw payPalProblem(caught);
      }
      statuses.set(link.id, invoice.status);
      for (const transaction of invoice.transactions) {
        // Payments recorded in PayPal by hand (cash, cheque) aren't PayPal's to report.
        if (transaction.type === "EXTERNAL") continue;
        const paymentId = typeof transaction.payment_id === "string" ? transaction.payment_id : null;
        const value = typeof transaction.amount?.value === "string" ? transaction.amount.value : null;
        const currency = typeof transaction.amount?.currency_code === "string" ? transaction.amount.currency_code.toUpperCase() : link.currency_code;
        const date = typeof transaction.payment_date === "string" ? transaction.payment_date.slice(0, 10) : null;
        if (!paymentId || !value || !/^\d+(\.\d+)?$/.test(value) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const sessionId = `paypal:${link.provider_link_id}:${paymentId}`;
        if (start.seen.has(sessionId)) continue;
        start.seen.add(sessionId);
        count(
          await recordSession(
            organisation,
            actor,
            {
              provider: "paypal",
              sessionId,
              linkId: link.id,
              invoiceId: link.invoice_id,
              providerPaymentId: paymentId,
              currencyCode: currency,
              amount: toPlainString(dec(value)),
              paidDate: date,
              settledCurrency: null,
              settledAmount: null,
            },
            null,
          ),
        );
      }
    }
    // PayPal invoices no longer right are cancelled (PPN5, PPN8, question 5).
    const stale = await withOrganisationTransaction(organisation, actor, async (tx) => {
      const open = (await tx.query<LinkRow>(`select ${LINK_COLUMNS} from invoice_payment_links where provider = 'paypal' and status = 'open' order by id`)).rows;
      const result: Array<{ link: LinkRow; reason: string }> = [];
      for (const link of open) {
        const state = await payPalState(tx, link.invoice_id);
        if (!start.enabled) result.push({ link, reason: "Pay with PayPal turned off" });
        else if (!state.offered) result.push({ link, reason: state.reason ?? "No longer offered" });
        else if (!linkMatches(link, state.invoice)) result.push({ link, reason: "The amount due changed" });
      }
      return result;
    });
    for (const { link, reason } of stale) {
      if (!FINISHED.has(statuses.get(link.id) ?? "")) {
        try {
          await cancelPayPalInvoice(access, link.provider_link_id);
        } catch (caught) {
          throw payPalProblem(caught);
        }
      }
      await withOrganisationTransaction(organisation, actor, (tx) => closeLink(tx, link.id, reason));
      linksClosed += 1;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message.slice(0, MAX_ERROR) : "The check failed.";
  }
  const status = error ? "failed" : "ok";
  await withOrganisationTransaction(organisation, actor, (tx) =>
    tx.query(
      "update online_payment_settings set last_check_at = now(), last_check_status = $1, last_check_error = $2, lease_until = null where provider = 'paypal'",
      [status, error],
    ),
  );
  return { status, recorded, notices, linksClosed, error };
}

let running = false;

/** Checks every organisation with Pay with PayPal on (or PayPal invoices still open), one at a time. */
export async function checkDuePayPalPayments(): Promise<{ checked: number; failed: number }> {
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
              where s.provider = 'paypal' and ${ACCOUNTING_ON_SQL} and (s.enabled or exists (select 1 from invoice_payment_links where provider = 'paypal' and status = 'open'))
                and (s.lease_until is null or s.lease_until < now())
                and exists (select 1 from paypal_connections where status = 'active')`,
          );
          return Boolean(found.rowCount);
        });
      } catch {
        continue;
      }
      if (!due) continue;
      try {
        const result = await checkPayPalPayments(organisation, FEED_ACTOR);
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

/** Looks for PayPal payments every 15 minutes while the server runs. */
export function startPayPalPaymentScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkDuePayPalPayments().catch((caught) => console.warn("[tohyee] PayPal payments:", caught));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 4 * 60 * 1000).unref?.();
}
