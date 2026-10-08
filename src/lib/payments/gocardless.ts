import { writeAuditEvent } from "@/lib/audit";
import { todayIsoDate } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "@/lib/errors";
import { addDays } from "@/lib/financial-year";
import { recordPayment, voidPayment } from "@/lib/invoices/payments";
import { getInvoice } from "@/lib/invoices/service";
import { postJournal } from "@/lib/ledger/journals";
import { add, cmp, type Decimal, dec, divide, neg, toFixedString } from "@/lib/money/decimal";
import { listAllOrganisations } from "@/lib/organisations/admin";
import { ACCOUNTING_ON_SQL } from "@/lib/organisations/accounting-switch";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import {
  cancelPayment,
  createPayment,
  type GcPayment,
  getBillingRequest,
  getCreditor,
  getMandate,
  getPayment,
  type GoCardlessCredentials,
  type GoCardlessEnvironment,
  goCardlessProblem,
  listPaidPayouts,
  parseAccessToken,
  retryPayment,
  startAuthority,
} from "@/lib/payments/gocardless-client";
import { decryptSecret, encryptSecret, secretsAvailable } from "@/lib/secrets";
import { optionalBoolean, requireId } from "@/lib/validation";

/**
 * Direct debit with GoCardless, BECS NZ (stage 10, examples GC1-GC10,
 * decision 482). A customer signs an authority on GoCardless's page; then
 * every approved NZD invoice of theirs is collected on its due date (unless
 * ticked "don't collect"), recorded as a payment into a clearing bank
 * account once GoCardless confirms it, and voided again if it fails. A
 * failure isn't retried by itself: the invoice and the top bar say so, with
 * "Try again". GoCardless's payouts move the money (less its fees) from the
 * clearing account to the bank account it's paid into. Network calls happen
 * between short database transactions, never inside one.
 */
export const GC_CHECK_MINUTES = 15;
/** Collections are asked for this many days before the due date, so later changes to an invoice still count. */
const LEAD_DAYS = 3;
/** Collections are watched this long after their charge date for a late failure or chargeback. */
const WATCH_DAYS = 60;
const ACTOR: Actor = { userId: null, email: "gocardless@tohyee" };

export type GoCardlessStatus = {
  connected: boolean;
  environment: GoCardlessEnvironment;
  creditorName: string | null;
  enabled: boolean;
  clearingAccountCode: string | null;
  payoutAccountCode: string | null;
  feesAccountCode: string | null;
  connectedAt: string | null;
  connectedByEmail: string | null;
  lastCheckAt: string | null;
  lastCheckStatus: "ok" | "failed" | null;
  lastCheckError: string | null;
  /** Collections that failed and haven't been tried again (GC6). */
  failed: Array<{ invoiceId: string; invoiceNumber: string | null; contactName: string; amount: string; reason: string | null }>;
  secretsAvailable: boolean;
};

type SettingsRow = {
  environment: GoCardlessEnvironment;
  access_token_ciphertext: string | null;
  creditor_name: string | null;
  enabled: boolean;
  clearing_code: string | null;
  payout_code: string | null;
  fees_code: string | null;
  connected_at: string | null;
  connected_by_email: string | null;
  last_check_at: string | null;
  last_check_status: "ok" | "failed" | null;
  last_check_error: string | null;
  lease_until: string | null;
};

async function settingsRow(tx: OrgTx, lock = false): Promise<SettingsRow> {
  return (
    await tx.query<SettingsRow>(
      `select s.environment, s.access_token_ciphertext, s.creditor_name, s.enabled,
              c.code as clearing_code, p.code as payout_code, f.code as fees_code,
              s.connected_at, s.connected_by_email, s.last_check_at, s.last_check_status, s.last_check_error, s.lease_until
         from gocardless_settings s
         left join accounts c on c.id = s.clearing_account_id
         left join accounts p on p.id = s.payout_account_id
         left join accounts f on f.id = s.fees_account_id
        where s.id = true ${lock ? "for update of s" : ""}`,
    )
  ).rows[0];
}

function credentialsOf(row: SettingsRow): GoCardlessCredentials | null {
  if (!row.access_token_ciphertext || !secretsAvailable()) return null;
  return { token: decryptSecret(row.access_token_ciphertext), environment: row.environment };
}

function requireSecrets(): void {
  if (!secretsAvailable()) {
    throw new UnavailableError(
      "This server has no TOHYEE_SECRET_KEY, so the GoCardless token can't be stored safely. The server admin needs to set it and restart Tohyee.",
    );
  }
}

const money = (amount: string) => toFixedString(dec(amount), 2);

/**
 * GC6: collections that failed, weren't tried again, and whose invoice still
 * has something due (paid another way, voided or credited, they drop off).
 */
