import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { connectAsAdmin } from "@/lib/db/pools";
import { coreQuery, wrapClient } from "@/lib/db/transactions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requireBoolean } from "@/lib/validation";

/**
 * Payroll access (examples PR9-PR12): a permission, separate from roles, that
 * an admin gives named members of the organisation. Only people with it (and
 * the bookkeeper role or higher) can read or change employees' pay details,
 * allocations, rate history, IRD numbers and bank accounts, and later pay runs
 * and payroll reports. Kept in the organisation's own database against the
 * core user id; grants and removals are in the audit log.
 */

export const PAYROLL_ACCESS_MESSAGE =
  "You need payroll access to see payroll. Ask an admin to give it to you in Settings › Payroll access.";

/** The role payroll access needs as well (PR11). */
export const PAYROLL_MINIMUM_ROLE: Role = "bookkeeper";

export async function hasPayrollAccess(tx: OrgTx): Promise<boolean> {
  if (!tx.actor.userId) return false;
  const result = await tx.query<{ exists: boolean }>(
    "select exists (select 1 from payroll_access where user_id = $1) as exists",
    [tx.actor.userId],
  );
  return result.rows[0]?.exists === true;
}

/**
 * Throws 403 unless the signed-in person has payroll access (PR10). Every
 * payroll service calls this first, so pay runs and payroll reports (P3,
 * P10) must too.
 */
export async function requirePayrollAccess(tx: OrgTx): Promise<void> {
  if (!(await hasPayrollAccess(tx))) throw new ForbiddenError(PAYROLL_ACCESS_MESSAGE);
}

/** A current member of the organisation, as `listMembers` gives them (from the core database). */
export type PayrollAccessMember = { userId: string; email: string; displayName: string; role: Role; isActive: boolean };

export type PayrollAccessPerson = PayrollAccessMember & {
  hasPayrollAccess: boolean;
  grantedAt: string | null;
  grantedByEmail: string | null;
};

type GrantRow = { user_id: string; granted_at: string; granted_by_email: string };

async function grants(tx: OrgTx): Promise<Map<string, GrantRow>> {
  const result = await tx.query<GrantRow>("select user_id::text, granted_at, granted_by_email from payroll_access");
  return new Map(result.rows.map((row) => [row.user_id, row]));
}

/** Who has payroll access, for admins (Settings › Payroll access). `members` come from the core database. */
export async function listPayrollAccess(tx: OrgTx, members: readonly PayrollAccessMember[]): Promise<PayrollAccessPerson[]> {
  const granted = await grants(tx);
  return members.map((member) => {
    const grant = granted.get(member.userId);
    return {
      userId: member.userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      isActive: member.isActive,
      hasPayrollAccess: Boolean(grant),
      grantedAt: grant ? grant.granted_at : null,
      grantedByEmail: grant ? grant.granted_by_email : null,
    };
  });
}

/**
 * Gives or removes payroll access (PR11). The route checks the caller is an
 * admin; `members` are the organisation's current members from the core
 * database, read before this transaction.
 */
export async function setPayrollAccess(
  tx: OrgTx,
  members: readonly PayrollAccessMember[],
  input: { userId: unknown; hasPayrollAccess: unknown },
): Promise<PayrollAccessPerson[]> {
  const give = requireBoolean(input.hasPayrollAccess, "hasPayrollAccess");
  const member = members.find((each) => each.userId === input.userId);
  if (!member) throw new NotFoundError("That person isn't a member of this organisation.");
  // Serialise changes so two admins can't each remove the other's last grant.
  await tx.query("lock table payroll_access in share row exclusive mode");
  const granted = await grants(tx);

  if (give) {
    if (!roleAtLeast(member.role, PAYROLL_MINIMUM_ROLE)) {
      throw new ValidationError(`Payroll access needs the ${PAYROLL_MINIMUM_ROLE} role or higher. Change ${member.email}'s role first.`);
    }
    if (!granted.has(member.userId)) {
      await tx.query("insert into payroll_access (user_id, granted_by_user_id, granted_by_email) values ($1, $2, $3)", [
        member.userId,
        tx.actor.userId,
        tx.actor.email,
      ]);
      await writeAuditEvent(tx, {
        eventType: "payroll_access.granted",
        entityType: "payroll_access",
        entityId: member.userId,
        details: { email: member.email },
      });
    }
  } else if (granted.has(member.userId)) {
    const others = members.filter(
      (each) =>
        each.userId !== member.userId &&
        each.isActive &&
        roleAtLeast(each.role, PAYROLL_MINIMUM_ROLE) &&
        granted.has(each.userId),
    );
    if (others.length === 0) {
      throw new ValidationError("At least one person must keep payroll access. Give it to someone else first.");
    }
    await tx.query("delete from payroll_access where user_id = $1", [member.userId]);
    await writeAuditEvent(tx, {
      eventType: "payroll_access.removed",
      entityType: "payroll_access",
      entityId: member.userId,
      details: { email: member.email },
    });
  }
  return listPayrollAccess(tx, members);
}

/**
 * Someone joining (or rejoining) the organisation starts without payroll
 * access, even if they had it before they were removed (PR12).
 */
export async function removePayrollAccessOnJoin(tx: OrgTx, userId: string, email: string): Promise<void> {
  const removed = await tx.query("delete from payroll_access where user_id = $1", [userId]);
  if (removed.rowCount > 0) {
    await writeAuditEvent(tx, {
      eventType: "payroll_access.removed",
      entityType: "payroll_access",
      entityId: userId,
      details: { email, reason: "Added to the organisation again" },
    });
  }
}

/**
 * The organisation's first owner starts with payroll access, so there's
 * always someone (PR9). Runs after migrations when an organisation is created
 * or upgraded, once: `payroll_access_started_at` records that it's been done.
 * Reads the core database first, then uses its own transaction on the
 * organisation's database.
 */
export async function startPayrollAccess(organisation: { id: string; databaseName: string }): Promise<void> {
  const owner = await coreQuery<{ user_id: string; email: string }>(
    `select m.user_id::text, u.email
       from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and m.role = 'owner'
      order by m.created_at, m.user_id
      limit 1`,
    [organisation.id],
  );
  const first = owner.rows[0];
  if (!first) return;

  const connection = await connectAsAdmin(organisation.databaseName);
  const client = wrapClient(connection);
  try {
    await client.query("begin");
    const settings = await client.query<{ organisation_id: string; started: boolean }>(
      "select organisation_id, payroll_access_started_at is not null as started from organisation_settings where id = true for update",
    );
    const row = settings.rows[0];
    if (!row || row.started || row.organisation_id !== organisation.id) {
      await client.query("rollback");
      return;
    }
    await client.query(
      `insert into payroll_access (user_id, granted_by_user_id, granted_by_email) values ($1, null, 'system')
       on conflict (user_id) do nothing`,
      [first.user_id],
    );
    await client.query(
      `insert into audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details)
       values ('payroll_access.granted', 'payroll_access', $1, null, 'system', $2::jsonb)`,
      [first.user_id, JSON.stringify({ email: first.email, reason: "The organisation's first owner" })],
    );
    await client.query("update organisation_settings set payroll_access_started_at = now() where id = true");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await connection.end();
  }
}
