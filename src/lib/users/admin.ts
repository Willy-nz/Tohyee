import { type AdminActor, writeAdminAuditEvent } from "@/lib/audit";
import { normaliseEmail, parseDisplayName } from "@/lib/auth/service";
import { hashPassword, validateNewPassword } from "@/lib/auth/password";
import { resetTwoStep } from "@/lib/auth/two-step";
import { sendSecurityAlert } from "@/lib/email/mailer";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { optionalBoolean, optionalString } from "@/lib/validation";

export type UserSummary = {
  id: string;
  email: string;
  displayName: string;
  isServerAdmin: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  organisationCount: number;
  twoStepEnabled: boolean;
};

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  is_server_admin: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  organisation_count: string;
  two_step_enabled: boolean;
};

function toSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isServerAdmin: row.is_server_admin,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    organisationCount: Number(row.organisation_count),
    twoStepEnabled: row.two_step_enabled,
  };
}

const USER_SELECT = `
  select u.id, u.email, u.display_name, u.is_server_admin, u.is_active,
         u.last_login_at, u.created_at, u.totp_enabled_at is not null as two_step_enabled,
         (select count(*) from organisation_members m where m.user_id = u.id)::text as organisation_count
    from users u`;

export async function listUsers(): Promise<UserSummary[]> {
  const result = await coreQuery<UserRow>(`${USER_SELECT} order by u.display_name, u.email`);
  return result.rows.map(toSummary);
}

function assertUuid(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new NotFoundError("User not found.");
  }
  return id;
}

export async function createUser(
  actor: AdminActor,
  input: { email: unknown; displayName: unknown; password: unknown; isServerAdmin?: unknown },
): Promise<UserSummary> {
  const email = normaliseEmail(input.email);
  const displayName = parseDisplayName(input.displayName);
  const passwordHash = await hashPassword(validateNewPassword(input.password));
  const isServerAdmin = optionalBoolean(input.isServerAdmin, "isServerAdmin") ?? false;

  return withCoreTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into users (email, display_name, password_hash, is_server_admin)
       values ($1, $2, $3, $4)
       on conflict (email) do nothing
       returning id`,
      [email, displayName, passwordHash, isServerAdmin],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      throw new ConflictError("A user with that email already exists.");
    }
    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "user.created",
      entityType: "user",
      entityId: id,
      details: { email, isServerAdmin },
    });
    const row = await client.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
    return toSummary(row.rows[0]);
  });
}

/**
 * Server-admin edits: rename, activate/deactivate, grant/revoke server admin,
 * or set a new password (which signs that person out everywhere).
 */
export async function updateUser(
  actor: AdminActor,
  userIdInput: string,
  input: {
    displayName?: unknown;
    isActive?: unknown;
    isServerAdmin?: unknown;
    newPassword?: unknown;
  },
): Promise<UserSummary> {
  const userId = assertUuid(userIdInput);
  const displayName =
    input.displayName === undefined ? null : optionalString(input.displayName, "name", { maxLength: 100 });
  const isActive = optionalBoolean(input.isActive, "isActive");
  const isServerAdmin = optionalBoolean(input.isServerAdmin, "isServerAdmin");
  const newPasswordHash =
    input.newPassword == null || input.newPassword === ""
      ? null
      : await hashPassword(validateNewPassword(input.newPassword, "newPassword"));

  if (userId === actor.id && (isActive === false || isServerAdmin === false)) {
    throw new ValidationError("You can't deactivate yourself or remove your own server admin access.");
  }

  return withCoreTransaction(async (client) => {
    const existing = await client.query<{ id: string; is_server_admin: boolean }>(
      "select id, is_server_admin from users where id = $1 for update",
      [userId],
    );
    if (!existing.rows[0]) {
      throw new NotFoundError("User not found.");
    }

    await client.query(
      `update users
          set display_name = coalesce($2, display_name),
              is_active = coalesce($3, is_active),
              is_server_admin = coalesce($4, is_server_admin),
              password_hash = coalesce($5, password_hash),
              password_changed_at = case when $5::text is null then password_changed_at else now() end,
              failed_login_count = case when $5::text is null then failed_login_count else 0 end,
              locked_until = case when $5::text is null then locked_until else null end,
              updated_at = now()
        where id = $1`,
      [userId, displayName, isActive, isServerAdmin, newPasswordHash],
    );

    const admins = await client.query<{ count: string }>(
      "select count(*)::text as count from users where is_server_admin and is_active",
    );
    if (admins.rows[0]?.count === "0") {
      throw new ValidationError("There must always be at least one active server admin.");
    }

    if (isActive === false || newPasswordHash) {
      await client.query("delete from sessions where user_id = $1", [userId]);
    }

    await writeAdminAuditEvent(client, { userId: actor.id, email: actor.email }, {
      eventType: "user.updated",
      entityType: "user",
      entityId: userId,
      details: {
        displayName,
        isActive,
        isServerAdmin,
        passwordReset: Boolean(newPasswordHash),
      },
    });

    const row = await client.query<UserRow>(`${USER_SELECT} where u.id = $1`, [userId]);
    return toSummary(row.rows[0]);
  });
}

/**
 * Resets someone's two-step sign-in (a server admin, for a lost phone). They
 * are signed out everywhere and set it up again at their next sign-in.
 */
export async function resetUserTwoStep(actor: AdminActor, userIdInput: string): Promise<UserSummary> {
  const userId = assertUuid(userIdInput);
  const summary = await withCoreTransaction(async (client) => {
    const found = await client.query<UserRow>(`${USER_SELECT} where u.id = $1 for update of u`, [userId]);
    if (!found.rows[0]) throw new NotFoundError("User not found.");
    await resetTwoStep(client, userId, { userId: actor.id, email: actor.email }, "admin");
    const after = await client.query<UserRow>(`${USER_SELECT} where u.id = $1`, [userId]);
    return toSummary(after.rows[0]);
  });
  await sendSecurityAlert(summary.email, "two-step sign-in was reset", [
    `A server admin (${actor.email}) reset two-step sign-in for your Tohyee account and signed out its sessions.`,
    "You'll set up your authenticator app again the next time you sign in.",
  ]);
  return summary;
}