export async function listFailedCollections(tx: OrgTx): Promise<GoCardlessStatus["failed"]> {
  const rows = await tx.query<{ invoice_id: string; invoice_number: string | null; contact_name: string; amount: string; failure_reason: string | null }>(
    `select g.invoice_id::text, i.invoice_number, c.name as contact_name, g.amount::text, g.failure_reason
       from gocardless_collections g join sales_invoices i on i.id = g.invoice_id join contacts c on c.id = i.contact_id
      where g.status = 'failed' and i.status = 'approved'
        and not exists (select 1 from gocardless_collections later where later.invoice_id = g.invoice_id and later.id > g.id)
      order by g.updated_at desc`,
  );
  const failed: GoCardlessStatus["failed"] = [];
  for (const entry of rows.rows) {
    const invoice = await getInvoice(tx, entry.invoice_id);
    if (cmp(dec(invoice.amountDue ?? "0"), dec("0")) <= 0) continue;
    failed.push({ invoiceId: entry.invoice_id, invoiceNumber: entry.invoice_number, contactName: entry.contact_name, amount: money(entry.amount), reason: entry.failure_reason });
  }
  return failed;
}

export async function getGoCardlessStatus(tx: OrgTx): Promise<GoCardlessStatus> {
  const row = await settingsRow(tx);
  const failed = await listFailedCollections(tx);
  return {
    connected: row.access_token_ciphertext !== null,
    environment: row.environment,
    creditorName: row.creditor_name,
    enabled: row.enabled,
    clearingAccountCode: row.clearing_code,
    payoutAccountCode: row.payout_code,
    feesAccountCode: row.fees_code,
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
    connectedByEmail: row.connected_by_email,
    lastCheckAt: row.last_check_at ? new Date(row.last_check_at).toISOString() : null,
    lastCheckStatus: row.last_check_status,
    lastCheckError: row.last_check_error,
    failed,
    secretsAvailable: secretsAvailable(),
  };
}

/** GC1: connects with an access token (checked with GoCardless first). Admins. */
export async function connectGoCardless(
  organisation: OrganisationRecord,
  actor: Actor,
  input: { token?: unknown; environment?: unknown },
): Promise<GoCardlessStatus> {
  requireSecrets();
  const token = parseAccessToken(input.token);
  const environment: GoCardlessEnvironment = input.environment === "sandbox" ? "sandbox" : "live";
  let creditor;
  try {
    creditor = await getCreditor({ token, environment });
  } catch (error) {
    throw goCardlessProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    const row = await settingsRow(tx, true);
    if (row.access_token_ciphertext) throw new ConflictError("GoCardless is already connected. Disconnect it first to use another token.");
    await tx.query(
      `update gocardless_settings set environment = $1, access_token_ciphertext = $2, creditor_name = $3, connected_at = now(),
              connected_by_email = $4, last_check_at = null, last_check_status = null, last_check_error = null, updated_by_email = $4, updated_at = now()
        where id = true`,
      [environment, encryptSecret(token), creditor.name.slice(0, 200), tx.actor.email],
    );
    await writeAuditEvent(tx, { eventType: "gocardless.connected", entityType: "gocardless", entityId: "1", details: { environment, creditor: creditor.name } });
    return getGoCardlessStatus(tx);
  });
}

async function accountIdFor(tx: OrgTx, code: unknown, field: string, kind: "bank" | "expense"): Promise<string> {
  if (typeof code !== "string" || !code.trim()) throw new ValidationError(`Choose the ${field}.`);
  const found = (
    await tx.query<{ id: string; account_type: string; account_class: string; currency_code: string | null; is_active: boolean; name: string }>(
      "select id::text, account_type, account_class, currency_code, is_active, name from accounts where code = $1",
      [code.trim()],
    )
  ).rows[0];
  if (!found || !found.is_active) throw new ValidationError(`There's no active account ${code}.`);
  if (kind === "bank" && (found.account_type !== "bank" || (found.currency_code !== null && found.currency_code !== tx.baseCurrency))) {
    throw new ValidationError(`The ${field} must be a ${tx.baseCurrency} bank account; ${code} ${found.name} isn't.`);
  }
  if (kind === "expense" && found.account_class !== "expense") throw new ValidationError(`The ${field} must be an expense account; ${code} ${found.name} isn't.`);
  return found.id;
}

