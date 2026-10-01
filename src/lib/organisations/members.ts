import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { isRole, type Role, roleAtLeast } from "@/lib/auth/roles";
import { normaliseEmail } from "@/lib/auth/service";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { getOrganisation } from "@/lib/organisations/registry";
import { removePayrollAccess, removePayrollAccessOnJoin } from "@/lib/payroll/access";

export type Member = {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  addedAt: string;
};

type MemberRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
};

function toMember(row: MemberRow): Member {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    addedAt: row.created_at,
  };
}

export async function listMembers(organisationId: string): Promise<Member[]> {
  const result = await coreQuery<MemberRow>(
    `select m.user_id, u.email, u.display_name, m.role, u.is_active, m.created_at
       from organisation_members m
       join users u on u.id = m.user_id
      where m.organisation_id = $1
      order by case m.role when 'owner' then 0 when 'admin' then 1 when 'bookkeeper' then 2 else 3 end,
               u.display_name`,
    [organisationId],
  );
  return result.rows.map(toMember);
}

function parseRole(input: unknown): Role {
  if (!isRole(input)) {
    throw new ValidationError("role must be owner, admin, bookkeeper or viewer.");
  }
  return input;
}

/** Only owners may hand out, take away or change the owner role. */
function assertCanManage(actorRole: Role, targetCurrentRole: Role | null, newRole: Role | null) {
  const touchesOwner = targetCurrentRole === "owner" || newRole === "owner";
  if (touchesOwner && actorRole !== "owner") {
    throw new ForbiddenError("Only an owner can add, change or remove owners.");
  }
}

async function assertAnOwnerRemains(client: DbClient, organisationId: string) {
  const owners = await client.query<{ count: string }>(
    `select count(*)::text as count from organisation_members
      where organisation_id = $1 and role = 'owner'`,
    [organisationId],
  );
  if (owners.rows[0]?.count === "0") {
    throw new ValidationError("An organisation must always have at least one owner.");
  }
}

export async function addMember(
  auth: AuthContext,
  actorRole: Role,
  organisationId: string,
  input: { email: unknown; role: unknown },
): Promise<Member> {
  const email = normaliseEmail(input.email);
  const role = parseRole(input.role);
  assertCanManage(actorRole, null, role);
  await clearPayrollAccessBeforeJoining(auth, organisationId, email);

  return withCoreTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      "select id from users where email = $1",
      [email],
    );
    const userId = user.rows[0]?.id;
    if (!userId) {
      throw new ValidationError(
        `There's no user with the email ${email}. A server admin needs to create their login first.`,
      );
    }
    const inserted = await client.query(
      `insert into organisation_members (organisation_id, user_id, role)
       values ($1, $2, $3)
       on conflict do nothing`,
      [organisationId, userId, role],
    );
    if (inserted.rowCount === 0) {
      throw new ValidationError(`${email} is already a member. Change their role instead.`);
    }
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "organisation.member_added",
      entityType: "organisation",
      entityId: organisationId,
      details: { email, role },
    });
    const row = await client.query<MemberRow>(
      `select m.user_id, u.email, u.display_name, m.role, u.is_active, m.created_at
         from organisation_members m join users u on u.id = m.user_id
        where m.organisation_id = $1 and m.user_id = $2`,
      [organisationId, userId],
    );
    return toMember(row.rows[0]);
  });
}

/**
 * Someone added (back) to an organisation starts without payroll access, even
 * if they had it before they were removed (example PE12). Done in the
 * organisation's database before the membership is added, so a failure here
 * adds nobody.
 */
async function clearPayrollAccessBeforeJoining(auth: AuthContext, organisationId: string, email: string) {
  const user = await coreQuery<{ id: string; is_member: boolean }>(
    `select u.id, exists (
       select 1 from organisation_members m where m.organisation_id = $1 and m.user_id = u.id
     ) as is_member
       from users u where u.email = $2`,
    [organisationId, email],
  );
  const found = user.rows[0];
  if (!found || found.is_member) return;
  const organisation = await getOrganisation(organisationId);
  if (!organisation || organisation.provisioningStatus !== "ready") return;
  await withOrganisationTransaction(organisation, { userId: auth.user.id, email: auth.user.email }, (tx) =>
    removePayrollAccessOnJoin(tx, found.id, email),
  );
}

/**
 * Takes away someone's payroll access when they leave the organisation or
 * drop below bookkeeper (PE13), so it never comes back without an admin
 * granting it again. Done in the organisation's database before the
 * membership changes: if the membership change then fails they've only lost
 * access, never gained it.
 */
async function revokePayrollAccess(
  auth: AuthContext,
  actorRole: Role,
  organisationId: string,
  userId: string,
  nextRole: Role | null,
  reason: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return;
  // Only when the change itself would be allowed (checked again, under lock, below).
  const current = await coreQuery<{ role: Role }>(
    "select role from organisation_members where organisation_id = $1 and user_id = $2",
    [organisationId, userId],
  );
  if (!current.rows[0]) return;
  assertCanManage(actorRole, current.rows[0].role, nextRole);
  const organisation = await getOrganisation(organisationId);
  if (!organisation || organisation.provisioningStatus !== "ready") return;
  const user = await coreQuery<{ email: string }>("select email from users where id = $1", [userId]);
  await withOrganisationTransaction(organisation, { userId: auth.user.id, email: auth.user.email }, (tx) =>
    removePayrollAccess(tx, userId, user.rows[0]?.email ?? "", reason),
  );
}

async function lockMember(client: DbClient, organisationId: string, userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new NotFoundError("Member not found.");
  }
  const existing = await client.query<{ role: Role }>(
    `select role from organisation_members
      where organisation_id = $1 and user_id = $2
      for update`,
    [organisationId, userId],
  );
  const role = existing.rows[0]?.role;
  if (!role) {
    throw new NotFoundError("Member not found.");
  }
  return role;
}

export async function changeMemberRole(
  auth: AuthContext,
  actorRole: Role,
  organisationId: string,
  userId: string,
  input: { role: unknown },
): Promise<void> {
  const role = parseRole(input.role);
  if (!roleAtLeast(role, "bookkeeper")) {
    await revokePayrollAccess(auth, actorRole, organisationId, userId, role, "Role changed below bookkeeper");
  }
  await withCoreTransaction(async (client) => {
    // Serialise membership changes for this organisation (last-owner check).
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`members:${organisationId}`]);
    const current = await lockMember(client, organisationId, userId);
    assertCanManage(actorRole, current, role);
    await client.query(
      `update organisation_members set role = $3, updated_at = now()
        where organisation_id = $1 and user_id = $2`,
      [organisationId, userId, role],
    );
    await assertAnOwnerRemains(client, organisationId);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "organisation.member_role_changed",
      entityType: "organisation",
      entityId: organisationId,
      details: { userId, from: current, to: role },
    });
  });
}

export async function removeMember(
  auth: AuthContext,
  actorRole: Role,
  organisationId: string,
  userId: string,
): Promise<void> {
  await revokePayrollAccess(auth, actorRole, organisationId, userId, null, "Removed from the organisation");
  await withCoreTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`members:${organisationId}`]);
    const current = await lockMember(client, organisationId, userId);
    assertCanManage(actorRole, current, null);
    await client.query(
      "delete from organisation_members where organisation_id = $1 and user_id = $2",
      [organisationId, userId],
    );
    await assertAnOwnerRemains(client, organisationId);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "organisation.member_removed",
      entityType: "organisation",
      entityId: organisationId,
      details: { userId, role: current },
    });
  });
}
