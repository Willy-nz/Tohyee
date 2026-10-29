import { writeAuditEvent } from "@/lib/audit";
import { businessTimeZone, isoDateAt } from "@/lib/dates";
import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { requireAddresses } from "@/lib/email/addresses";
import { explainOpenError, openSender, saveSenderTokens } from "@/lib/email/sender";
import { readSendingAccount } from "@/lib/email/settings";
import { newMessageId, type OutgoingMessage, type SendResult } from "@/lib/email/smtp";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { requireFarming } from "@/lib/farming/paddocks";
import { listOrganisationsForJobs } from "@/lib/organisations/admin";
import { getOrganisation, type OrganisationRecord } from "@/lib/organisations/registry";
import { loadPackData, renderPack } from "@/lib/safety/pack";
import { HASH_LIMITS, WEEKLY_COPY_KEPT } from "@/lib/safety/shared";
import { assertNotDemoForEmail } from "@/lib/demo/guard";

/*
 * The weekly copy off the farm (#446, decisions 958-959; Jess: "A copy you
 * can't edit, such as a weekly PDF emailed off the farm").
 *
 * Once a week, after 6am, a PDF of every safety record with an entry after
 * the last entry number a sent copy included (each with its history) is
 * emailed through the organisation's own email account to the addresses an
 * owner or admin chose, with the number and hash of the latest entry in the
 * whole history in the email. Entry numbers, not dates, decide what's in
 * it, so nothing entered between copies is missed (#461, decision 970).
 * Kept in a mailbox Tohyee can't reach, that number and hash show later
 * whether the history was rewritten (Compare with a copy). Injury and
 * medical details are never in it.
 *
 * Only an email the mail server accepted is recorded as a copy; anything
 * else is kept as the last problem and tried again at the next hourly
 * check. Network calls happen outside database transactions.
 */

export const COPY_DAYS = 7;
export const COPY_HOUR = 6;
const COPY_ACTOR: Actor = { userId: null, email: "safety weekly copy" };

export type CopySettings = { on: boolean; toAddresses: string[]; lastAttemptAt: string | null; lastProblem: string | null; updatedByEmail: string | null };
export type CopySent = { id: string; periodFrom: string; periodTo: string; headSeq: string | null; headHash: string | null; entries: number; toAddresses: string[]; sentByEmail: string; sentAt: string };

/** Whether the weekly copy is due: on, after 6am, and a week since the last one (or none yet). */
export function copyDue(now: Date, lastSentAt: string | null, hourNow: number): boolean {
  if (hourNow < COPY_HOUR) return false;
  if (!lastSentAt) return true;
  // A little slack so a copy sent at 6:05 one week is due at 6:00 the next.
  return now.getTime() - new Date(lastSentAt).getTime() >= COPY_DAYS * 86_400_000 - 30 * 60_000;
}

export async function copySettings(tx: OrgTx): Promise<{ settings: CopySettings; copies: CopySent[] }> {
  await requireFarming(tx);
  const row = await tx.query<{ is_on: boolean; to_addresses: string[]; last_attempt_at: string | null; last_problem: string | null; updated_by_email: string }>(
    "select is_on, to_addresses, last_attempt_at, last_problem, updated_by_email from safety_copy_settings",
  );
  const copies = await tx.query<{ id: string; period_from: string; period_to: string; head_seq: string | null; head_hash: string | null; entries: number; to_addresses: string[]; sent_by_email: string; sent_at: string }>(
    "select id::text, period_from, period_to, head_seq::text, head_hash, entries, to_addresses, sent_by_email, sent_at from safety_copies order by safety_copies.sent_at desc limit 10",
  );
  const settings = row.rows[0];
  return {
    settings: { on: settings?.is_on ?? false, toAddresses: settings?.to_addresses ?? [], lastAttemptAt: settings?.last_attempt_at ?? null, lastProblem: settings?.last_problem ?? null, updatedByEmail: settings?.updated_by_email ?? null },
    copies: copies.rows.map((copy) => ({ id: copy.id, periodFrom: copy.period_from, periodTo: copy.period_to, headSeq: copy.head_seq, headHash: copy.head_hash, entries: copy.entries, toAddresses: copy.to_addresses, sentByEmail: copy.sent_by_email, sentAt: copy.sent_at })),
  };
}

function requireOwnerOrAdmin(tx: OrgTx) {
  if (tx.actor.role !== "owner" && tx.actor.role !== "admin") throw new ForbiddenError("Only an owner or admin can choose where the safety records are sent.");
}