/** Turns direct debit on or off and chooses its accounts (GC1, GC5). Admins. */
export async function updateGoCardlessSettings(
  tx: OrgTx,
  input: { enabled?: unknown; clearingAccountCode?: unknown; payoutAccountCode?: unknown; feesAccountCode?: unknown },
): Promise<GoCardlessStatus> {
  const row = await settingsRow(tx, true);
  if (!row.access_token_ciphertext) throw new NotFoundError("GoCardless isn't connected.");
  const enabled = optionalBoolean(input.enabled, "enabled") ?? row.enabled;
  const clearing = input.clearingAccountCode === undefined ? row.clearing_code : input.clearingAccountCode;
  const payout = input.payoutAccountCode === undefined ? row.payout_code : input.payoutAccountCode;
  const fees = input.feesAccountCode === undefined ? row.fees_code : input.feesAccountCode;
  const ids =
    clearing || payout || fees || enabled
      ? {
          clearing: await accountIdFor(tx, clearing, "account collected money waits in (e.g. a bank account called GoCardless)", "bank"),
          payout: await accountIdFor(tx, payout, "bank account GoCardless pays out to", "bank"),
          fees: await accountIdFor(tx, fees, "account for GoCardless's fees", "expense"),
        }
      : { clearing: null, payout: null, fees: null };
  if (ids.clearing && ids.clearing === ids.payout) throw new ValidationError("The clearing account and the payout account must be different bank accounts.");
  await tx.query(
    `update gocardless_settings set enabled = $1, clearing_account_id = $2, payout_account_id = $3, fees_account_id = $4,
            updated_by_email = $5, updated_at = now() where id = true`,
    [enabled, ids.clearing, ids.payout, ids.fees, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: "gocardless.updated",
    entityType: "gocardless",
    entityId: "1",
    details: { enabled, clearingAccountCode: clearing, payoutAccountCode: payout, feesAccountCode: fees },
  });
  return getGoCardlessStatus(tx);
}

/**
 * Disconnects: the token is deleted. Refused while collections are still on
 * their way, since GoCardless would collect them with nothing watching.
 */
export async function disconnectGoCardless(tx: OrgTx): Promise<GoCardlessStatus> {
  const row = await settingsRow(tx, true);
  if (!row.access_token_ciphertext) throw new NotFoundError("GoCardless isn't connected.");
  const open = await tx.query<{ count: string }>("select count(*)::text as count from gocardless_collections where status = 'scheduled'");
  if (Number(open.rows[0].count) > 0) {
    throw new ConflictError(
      `${open.rows[0].count} direct debit ${open.rows[0].count === "1" ? "collection is" : "collections are"} on the way. Turn direct debit off and wait for them, or cancel them in GoCardless, then disconnect.`,
    );
  }
  await tx.query(
    "update gocardless_settings set access_token_ciphertext = null, enabled = false, creditor_name = null, updated_by_email = $1, updated_at = now() where id = true",
    [tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "gocardless.disconnected", entityType: "gocardless", entityId: "1" });
  return getGoCardlessStatus(tx);
}

// ---------------------------------------------------------------- authorities

export type DirectDebitAuthority = {
  status: "pending" | "active" | "ended";
  providerStatus: string | null;
  /** GoCardless's page for the customer to fill in (GC2), while pending. */
  url: string | null;
  urlExpiresAt: string | null;
  mandateId: string | null;
  endedReason: string | null;
  createdAt: string;
};

export type ContactDirectDebit = {
  available: boolean;
  reason: string | null;
  current: DirectDebitAuthority | null;
  /** A link can be asked for: no active authority, and no unexpired link waiting. */
  canStart: boolean;
};

type AuthorityRow = {
  id: string;
  contact_id: string;
  billing_request_id: string;
  flow_url: string | null;
  flow_expires_at: string | null;
  mandate_id: string | null;
  status: "pending" | "active" | "ended";
  provider_status: string | null;
  next_possible_charge_date: string | null;
  ended_reason: string | null;
  created_at: string;
};

const AUTHORITY_SELECT = `select id::text, contact_id::text, billing_request_id, flow_url, flow_expires_at, mandate_id, status, provider_status,
                                 next_possible_charge_date::text, ended_reason, created_at from gocardless_authorities`;

