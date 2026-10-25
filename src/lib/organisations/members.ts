import { randomBytes } from "node:crypto";
import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { hashPassword } from "@/lib/auth/password";
import { isRole, type Role, roleAtLeast } from "@/lib/auth/roles";
import { normaliseEmail, parseDisplayName } from "@/lib/auth/service";
import { createSetupLink, emailInvitation } from "@/lib/auth/setup-links";
import { coreQuery, type DbClient, withCoreTransaction } from "@/lib/db/transactions";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "@/lib/errors";
import { getOrganisation } from "@/lib/organisations/registry";
import { removePayrollAccess, removePayrollAccessOnJoin } from "@/lib/payroll/access";

export type Member = {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  addedAt: string;
  /**
   * Invited (#441): this organisation's invitation made their login, and it
   * hasn't been signed in to yet. People and roles offers Resend and Cancel.
   */
  invited: boolean;
  /** When the invitation was last sent (null unless invited). */
  invitationSentAt: string | null;
};

type MemberRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  invited: boolean;
  invitation_sent_at: string | null;
};

function toMember(row: MemberRow): Member {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    addedAt: row.created_at,
    invited: row.invited,
    invitationSentAt: row.invited && row.invitation_sent_at ? new Date(row.invitation_sent_at).toISOString() : null,
  };
}

const MEMBER_SELECT = `
  select m.user_id, u.email, u.display_name, m.role, u.is_active, m.created_at,
         (i.user_id is not null and u.last_login_at is null) as invited, i.last_sent_at as invitation_sent_at
    from organisation_members m
    join users u on u.id = m.user_id
    left join organisation_invitations i on i.organisation_id = m.organisation_id and i.user_id = m.user_id`;

export async function listMembers(organisationId: string): Promise<Member[]> {
  const result = await coreQuery<MemberRow>(
    `${MEMBER_SELECT}
      where m.organisation_id = $1
      order by case m.role when 'owner' then 0 when 'admin' then 1 when 'bookkeeper' then 2 when 'viewer' then 3 when 'sales_manager' then 4 when 'sales_rep' then 5 else 6 end,
               u.display_name`,
    [organisationId],
  );
  return result.rows.map(toMember);
}

