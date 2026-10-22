import { writeAdminAuditEvent } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/guard";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { NotFoundError } from "@/lib/errors";
import { requireId } from "@/lib/validation";

/**
 * The PowerPoint add-in's sign-ins (#429, decision 836), as the person's
 * Connected apps list shows them: one per computer or browser they signed
 * in from. Never includes a token or hash.
 */
export type OfficeConnection = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Not used for 60 days, so it can't get new tokens: it has to sign in again. */
  expired: boolean;
  revokedAt: string | null;
};

type Row = { id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null; expired: boolean };

const COLUMNS = `t.id::text, t.name, t.created_at, t.last_used_at, t.revoked_at,
  not exists (select 1 from oauth_tokens o where o.connection_id = t.id and o.expires_at > now() and (o.kind = 'access' or o.used_at is null)) as expired`;

function toConnection(row: Row): OfficeConnection {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at, expired: row.expired, revokedAt: row.revoked_at };
}

/** The signed-in person's own PowerPoint add-in sign-ins, working ones first, newest first; at most 50. */
export async function listOfficeConnections(auth: AuthContext): Promise<OfficeConnection[]> {
  const result = await coreQuery<Row>(
    `select ${COLUMNS} from ai_access_tokens t
      where t.user_id = $1 and t.kind = 'office'
      order by t.revoked_at is not null, t.id desc limit 50`,
    [auth.user.id],
  );
  return result.rows.map(toConnection);
}

/** Signs one of the person's own PowerPoint add-in sign-ins out, straight away. Twice is fine. */
export async function disconnectOfficeConnection(auth: AuthContext, idInput: unknown): Promise<OfficeConnection> {
  const id = requireId(idInput, "connectionId");
  return withCoreTransaction(async (client) => {
    const found = await client.query<Row>(`select ${COLUMNS} from ai_access_tokens t where t.id = $1 and t.user_id = $2 and t.kind = 'office' for update of t`, [id, auth.user.id]);
    const row = found.rows[0];
    if (!row) throw new NotFoundError("That sign-in wasn't found.");
    if (row.revoked_at) return toConnection(row);
    const updated = await client.query<Row>(`update ai_access_tokens t set revoked_at = now() where t.id = $1 returning ${COLUMNS}`, [id]);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "office_connection.disconnected",
      entityType: "user",
      entityId: auth.user.id,
      details: { connectionId: id, name: row.name, by: "person" },
    });
    return toConnection(updated.rows[0]);
  });
}