function toAuthority(row: AuthorityRow): DirectDebitAuthority {
  return {
    status: row.status,
    providerStatus: row.provider_status,
    url: row.status === "pending" ? row.flow_url : null,
    urlExpiresAt: row.status === "pending" && row.flow_expires_at ? new Date(row.flow_expires_at).toISOString() : null,
    mandateId: row.mandate_id,
    endedReason: row.ended_reason,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function getContactDirectDebit(tx: OrgTx, contactIdInput: unknown): Promise<ContactDirectDebit> {
  const contactId = requireId(contactIdInput, "contactId");
  const row = await settingsRow(tx);
  const latest = (await tx.query<AuthorityRow>(`${AUTHORITY_SELECT} where contact_id = $1 order by id desc limit 1`, [contactId])).rows[0];
  const reason = !row.access_token_ciphertext ? "GoCardless isn't connected (Settings › Online payments)." : !row.enabled ? "Direct debit is off (Settings › Online payments)." : null;
  const waiting = latest?.status === "pending" && latest.flow_expires_at !== null && new Date(latest.flow_expires_at).getTime() > Date.now();
  return { available: reason === null, reason, current: latest ? toAuthority(latest) : null, canStart: reason === null && latest?.status !== "active" && !waiting };
}

/** GC2: asks GoCardless for a page where the customer sets up their authority. Bookkeepers and up. */
export async function startDirectDebit(organisation: OrganisationRecord, actor: Actor, contactIdInput: unknown): Promise<ContactDirectDebit> {
  const contactId = requireId(contactIdInput, "contactId");
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const row = await settingsRow(tx);
    const credentials = credentialsOf(row);
    if (!credentials) throw new ValidationError("GoCardless isn't connected (Settings › Online payments).");
    if (!row.enabled) throw new ValidationError("Direct debit is off (Settings › Online payments).");
    const contact = (await tx.query<{ name: string; email: string | null; currency_code: string | null }>("select name, email, currency_code from contacts where id = $1", [contactId])).rows[0];
    if (!contact) throw new NotFoundError("Contact not found.");
    if (contact.currency_code && contact.currency_code !== tx.baseCurrency) throw new ValidationError(`Direct debit (BECS NZ) collects ${tx.baseCurrency} only; ${contact.name} is invoiced in ${contact.currency_code}.`);
    const current = (await tx.query<AuthorityRow>(`${AUTHORITY_SELECT} where contact_id = $1 and status in ('pending', 'active') for update`, [contactId])).rows[0];
    if (current?.status === "active") throw new ConflictError(`${contact.name} already has an active direct debit authority.`);
    if (current && current.flow_expires_at && new Date(current.flow_expires_at).getTime() > Date.now()) {
      throw new ConflictError(`${contact.name} already has a link to set it up; it's shown below until ${new Date(current.flow_expires_at).toISOString().slice(0, 10)}.`);
    }
    if (current) {
      await tx.query("update gocardless_authorities set status = 'ended', ended_reason = 'The link expired before it was used.', updated_at = now() where id = $1", [current.id]);
    }
    const attempt = (await tx.query<{ count: string }>("select count(*)::text as count from gocardless_authorities where contact_id = $1", [contactId])).rows[0].count;
    return { credentials, name: contact.name, email: contact.email, key: `tohyee-authority-${contactId}-${attempt}` };
  });
  let started;
  try {
    started = await startAuthority(prepared.credentials, { contactId, name: prepared.name, email: prepared.email, idempotencyKey: prepared.key });
  } catch (error) {
    throw goCardlessProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      `insert into gocardless_authorities (contact_id, billing_request_id, flow_url, flow_expires_at, created_by_email)
       values ($1, $2, $3, $4, $5) on conflict (billing_request_id) do nothing`,
      [contactId, started.billingRequest.id, started.flow.authorisation_url, started.flow.expires_at, tx.actor.email],
    );
    await writeAuditEvent(tx, { eventType: "gocardless.authority_requested", entityType: "contact", entityId: contactId, details: { billingRequest: started.billingRequest.id } });
    return getContactDirectDebit(tx, contactId);
  });
}

// ---------------------------------------------------------------- invoices

export type DirectDebitCollection = {
  amount: string;
  chargeDate: string | null;
  status: "scheduled" | "confirmed" | "failed" | "cancelled";
  providerStatus: string | null;
  failureReason: string | null;
  notice: string | null;
  retries: number;
};

export type InvoiceDirectDebit = {
  /** The customer has an active authority and direct debit is on. */
  available: boolean;
  skipped: boolean;
  collections: DirectDebitCollection[];
  /** The latest collection failed and can be tried again (GC6). */
  canRetry: boolean;
};

export async function getInvoiceDirectDebit(tx: OrgTx, invoiceIdInput: unknown): Promise<InvoiceDirectDebit> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const row = await settingsRow(tx);
  const active = await tx.query(
    "select 1 from gocardless_authorities a join sales_invoices i on i.contact_id = a.contact_id where i.id = $1 and a.status = 'active'",
    [invoiceId],
  );
  const skipped = await tx.query("select 1 from gocardless_invoice_skips where invoice_id = $1", [invoiceId]);
  const collections = await tx.query<{ amount: string; charge_date: string | null; status: DirectDebitCollection["status"]; provider_status: string | null; failure_reason: string | null; notice: string | null; retries: number }>(
    "select amount::text, charge_date::text, status, provider_status, failure_reason, notice, retries from gocardless_collections where invoice_id = $1 order by id",
    [invoiceId],
  );
  const list = collections.rows.map((entry) => ({
    amount: money(entry.amount),
    chargeDate: entry.charge_date,
    status: entry.status,
    providerStatus: entry.provider_status,
    failureReason: entry.failure_reason,
    notice: entry.notice,
    retries: entry.retries,
  }));
  const last = list[list.length - 1];
  return {
    available: row.enabled && row.access_token_ciphertext !== null && (active.rowCount ?? 0) > 0,
    skipped: (skipped.rowCount ?? 0) > 0,
    collections: list,
    canRetry: last?.status === "failed" && last.retries < 3 && (active.rowCount ?? 0) > 0,
  };
}

/** "Don't collect this one" (answer 1). A collection not yet sent to the banks is cancelled at the next check. */
export async function setInvoiceDirectDebitSkip(tx: OrgTx, invoiceIdInput: unknown, skipInput: unknown): Promise<InvoiceDirectDebit> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const skip = optionalBoolean(skipInput, "skip");
  if (skip === null) throw new ValidationError("skip must be true or false.");
  await getInvoice(tx, invoiceId);
  if (skip) {
    await tx.query("insert into gocardless_invoice_skips (invoice_id, created_by_email) values ($1, $2) on conflict do nothing", [invoiceId, tx.actor.email]);
  } else {
    await tx.query("delete from gocardless_invoice_skips where invoice_id = $1", [invoiceId]);
  }
  await writeAuditEvent(tx, { eventType: skip ? "gocardless.invoice_skipped" : "gocardless.invoice_unskipped", entityType: "sales_invoice", entityId: invoiceId });
  return getInvoiceDirectDebit(tx, invoiceId);
}