function parseRole(input: unknown): Role {
  if (!isRole(input)) {
    throw new ValidationError("role must be owner, admin, bookkeeper, viewer, report_viewer, sales_manager or sales_rep.");
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

async function readMember(client: DbClient, organisationId: string, userId: string): Promise<Member> {
  const row = await client.query<MemberRow>(`${MEMBER_SELECT} where m.organisation_id = $1 and m.user_id = $2`, [organisationId, userId]);
  return toMember(row.rows[0]);
}

/*
 * Inviting people (#441, decisions 870-879), as Xero does: an owner or admin
 * invites someone by email with a role from People and roles. Someone who
 * already has a login is added, as addMember always did. Someone new gets a
 * login (never a server admin, in no other organisation) and an emailed setup
 * link (decision 484) to choose a password or continue with Google. They
 * show as Invited, with Resend and Cancel, until they first sign in.
 */

/** Adds, invitations and resends an organisation may make in an hour (decision 875). */
export const INVITES_PER_HOUR = 30;

/** What an invitation gives back: the setup link only when it couldn't be emailed. */
export type InvitationLink = { emailed: boolean; expiresAt: string; url: string | null; localOnly: boolean };
export type InviteResult = { member: Member; invited: boolean; invitation: InvitationLink | null };

async function assertInviteRate(client: DbClient, organisationId: string) {
  const recent = await client.query<{ count: string }>(
    `select count(*)::text as count from admin_audit_events
      where entity_type = 'organisation' and entity_id = $1
        and event_type in ('organisation.member_added', 'organisation.member_invited', 'organisation.invitation_resent')
        and created_at > now() - interval '1 hour'`,
    [organisationId],
  );
  if (Number(recent.rows[0]?.count ?? 0) >= INVITES_PER_HOUR) {
    throw new TooManyRequestsError(`This organisation has added or invited ${INVITES_PER_HOUR} people in the last hour. Wait a while, then try again.`);
  }
}

async function sendInvitation(
  auth: AuthContext,
  organisationId: string,
  person: { email: string; displayName: string },
  link: { url: string; expiresAt: string; localOnly: boolean },
  showLinkIfNotEmailed: boolean,
): Promise<InvitationLink> {
  const organisation = await getOrganisation(organisationId);
  const emailed = await emailInvitation(person, link, auth.user, organisation?.displayName ?? organisationId);
  return {
    emailed,
    expiresAt: link.expiresAt,
    // Shown only when it couldn't be emailed: then the inviter passes it on (decision 873).
    url: !emailed && showLinkIfNotEmailed ? link.url : null,
    localOnly: link.localOnly,
  };
}

export async function inviteMember(
  auth: AuthContext,
  actorRole: Role,
  organisationId: string,
  input: { email: unknown; displayName: unknown; role: unknown },
): Promise<InviteResult> {
  const email = normaliseEmail(input.email);
  // People and roles always asks (as Xero does); it's only used for a new login.
  const displayName = input.displayName == null || (typeof input.displayName === "string" && !input.displayName.trim()) ? null : parseDisplayName(input.displayName);
  const role = parseRole(input.role);
  assertCanManage(actorRole, null, role);
  await clearPayrollAccessBeforeJoining(auth, organisationId, email);
  // Nobody knows this password: the person chooses their own through the link.
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  const actor = { userId: auth.user.id, email: auth.user.email };

  const done = await withCoreTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`members:${organisationId}`]);
    await assertInviteRate(client, organisationId);
    const created = await client.query<{ id: string }>(
      `insert into users (email, display_name, password_hash, is_server_admin)
       values ($1, $2, $3, false)
       on conflict (email) do nothing
       returning id`,
      [email, displayName ?? email, passwordHash],
    );
    const newUserId = created.rows[0]?.id;
    if (newUserId && !displayName) throw new ValidationError("Enter their name.");
    if (!newUserId) {
      // They have a login already: added as before, and nothing is sent to it.
      const existing = await client.query<{ id: string }>("select id from users where email = $1", [email]);
      const userId = existing.rows[0].id;
      const inserted = await client.query(
        "insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3) on conflict do nothing",
        [organisationId, userId, role],
      );
      if (inserted.rowCount === 0) throw new ValidationError(`${email} is already a member. Change their role instead.`);
      await writeAdminAuditEvent(client, actor, {
        eventType: "organisation.member_added",
        entityType: "organisation",
        entityId: organisationId,
        details: { email, role },
      });
      return { member: await readMember(client, organisationId, userId), link: null };
    }
    await writeAdminAuditEvent(client, actor, {
      eventType: "user.created",
      entityType: "user",
      entityId: newUserId,
      details: { email, isServerAdmin: false, invitedTo: organisationId },
    });
    await client.query("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [organisationId, newUserId, role]);
    await client.query(
      "insert into organisation_invitations (organisation_id, user_id, invited_by_user_id, invited_by_email) values ($1, $2, $3, $4)",
      [organisationId, newUserId, auth.user.id, auth.user.email],
    );
    await writeAdminAuditEvent(client, actor, {
      eventType: "organisation.member_invited",
      entityType: "organisation",
      entityId: organisationId,
      details: { email, role, userId: newUserId },
    });
    const link = await createSetupLink(client, newUserId, auth.user);
    return { member: await readMember(client, organisationId, newUserId), link };
  });
  if (!done.link) return { member: done.member, invited: false, invitation: null };
  const invitation = await sendInvitation(auth, organisationId, done.member, done.link, true);
  return { member: done.member, invited: true, invitation };
}

type InvitationRow = { email: string; display_name: string; role: Role; is_active: boolean; other_memberships: number };

/** The invitation, if this member is still Invited; under the members lock. */
async function lockInvitation(client: DbClient, organisationId: string, userId: string): Promise<InvitationRow> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new NotFoundError("There's no invitation waiting for this person.");
  const found = await client.query<InvitationRow>(
    `select u.email, u.display_name, m.role, u.is_active,
            (select count(*) from organisation_members o where o.user_id = u.id and o.organisation_id <> $1)::int as other_memberships
       from organisation_invitations i
       join organisation_members m on m.organisation_id = i.organisation_id and m.user_id = i.user_id
       join users u on u.id = i.user_id
      where i.organisation_id = $1 and i.user_id = $2 and u.last_login_at is null and not u.is_server_admin
      for update of u`,
    [organisationId, userId],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("There's no invitation waiting for this person.");
  return row;
}