/** Turns the weekly copy on or off and chooses who gets it (owners and admins). */
export async function saveCopySettings(tx: OrgTx, input: { on?: unknown; toAddresses?: unknown }) {
  requireOwnerOrAdmin(tx);
  await requireFarming(tx);
  const on = input.on === true;
  const addresses = requireAddresses(input.toAddresses, "Send it to", { required: on });
  if (addresses.length > 10) throw new ValidationError("Send it to at most 10 addresses.");
  await tx.query(
    `insert into safety_copy_settings (id, is_on, to_addresses, updated_by_email) values (true, $1, $2, $3)
     on conflict (id) do update set is_on = excluded.is_on, to_addresses = excluded.to_addresses, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [on, addresses, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "safety.weekly_copy_set", entityType: "safety_copy_settings", entityId: "1", details: { on, toAddresses: addresses } });
  return copySettings(tx);
}

type Prepared = { message: Omit<OutgoingMessage, "messageId">; periodFrom: string; periodTo: string; headSeq: string | null; headHash: string | null; entries: number; toAddresses: string[] };

/** Gathers and writes this week's copy (database work in one transaction, the PDF after). */
async function prepareCopy(organisation: OrganisationRecord, now: Date): Promise<Prepared | { problem: string } | null> {
  const gathered = await withOrganisationTransaction(organisation, COPY_ACTOR, async (tx) => {
    const settings = await tx.query<{ is_on: boolean; to_addresses: string[] }>("select is_on, to_addresses from safety_copy_settings");
    if (!settings.rows[0]?.is_on || !settings.rows[0].to_addresses.length) return null;
    // The high-water mark is the last entry number a sent copy included (#461, decision 970).
    // It only moves when the mail server accepts a copy, so a failed or retried send loses nothing.
    const last = await tx.query<{ head_seq: string | null; sent_at: string | null }>("select max(head_seq)::text as head_seq, max(sent_at) as sent_at from safety_copies");
    const afterSeq = last.rows[0]?.head_seq ?? "0";
    const periodTo = isoDateAt(now);
    const data = await loadPackData(tx, { from: periodTo, to: periodTo, withholdRestricted: true, afterSeq });
    // The dates are for people reading the email; the entry numbers decide what's in it.
    const firstEntered = data.entries.reduce<string | null>((first, entry) => (!first || entry.enteredAt < first ? entry.enteredAt : first), null);
    let periodFrom = last.rows[0]?.sent_at ? isoDateAt(new Date(last.rows[0].sent_at)) : firstEntered ? isoDateAt(new Date(firstEntered)) : periodTo;
    if (periodFrom > periodTo) periodFrom = periodTo;
    return { data, toAddresses: settings.rows[0].to_addresses, periodFrom, periodTo, afterSeq };
  });
  if (!gathered) return null;
  const { data, toAddresses, periodFrom, periodTo, afterSeq } = gathered;
  const rendered = await renderPack(data);
  const head = data.chain.at(-1) ?? null;
  const text = [
    `Farm safety records for ${data.organisationName}, entered ${periodFrom} to ${periodTo}.`,
    "",
    data.entries.length
      ? `Every record with an entry after number ${afterSeq}${head ? ` up to number ${head.seq}` : ""} is in the attached PDF, each with its history (${data.entries.length} entries).`
      : "Nothing was entered since the last copy.",
    "",
    head ? `The safety history now has ${data.chain.length} entries. The latest is number ${head.seq}, with this hash:` : "The safety history has no entries yet.",
    head ? head.hash : "",
    "",
    "Keep this email somewhere Tohyee can't change it. If the records are ever questioned, enter this number and hash under Farm, Safety, Compare with a copy: if the history was rewritten since, they won't match.",
    HASH_LIMITS,
    data.chainOk ? "When this copy was made, every entry in the history checked out." : "WARNING: when this copy was made, the history did NOT check out. Look at Farm, Safety, Check the history.",
    "",
    "Injury and medical details are never in this email.",
    `Sent to: ${toAddresses.join(", ")}. ${WEEKLY_COPY_KEPT}`,
    "Tohyee keeps these records; it doesn't decide what the law needs you to keep.",
  ].join("\n");
  return {
    message: { to: toAddresses, cc: [], subject: `Farm safety records, ${periodFrom} to ${periodTo}${head ? `: entry ${head.seq}` : ""}`, text, html: null, attachment: { fileName: `farm-safety-${periodFrom}-to-${periodTo}.pdf`, bytes: rendered.pdf }, inline: [] },
    periodFrom,
    periodTo,
    headSeq: head?.seq ?? null,
    headHash: head?.hash ?? null,
    entries: data.entries.length,
    toAddresses,
  };
}

export type CopySender = (organisation: OrganisationRecord, message: Omit<OutgoingMessage, "messageId">) => Promise<SendResult>;

/** Sends through the organisation's own email account (as document emails do). */
const accountSender: CopySender = async (organisation, message) => {
  // The demo farm never sends email, whatever asked (decision 1042).
  assertNotDemoForEmail(organisation);
  const account = await withOrganisationTransaction(organisation, COPY_ACTOR, (tx) => readSendingAccount(tx));
  let sender;
  try {
    sender = await openSender(account, (tokens) => withOrganisationTransaction(organisation, COPY_ACTOR, (tx) => saveSenderTokens(tx, account, tokens)));
  } catch (error) {
    throw new Error(explainOpenError(account, error).message);
  }
  try {
    return await sender.send({ ...message, messageId: newMessageId(account, organisation.id, `safety-copy-${Date.now().toString(36)}`) });
  } catch (error) {
    throw new Error(sender.explain(error).message);
  } finally {
    sender.close();
  }
};

/**
 * Makes and sends one copy now for an organisation (when due, or `force`
 * from Send a copy now). Records it only when the mail server accepted it.
 */
export async function sendSafetyCopy(organisation: OrganisationRecord, options: { now?: Date; force?: boolean; send?: CopySender; actor?: Actor } = {}): Promise<{ sent: CopySent | null; problem: string | null; skipped: boolean }> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? COPY_ACTOR;
  if (!options.force) {
    const last = await withOrganisationTransaction(organisation, COPY_ACTOR, async (tx) => {
      const on = await tx.query<{ enabled: boolean }>("select enabled from farming_settings where id = true");
      if (on.rows[0]?.enabled !== true) return { skip: true, lastSentAt: null };
      const row = await tx.query<{ sent_at: string }>("select sent_at from safety_copies order by safety_copies.sent_at desc limit 1");
      return { skip: false, lastSentAt: row.rows[0]?.sent_at ?? null };
    });
    const hour = Number(new Intl.DateTimeFormat("en-NZ", { timeZone: businessTimeZone(), hour: "numeric", hourCycle: "h23" }).format(now));
    if (last.skip || !copyDue(now, last.lastSentAt, hour)) return { sent: null, problem: null, skipped: true };
  }
  let prepared: Prepared | { problem: string } | null;
  try {
    prepared = await prepareCopy(organisation, now);
  } catch (error) {
    prepared = { problem: error instanceof Error ? error.message : String(error) };
  }
  if (!prepared) return { sent: null, problem: null, skipped: true };
  let problem: string | null = "problem" in prepared ? prepared.problem : null;
  let result: SendResult | null = null;
  if (!problem && !("problem" in prepared)) {
    try {
      result = await (options.send ?? accountSender)(organisation, prepared.message);
      if (result.rejected.length) problem = `The mail server refused ${result.rejected.join(", ")}.`;
    } catch (error) {
      problem = `It wasn't sent: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return withOrganisationTransaction(organisation, actor, async (tx) => {
    await tx.query(
      "update safety_copy_settings set last_attempt_at = now(), last_problem = $1",
      [problem ? problem.slice(0, 1000) : null],
    );
    if (problem || !result || "problem" in prepared) {
      await writeAuditEvent(tx, { eventType: "safety.weekly_copy_failed", entityType: "safety_copy_settings", entityId: "1", details: { problem } });
      return { sent: null, problem, skipped: false };
    }
    const row = await tx.query<{ id: string; sent_at: string }>(
      `insert into safety_copies (period_from, period_to, head_seq, head_hash, entries, to_addresses, message_id, sent_by_email)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text, sent_at`,
      [prepared.periodFrom, prepared.periodTo, prepared.headSeq, prepared.headHash, prepared.entries, prepared.toAddresses, result.messageId, tx.actor.email],
    );
    await writeAuditEvent(tx, { eventType: "safety.weekly_copy_sent", entityType: "safety_copy", entityId: row.rows[0].id, details: { headSeq: prepared.headSeq, entries: prepared.entries } });
    return {
      sent: { id: row.rows[0].id, periodFrom: prepared.periodFrom, periodTo: prepared.periodTo, headSeq: prepared.headSeq, headHash: prepared.headHash, entries: prepared.entries, toAddresses: prepared.toAddresses, sentByEmail: tx.actor.email, sentAt: row.rows[0].sent_at },
      problem: null,
      skipped: false,
    };
  });
}