/** GC6 "Try again": asks GoCardless to retry the failed collection (at most three times). Bookkeepers and up. */
export async function retryDirectDebit(organisation: OrganisationRecord, actor: Actor, invoiceIdInput: unknown): Promise<InvoiceDirectDebit> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const state = await getInvoiceDirectDebit(tx, invoiceId);
    if (!state.canRetry) throw new ConflictError("There's no failed collection to try again for this invoice (or it has been tried three times, or the authority isn't active).");
    const row = (await tx.query<{ id: string; provider_payment_id: string }>(
      "select id::text, provider_payment_id from gocardless_collections where invoice_id = $1 order by id desc limit 1 for update",
      [invoiceId],
    )).rows[0];
    const credentials = credentialsOf(await settingsRow(tx));
    if (!credentials) throw new ValidationError("GoCardless isn't connected.");
    return { row, credentials };
  });
  let payment: GcPayment;
  try {
    payment = await retryPayment(prepared.credentials, prepared.row.provider_payment_id);
  } catch (error) {
    throw goCardlessProblem(error);
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      `update gocardless_collections set status = 'scheduled', provider_status = $2, charge_date = $3, failure_reason = null, retries = retries + 1,
              customer_payment_id = null, updated_at = now() where id = $1`,
      [prepared.row.id, payment.status, payment.charge_date],
    );
    await writeAuditEvent(tx, { eventType: "gocardless.collection_retried", entityType: "sales_invoice", entityId: invoiceId, details: { payment: payment.id } });
    return getInvoiceDirectDebit(tx, invoiceId);
  });
}

// ---------------------------------------------------------------- the check

const SCHEDULED = new Set(["pending_customer_approval", "pending_submission", "submitted"]);
const CONFIRMED = new Set(["confirmed", "paid_out"]);
const FAILED = new Set(["failed", "charged_back", "customer_approval_denied"]);

function authorityStatus(mandateStatus: string): "pending" | "active" | "ended" {
  if (mandateStatus === "active") return "active";
  if (["failed", "cancelled", "expired", "consumed", "blocked"].includes(mandateStatus)) return "ended";
  return "pending";
}

export type GoCardlessCheck = { collected: number; recorded: number; failed: number; payouts: number; error: string | null };

/**
 * The 15-minute check (and Check now): refreshes authorities, follows each
 * collection, cancels what an invoice no longer needs, asks for new
 * collections on invoices due within LEAD_DAYS, and posts paid payouts.
 */