/**
 * Resend: a new setup link for an invitation that's still waiting (the old
 * link stops). Only for a login this organisation's invitation made and that
 * nobody has signed in to, so it can't be used on anyone else's login.
 */
export async function resendInvitation(auth: AuthContext, actorRole: Role, organisationId: string, userId: string): Promise<InvitationLink> {
  const done = await withCoreTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`members:${organisationId}`]);
    const invitation = await lockInvitation(client, organisationId, userId);
    assertCanManage(actorRole, invitation.role, null);
    if (!invitation.is_active) throw new ValidationError(`${invitation.email}'s login has been turned off by a server admin.`);
    await assertInviteRate(client, organisationId);
    const link = await createSetupLink(client, userId, auth.user);
    await client.query("update organisation_invitations set last_sent_at = now() where organisation_id = $1 and user_id = $2", [organisationId, userId]);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "organisation.invitation_resent",
      entityType: "organisation",
      entityId: organisationId,
      details: { email: invitation.email, userId },
    });
    return { invitation, link };
  });
  // Once another organisation has them too, the link only goes by email (decision 873).
  return sendInvitation(auth, organisationId, { email: done.invitation.email, displayName: done.invitation.display_name }, done.link, done.invitation.other_memberships === 0);
}

/**
 * Cancel: takes the invited person out of the organisation, and takes away
 * the login the invitation made when nothing else uses it: no other
 * organisation, never signed in to, not a server admin (decision 874).
 */
export async function cancelInvitation(auth: AuthContext, actorRole: Role, organisationId: string, userId: string): Promise<{ loginRemoved: boolean }> {
  const invitation = await withCoreTransaction(async (client) => {
    const row = await lockInvitation(client, organisationId, userId);
    assertCanManage(actorRole, row.role, null);
    return row;
  });
  await removeMember(auth, actorRole, organisationId, userId);
  return withCoreTransaction(async (client) => {
    const removed = await client.query(
      `delete from users u
        where u.id = $1 and u.last_login_at is null and not u.is_server_admin
          and not exists (select 1 from organisation_members m where m.user_id = u.id)
          and not exists (select 1 from organisations o where o.demo_for_user_id = u.id or o.created_by = u.id)`,
      [userId],
    );
    const loginRemoved = removed.rowCount === 1;
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "organisation.invitation_cancelled",
      entityType: "organisation",
      entityId: organisationId,
      details: { email: invitation.email, userId, loginRemoved },
    });
    if (loginRemoved) {
      await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
        eventType: "user.deleted",
        entityType: "user",
        entityId: userId,
        details: { email: invitation.email, reason: "Invitation cancelled before it was used", organisationId },
      });
    }
    return { loginRemoved };
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
    // Their AI keys for this organisation stop for good (decision 341), so
    // adding them back later doesn't bring old keys back to life.
    const revoked = await client.query(
      `update ai_access_tokens set revoked_at = now()
        where organisation_id = $1 and user_id = $2 and revoked_at is null`,
      [organisationId, userId],
    );
    // Connected AI apps are rows above too; a code not yet swapped for tokens stops as well (#427, decision 820).
    await client.query("update oauth_authorization_codes set used_at = now() where organisation_id = $1 and user_id = $2 and used_at is null", [organisationId, userId]);
    // Their farm app keys too (FA2, decision 561).
    const appKeys = await client.query("update farm_app_keys set revoked_at = now() where organisation_id = $1 and user_id = $2 and revoked_at is null", [organisationId, userId]);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "organisation.member_removed",
      entityType: "organisation",
      entityId: organisationId,
      details: { userId, role: current, aiKeysRevoked: revoked.rowCount, farmAppKeysRevoked: appKeys.rowCount },
    });
  });
  // Their farm mailboxes, and everything read from them (FC15).
  const organisation = await getOrganisation(organisationId);
  if (organisation && organisation.provisioningStatus === "ready" && organisation.migrationStatus === "current") {
    const { disconnectMemberFarmMail } = await import("@/lib/farming/calendar");
    await disconnectMemberFarmMail(organisation, userId);
  }
}