/** "Send a copy now" (owners and admins): checks who's asking, then sends outside the transaction. */
export async function requireCopySender(tx: OrgTx): Promise<void> {
  requireOwnerOrAdmin(tx);
  await requireFarming(tx);
  const settings = await tx.query<{ is_on: boolean; to_addresses: string[] }>("select is_on, to_addresses from safety_copy_settings");
  if (!settings.rows[0]?.is_on || !settings.rows[0].to_addresses.length) throw new ValidationError("Turn the weekly copy on and choose who gets it first.");
}

// The hourly check --------------------------------------------------------------------------------------

let started = false;

export async function sendDueSafetyCopies(now = new Date()): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const organisation of await listOrganisationsForJobs()) {
    try {
      const fresh = await getOrganisation(organisation.id);
      if (!fresh || !fresh.isActive || fresh.provisioningStatus !== "ready" || fresh.migrationStatus !== "current") continue;
      const result = await sendSafetyCopy(fresh, { now });
      if (result.sent) sent += 1;
      else if (result.problem) failed += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[tohyee] Safety weekly copy for ${organisation.id} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { sent, failed };
}

/** Checks every hour (off with TOHYEE_SAFETY_COPY=off). */
export function startSafetyCopyScheduler(): void {
  if (started || process.env.TOHYEE_SAFETY_COPY === "off") return;
  started = true;
  const timer = setInterval(() => void sendDueSafetyCopies().catch((error) => console.warn(`[tohyee] Safety weekly copies: ${error instanceof Error ? error.message : error}`)), 60 * 60 * 1000);
  timer.unref?.();
}