export async function checkGoCardless(organisation: OrganisationRecord, actor: Actor = ACTOR, today = todayIsoDate()): Promise<GoCardlessCheck> {
  const prepared = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const row = await settingsRow(tx, true);
    const credentials = credentialsOf(row);
    if (!credentials) return null;
    if (row.lease_until && new Date(row.lease_until).getTime() > Date.now()) throw new ConflictError("GoCardless is already being checked.");
    await tx.query("update gocardless_settings set lease_until = now() + interval '10 minutes' where id = true");
    return { credentials, row };
  });
  if (!prepared) return { collected: 0, recorded: 0, failed: 0, payouts: 0, error: null };
  const { credentials, row } = prepared;
  const result: GoCardlessCheck = { collected: 0, recorded: 0, failed: 0, payouts: 0, error: null };
  const note = (error: unknown) => {
    result.error ??= (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  };
  const run = <T>(work: (tx: OrgTx) => Promise<T>) => withOrganisationTransaction(organisation, actor, work);

  try {
    // 1. Authorities (GC2, GC7).
    const authorities = await run((tx) => tx.query<AuthorityRow>(`${AUTHORITY_SELECT} where status in ('pending', 'active') order by id`));
    for (const authority of authorities.rows) {
      try {
        let mandateId = authority.mandate_id;
        let billingStatus: string | null = null;
        if (!mandateId) {
          const request = await getBillingRequest(credentials, authority.billing_request_id);
          billingStatus = request.status;
          mandateId = request.links?.mandate_request_mandate ?? null;
        }
        const mandate = mandateId ? await getMandate(credentials, mandateId) : null;
        const status = mandate ? authorityStatus(mandate.status) : billingStatus === "cancelled" ? "ended" : "pending";
        if (status === authority.status && mandate?.status === authority.provider_status && mandate?.next_possible_charge_date === authority.next_possible_charge_date) continue;
        await run(async (tx) => {
          await tx.query(
            `update gocardless_authorities set mandate_id = coalesce($2, mandate_id), status = $3, provider_status = $4, next_possible_charge_date = $5,
                    ended_reason = case when $3 = 'ended' then $6 else ended_reason end, updated_at = now() where id = $1`,
            [authority.id, mandateId, status, mandate?.status ?? billingStatus, mandate?.next_possible_charge_date ?? null, `GoCardless says the authority is ${mandate?.status ?? billingStatus}.`],
          );
          if (status !== authority.status) {
            await writeAuditEvent(tx, { eventType: `gocardless.authority_${status}`, entityType: "contact", entityId: authority.contact_id, details: { mandate: mandateId, providerStatus: mandate?.status ?? billingStatus } });
          }
        });
      } catch (error) {
        note(error);
      }
    }

    // 2. Collections on their way, and recent ones for a late failure (GC4, GC6, GC7).
    const watched = await run((tx) =>
      tx.query<{ id: string; invoice_id: string; provider_payment_id: string; amount: string; status: string; provider_status: string | null; customer_payment_id: string | null; retries: number }>(
        `select id::text, invoice_id::text, provider_payment_id, amount::text, status, provider_status, customer_payment_id::text, retries from gocardless_collections
          where status = 'scheduled' or (status = 'confirmed' and (charge_date is null or charge_date >= $1::date))
          order by id`,
        [addDays(today, -WATCH_DAYS)],
      ),
    );
    for (const collection of watched.rows) {
      try {
        const payment = await getPayment(credentials, collection.provider_payment_id);
        if (payment.status === collection.provider_status) continue;
        await run((tx) => followPayment(tx, collection, payment, row.clearing_code, today, result));
      } catch (error) {
        note(error);
      }
    }

    // 3. Collections an invoice no longer needs (GC8, GC9, "don't collect").
    const open = await run((tx) =>
      tx.query<{ id: string; invoice_id: string; provider_payment_id: string; amount: string; provider_status: string | null; notice: string | null }>(
        "select id::text, invoice_id::text, provider_payment_id, amount::text, provider_status, notice from gocardless_collections where status = 'scheduled' order by id",
      ),
    );
    for (const collection of open.rows) {
      const unwanted = await run(async (tx) => {
        const invoice = await getInvoice(tx, collection.invoice_id);
        const skipped = await tx.query("select 1 from gocardless_invoice_skips where invoice_id = $1", [collection.invoice_id]);
        if (invoice.status !== "approved") return `${invoice.invoiceNumber ?? "The invoice"} is ${invoice.status}`;
        if ((skipped.rowCount ?? 0) > 0) return "it's marked \"don't collect\"";
        if (cmp(dec(invoice.amountDue ?? "0"), dec(collection.amount)) < 0) return `only ${invoice.amountDue} is due now`;
        return null;
      });
      if (!unwanted) continue;
      try {
        const cancelled = await cancelPayment(credentials, collection.provider_payment_id);
        await run(async (tx) => {
          await tx.query("update gocardless_collections set status = 'cancelled', provider_status = $2, notice = $3, updated_at = now() where id = $1", [
            collection.id,
            cancelled.status,
            `Cancelled because ${unwanted}.`,
          ]);
          await writeAuditEvent(tx, { eventType: "gocardless.collection_cancelled", entityType: "sales_invoice", entityId: collection.invoice_id, details: { reason: unwanted } });
        });
      } catch {
        // Already sent to the banks: it goes ahead, and a person sorts out the difference.
        const text = `GoCardless had already sent this collection to the bank when ${unwanted}, so it couldn't be cancelled. If it's collected, refund the difference in GoCardless.`;
        if (collection.notice !== text) {
          await run((tx) => tx.query("update gocardless_collections set notice = $2, updated_at = now() where id = $1", [collection.id, text]));
        }
      }
    }

    // 4. New collections (GC3), only while direct debit is on.
    if (row.enabled) {
      const due = await run((tx) =>
        tx.query<{ invoice_id: string; due_date: string; authority_id: string; mandate_id: string; next_possible_charge_date: string | null; invoice_number: string | null; attempts: string }>(
          `select i.id::text as invoice_id, i.due_date::text, a.id::text as authority_id, a.mandate_id, a.next_possible_charge_date::text, i.invoice_number,
                  (select count(*) from gocardless_collections g where g.invoice_id = i.id)::text as attempts
             from sales_invoices i
             join gocardless_authorities a on a.contact_id = i.contact_id and a.status = 'active' and a.mandate_id is not null
            where i.status = 'approved' and i.currency_code = $1 and i.due_date <= $2::date
              and not exists (select 1 from gocardless_invoice_skips s where s.invoice_id = i.id)
              and not exists (select 1 from gocardless_collections g where g.invoice_id = i.id and g.status in ('scheduled', 'failed'))
              and not exists (select 1 from gocardless_collections g where g.invoice_id = i.id and g.status = 'confirmed' and g.customer_payment_id is null)
            order by i.due_date, i.id`,
          [organisation.baseCurrency, addDays(today, LEAD_DAYS)],
        ),
      );
      for (const entry of due.rows) {
        try {
          const invoice = await run((tx) => getInvoice(tx, entry.invoice_id));
          const amountDue = dec(invoice.amountDue ?? "0");
          if (cmp(amountDue, dec("0")) <= 0) continue;
          const earliest = entry.next_possible_charge_date ?? addDays(today, 1);
          const chargeDate = entry.due_date > earliest ? entry.due_date : earliest;
          const cents = Number(toFixedString(amountDue, 2).replace(".", ""));
          const payment = await createPayment(credentials, {
            amountCents: cents,
            chargeDate,
            mandateId: entry.mandate_id,
            description: `Invoice ${entry.invoice_number ?? entry.invoice_id}`,
            invoiceId: entry.invoice_id,
            idempotencyKey: `tohyee-invoice-${entry.invoice_id}-${entry.attempts}`,
          });
          await run(async (tx) => {
            await tx.query(
              `insert into gocardless_collections (invoice_id, authority_id, provider_payment_id, amount, charge_date, status, provider_status, created_by_email)
               values ($1, $2, $3, $4::numeric, $5, 'scheduled', $6, $7) on conflict (provider_payment_id) do nothing`,
              [entry.invoice_id, entry.authority_id, payment.id, toFixedString(amountDue, 2), payment.charge_date ?? chargeDate, payment.status, tx.actor.email],
            );
            await writeAuditEvent(tx, {
              eventType: "gocardless.collection_requested",
              entityType: "sales_invoice",
              entityId: entry.invoice_id,
              details: { payment: payment.id, amount: toFixedString(amountDue, 2), chargeDate: payment.charge_date ?? chargeDate },
            });
          });
          result.collected += 1;
        } catch (error) {
          note(error);
        }
      }
    }

    // 5. Payouts (GC5).
    if (row.connected_at && row.clearing_code && row.payout_code && row.fees_code) {
      try {
        const payouts = await listPaidPayouts(credentials, new Date(row.connected_at).toISOString());
        for (const payout of payouts) {
          if ((payout.payout_type ?? "merchant") !== "merchant" || !payout.arrival_date) continue;
          const posted = await run((tx) => postPayout(tx, payout, row));
          if (posted) result.payouts += 1;
        }
      } catch (error) {
        note(error);
      }
    }
  } finally {
    await run((tx) =>
      tx.query(
        "update gocardless_settings set last_check_at = now(), last_check_status = $1, last_check_error = $2, lease_until = null where id = true",
        [result.error ? "failed" : "ok", result.error],
      ),
    );
  }
  return result;
}

