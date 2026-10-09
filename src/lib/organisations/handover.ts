import { type AdminActor, writeAdminAuditEvent, writeAuditEvent } from "@/lib/audit";
import { normaliseEmail } from "@/lib/auth/service";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { getOrganisation, parseOrganisationId } from "@/lib/organisations/registry";

/**
 * "Hand over this organisation" (#208, decision 485). A server admin makes
 * someone an owner of an organisation whose owners can't do it themselves
 * (they died, left, or won't answer). On a server with many clients the
 * server admin is an outsider to each business, so:
 * - it takes effect only after HANDOVER_WAIT_DAYS;
 * - the organisation's owners and admins are emailed straight away and see it
 *   in Tohyee, and any of them can cancel it in that time;
 * - a server admin can't hand an organisation to themselves (Jess);
 * - it's recorded in the server's log and in the organisation's own history.
 * Nothing is taken away: existing members keep their access.
 */
export const HANDOVER_WAIT_DAYS = 7;

export type Handover = {
  id: string;
  organisationId: string;
  toEmail: string;
  toName: string;
  reason: string;
  requestedByEmail: string;
  status: "waiting" | "done" | "cancelled";
  takesEffectAt: string;
  createdAt: string;
  cancelledByEmail: string | null;
};

type Row = {
  id: string;
  organisation_id: string;
  to_email: string;
  to_name: string;
  reason: string;
  requested_by_email: string;
  status: Handover["status"];
  takes_effect_at: string;
  created_at: string;
  cancelled_by_email: string | null;
};

const SELECT = `select h.id::text, h.organisation_id, u.email as to_email, u.display_name as to_name, h.reason, h.requested_by_email,
                       h.status, h.takes_effect_at, h.created_at, h.cancelled_by_email
                  from organisation_handovers h join users u on u.id = h.to_user_id`;

const toHandover = (row: Row): Handover => ({
  id: row.id,
  organisationId: row.organisation_id,
  toEmail: row.to_email,
  toName: row.to_name,
  reason: row.reason,
  requestedByEmail: row.requested_by_email,
  status: row.status,
  takesEffectAt: new Date(row.takes_effect_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
  cancelledByEmail: row.cancelled_by_email,
});

const nzDate = (iso: string) => new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric", timeZone: "Pacific/Auckland" });

/** The handover waiting for an organisation, if any. */
export async function waitingHandover(organisationId: string): Promise<Handover | null> {
  const found = await coreQuery<Row>(`${SELECT} where h.organisation_id = $1 and h.status = 'waiting'`, [organisationId]);
  return found.rows[0] ? toHandover(found.rows[0]) : null;
}

/** Every handover, newest first (the server's Organisations page). */
export async function listHandovers(): Promise<Handover[]> {
  return (await coreQuery<Row>(`${SELECT} order by h.id desc limit 200`)).rows.map(toHandover);
}

async function ownersAndAdmins(organisationId: string): Promise<string[]> {
  const found = await coreQuery<{ email: string }>(
    `select u.email from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and m.role in ('owner', 'admin') and u.is_active order by u.email`,
    [organisationId],
  );
  return found.rows.map((row) => row.email);
}

/** A server admin asks for a handover. It waits HANDOVER_WAIT_DAYS; the owners and admins are emailed now. */
export async function requestHandover(actor: AdminActor, organisationIdInput: unknown, input: { email?: unknown; reason?: unknown }): Promise<Handover> {
  const organisationId = parseOrganisationId(organisationIdInput);
  const organisation = await getOrganisation(organisationId);
  if (!organisation) throw new NotFoundError("Organisation not found.");
  const email = normaliseEmail(input.email);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) throw new ValidationError("Say why (5 to 500 characters), e.g. \"The owner has died; this is the executor's accountant.\" It's shown to the organisation's owners and admins.");
  const handover = await withCoreTransaction(async (client) => {
    const user = (await client.query<{ id: string; is_active: boolean }>("select id, is_active from users where email = $1", [email])).rows[0];
    if (!user) throw new ValidationError(`There's no login for ${email}. Add it on the Users page first.`);
    if (!user.is_active) throw new ValidationError(`${email}'s login is off. Turn it on first.`);
    if (user.id === actor.id) throw new ValidationError("A server admin can't hand an organisation to themselves. Choose the person who'll look after the books.");
    const member = (await client.query<{ role: string }>("select role from organisation_members where organisation_id = $1 and user_id = $2", [organisationId, user.id])).rows[0];
    if (member?.role === "owner") throw new ConflictError(`${email} is already an owner of ${organisation.displayName}.`);
    const waiting = await client.query("select 1 from organisation_handovers where organisation_id = $1 and status = 'waiting' for update", [organisationId]);
    if ((waiting.rowCount ?? 0) > 0) throw new ConflictError(`${organisation.displayName} already has a handover waiting. Cancel it first to ask for a different one.`);
    const inserted = await client.query<{ id: string }>(
      `insert into organisation_handovers (organisation_id, to_user_id, reason, requested_by_user_id, requested_by_email, takes_effect_at)
       values ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 day')) returning id::text`,
      [organisationId, user.id, reason, actor.id, actor.email, HANDOVER_WAIT_DAYS],
    );
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "organisation.handover_requested",
      entityType: "organisation",
      entityId: organisationId,
      details: { to: email, reason, waitDays: HANDOVER_WAIT_DAYS },
    });
    return toHandover((await client.query<Row>(`${SELECT} where h.id = $1`, [inserted.rows[0].id])).rows[0]);
  });
  await withOrganisationTransaction(organisation, { userId: actor.id, email: actor.email }, (tx) =>
    writeAuditEvent(tx, {
      eventType: "organisation.handover_requested",
      entityType: "organisation",
      entityId: organisationId,
      details: { to: email, reason, requestedBy: actor.email, takesEffectAt: handover.takesEffectAt },
    }),
  );
  for (const to of await ownersAndAdmins(organisationId)) {
    await sendSecurityAlert(to, `${organisation.displayName} is being handed over`, [
      `${actor.email}, a server admin of your Tohyee server, has asked to make ${handover.toName} (${email}) an owner of ${organisation.displayName}.`,
      `The reason they gave: "${reason}"`,
      "",
      `It happens on ${nzDate(handover.takesEffectAt)} unless an owner or admin cancels it before then. To cancel it, sign in to Tohyee and open People and roles (Members) for ${organisation.displayName}.`,
    ]);
  }
  return handover;
}