/** Brings one collection up to date with GoCardless's payment. */
async function followPayment(
  tx: OrgTx,
  collection: { id: string; invoice_id: string; provider_payment_id: string; amount: string; customer_payment_id: string | null; retries: number },
  payment: GcPayment,
  clearingCode: string | null,
  today: string,
  result: GoCardlessCheck,
): Promise<void> {
  if (SCHEDULED.has(payment.status)) {
    await tx.query("update gocardless_collections set provider_status = $2, charge_date = coalesce($3, charge_date), updated_at = now() where id = $1", [
      collection.id,
      payment.status,
      payment.charge_date,
    ]);
    return;
  }
  if (CONFIRMED.has(payment.status)) {
    let paymentId = collection.customer_payment_id;
    let notice: string | null = null;
    if (!paymentId) {
      if (!clearingCode) {
        notice = "Collected, but no clearing account is chosen in Settings › Online payments, so the payment wasn't recorded.";
      } else {
        try {
          const recorded = await recordPayment(tx, collection.invoice_id, {
            source: "gocardless",
            // Each try of a payment (GC6 "Try again") is recorded with its own key, as the earlier one may have been voided.
            idempotencyKey: `gocardless-${collection.provider_payment_id}-${collection.id}-${collection.retries}`,
            paymentDate: payment.charge_date ?? today,
            amount: money(collection.amount),
            bankAccountCode: clearingCode,
            reference: `GoCardless ${collection.provider_payment_id}`,
          });
          paymentId = recorded.payment.id;
          result.recorded += 1;
        } catch (error) {
          notice = `Collected ${money(collection.amount)}, but it couldn't be recorded: ${error instanceof Error ? error.message : String(error)} Record it by hand into the clearing account.`.slice(0, 1000);
        }
      }
    }
    await tx.query(
      "update gocardless_collections set status = 'confirmed', provider_status = $2, customer_payment_id = $3, notice = $4, updated_at = now() where id = $1",
      [collection.id, payment.status, paymentId, notice],
    );
    if (paymentId && !collection.customer_payment_id) {
      await writeAuditEvent(tx, { eventType: "invoice.paid_by_direct_debit", entityType: "sales_invoice", entityId: collection.invoice_id, details: { payment: collection.provider_payment_id, paymentId } });
    }
    return;
  }
  if (FAILED.has(payment.status)) {
    // GC6: the payment recorded for it, if any, is voided; the invoice is due again.
    if (collection.customer_payment_id) {
      await voidPayment(tx, collection.invoice_id, collection.customer_payment_id, {
        source: "gocardless",
        idempotencyKey: `gocardless-void-${collection.provider_payment_id}-${collection.customer_payment_id}`,
        voidDate: today,
      });
    }
    const reason = payment.status === "charged_back" ? "The customer's bank reversed it (a chargeback)." : payment.status === "customer_approval_denied" ? "The customer didn't approve it." : "GoCardless says it failed.";
    await tx.query(
      "update gocardless_collections set status = 'failed', provider_status = $2, failure_reason = $3, customer_payment_id = null, updated_at = now() where id = $1",
      [collection.id, payment.status, reason],
    );
    await writeAuditEvent(tx, { eventType: "gocardless.collection_failed", entityType: "sales_invoice", entityId: collection.invoice_id, details: { payment: collection.provider_payment_id, status: payment.status } });
    result.failed += 1;
    return;
  }
  // Cancelled by GoCardless (an authority cancelled, GC7) or in its dashboard.
  await tx.query("update gocardless_collections set status = 'cancelled', provider_status = $2, notice = coalesce(notice, $3), updated_at = now() where id = $1", [
    collection.id,
    payment.status,
    `GoCardless says the collection is ${payment.status}.`,
  ]);
}

/** GC5: Dr payout bank account, fees to their account, Cr the clearing account. Once per payout. */
async function postPayout(tx: OrgTx, payout: { id: string; amount: number; deducted_fees: number; arrival_date: string | null; reference: string | null }, row: SettingsRow): Promise<boolean> {
  const seen = await tx.query("select 1 from gocardless_payouts where payout_id = $1", [payout.id]);
  if ((seen.rowCount ?? 0) > 0) return false;
  // Cents from GoCardless are whole numbers; turned into dollars with the decimal library, never floats.
  const cents = (value: number) => {
    if (!Number.isSafeInteger(value)) throw new ValidationError(`GoCardless sent an amount that isn't whole cents (${value}).`);
    return divide(dec(String(value)), dec("100"), 2);
  };
  const amountDec = cents(payout.amount);
  const feesDec = cents(payout.deducted_fees);
  const grossDec = add(amountDec, feesDec);
  const fixed = (value: Decimal) => toFixedString(value, 2);
  const amount = amountDec;
  const fees = feesDec;
  const gross = grossDec;
  const lines = [
    { accountCode: row.payout_code, debitAmount: fixed(amount), creditAmount: "0", description: `GoCardless payout ${payout.reference ?? payout.id}` },
    ...(payout.deducted_fees !== 0
      ? [
          {
            accountCode: row.fees_code,
            debitAmount: payout.deducted_fees > 0 ? fixed(fees) : "0",
            creditAmount: payout.deducted_fees < 0 ? fixed(neg(fees)) : "0",
            description: "GoCardless fees",
          },
        ]
      : []),
    { accountCode: row.clearing_code, debitAmount: "0", creditAmount: fixed(gross), description: `GoCardless payout ${payout.reference ?? payout.id}` },
  ];
  const posted = await postJournal(tx, {
    source: "gocardless",
    idempotencyKey: `gocardless-payout-${payout.id}`,
    postingDate: payout.arrival_date,
    reference: `GoCardless ${payout.reference ?? payout.id}`.slice(0, 100),
    description: "GoCardless payout: collected direct debits less fees",
    lines,
  });
  await tx.query(
    "insert into gocardless_payouts (payout_id, amount, fees, arrival_date, reference, journal_id) values ($1, $2::numeric, $3::numeric, $4, $5, $6)",
    [payout.id, fixed(amount), fixed(fees), payout.arrival_date, payout.reference, posted.journal.id],
  );
  return true;
}

let running = false;

/** Checks every organisation with GoCardless connected (every 15 minutes while the server runs). */
export async function checkDueGoCardless(): Promise<{ checked: number; failed: number }> {
  if (running || !secretsAvailable()) return { checked: 0, failed: 0 };
  running = true;
  let checked = 0;
  let failed = 0;
  try {
    for (const organisation of await listAllOrganisations()) {
      if (!organisation.isActive || organisation.provisioningStatus !== "ready" || organisation.migrationStatus !== "current") continue;
      let due = false;
      try {
        due = await withOrganisationTransaction(organisation, ACTOR, async (tx) => {
          const found = await tx.query(
            `select 1 from gocardless_settings where access_token_ciphertext is not null and ${ACCOUNTING_ON_SQL}
                and (lease_until is null or lease_until < now())`,
          );
          return (found.rowCount ?? 0) > 0;
        });
      } catch {
        continue;
      }
      if (!due) continue;
      try {
        const result = await checkGoCardless(organisation);
        if (result.error) failed += 1;
        else checked += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[tohyee] GoCardless check failed for ${organisation.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { checked, failed };
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function startGoCardlessScheduler(): void {
  if (timer) return;
  const tick = () => {
    checkDueGoCardless().catch((error) => console.warn("[tohyee] GoCardless scheduler:", error));
  };
  timer = setInterval(tick, GC_CHECK_MINUTES * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 4 * 60 * 1000).unref?.();
}