/** Cancels a waiting handover: an owner or admin of the organisation, or a server admin. */
export async function cancelHandover(actor: AdminActor, organisationIdInput: unknown, by: "member" | "server_admin"): Promise<Handover> {
  const organisationId = parseOrganisationId(organisationIdInput);
  const organisation = await getOrganisation(organisationId);
  if (!organisation) throw new NotFoundError("Organisation not found.");
  const handover = await withCoreTransaction(async (client) => {
    const updated = await client.query<{ id: string }>(
      `update organisation_handovers set status = 'cancelled', cancelled_at = now(), cancelled_by_email = $2
        where organisation_id = $1 and status = 'waiting' returning id::text`,
      [organisationId, actor.email],
    );
    if (!updated.rows[0]) throw new NotFoundError("There's no handover waiting for this organisation.");
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "organisation.handover_cancelled",
      entityType: "organisation",
      entityId: organisationId,
      details: { by },
    });
    return toHandover((await client.query<Row>(`${SELECT} where h.id = $1`, [updated.rows[0].id])).rows[0]);
  });
  await withOrganisationTransaction(organisation, { userId: actor.id, email: actor.email }, (tx) =>
    writeAuditEvent(tx, { eventType: "organisation.handover_cancelled", entityType: "organisation", entityId: organisationId, details: { to: handover.toEmail, by } }),
  );
  const tell = new Set([...(await ownersAndAdmins(organisationId)), handover.requestedByEmail]);
  tell.delete(actor.email);
  for (const to of tell) {
    await sendSecurityAlert(to, `handover of ${organisation.displayName} cancelled`, [
      `${actor.email} cancelled the handover that would have made ${handover.toEmail} an owner of ${organisation.displayName}.`,
    ]);
  }
  return handover;
}

/** Carries out handovers whose wait is over: the person becomes an owner (an existing role is raised to owner). */
export async function completeDueHandovers(now = new Date()): Promise<number> {
  const due = await coreQuery<{ id: string; organisation_id: string }>(
    "select id::text, organisation_id from organisation_handovers where status = 'waiting' and takes_effect_at <= $1 order by id",
    [now],
  );
  let done = 0;
  for (const entry of due.rows) {
    const organisation = await getOrganisation(entry.organisation_id);
    if (!organisation) continue;
    const handover = await withCoreTransaction(async (client) => {
      const claimed = await client.query<{ to_user_id: string; requested_by_user_id: string | null; requested_by_email: string }>(
        `update organisation_handovers set status = 'done', completed_at = now()
          where id = $1 and status = 'waiting' returning to_user_id, requested_by_user_id, requested_by_email`,
        [entry.id],
      );
      const row = claimed.rows[0];
      if (!row) return null;
      await client.query(
        `insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')
         on conflict (organisation_id, user_id) do update set role = 'owner', updated_at = now()`,
        [entry.organisation_id, row.to_user_id],
      );
      await writeAdminAuditEvent(client, { userId: row.requested_by_user_id, email: row.requested_by_email }, {
        eventType: "organisation.handover_done",
        entityType: "organisation",
        entityId: entry.organisation_id,
        details: { handover: entry.id },
      });
      return toHandover((await client.query<Row>(`${SELECT} where h.id = $1`, [entry.id])).rows[0]);
    });
    if (!handover) continue;
    done += 1;
    await withOrganisationTransaction(organisation, { userId: null, email: handover.requestedByEmail }, (tx) =>
      writeAuditEvent(tx, {
        eventType: "organisation.handover_done",
        entityType: "organisation",
        entityId: entry.organisation_id,
        details: { to: handover.toEmail, reason: handover.reason, requestedBy: handover.requestedByEmail },
      }),
    );
    for (const to of new Set([...(await ownersAndAdmins(entry.organisation_id)), handover.requestedByEmail])) {
      await sendSecurityAlert(to, `${organisation.displayName} handed over`, [
        `${handover.toName} (${handover.toEmail}) is now an owner of ${organisation.displayName}, as ${handover.requestedByEmail} asked on ${nzDate(handover.createdAt)}.`,
        `The reason given: "${handover.reason}"`,
      ]);
    }
  }
  return done;
}

let timer: NodeJS.Timeout | null = null;

/** Checks for handovers whose wait is over every 15 minutes (and a minute after starting). */
export function startHandoverScheduler(): void {
  if (timer) return;
  const tick = () => {
    completeDueHandovers().catch((error) => console.warn("[tohyee] Organisation handovers:", error instanceof Error ? error.message : error));
  };
  timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}
