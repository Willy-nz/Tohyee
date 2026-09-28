import type { OrgTx } from "@/lib/db/org-transaction";
import type { DbClient } from "@/lib/db/transactions";

type AuditEvent = {
  eventType: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
};

/** Append-only audit trail inside an organisation's own database. */
export async function writeAuditEvent(tx: OrgTx, event: AuditEvent): Promise<void> {
  await tx.query(
    `insert into audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.eventType,
      event.entityType,
      event.entityId,
      tx.actor.userId,
      tx.actor.email,
      JSON.stringify(event.details ?? {}),
    ],
  );
}

/** Append-only audit trail for server-level actions, in the core database. */
export async function writeAdminAuditEvent(
  client: DbClient,
  actor: { userId: string | null; email: string },
  event: AuditEvent,
): Promise<void> {
  await client.query(
    `insert into admin_audit_events (event_type, entity_type, entity_id, actor_user_id, actor_email, details)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.eventType,
      event.entityType,
      event.entityId,
      actor.userId,
      actor.email,
      JSON.stringify(event.details ?? {}),
    ],
  );
}

/**
 * Who is changing server settings: a signed-in server admin (the server app,
 * or the browser pages), or the command-line tool on the server itself, which
 * has no user (`id` null) and is recorded by its `email` label.
 */
export type AdminActor = { id: string | null; email: string };

/** A server admin, or the command-line tool, for the server settings functions. */
export type ServerAdminAuth = { user: AdminActor & { isServerAdmin: boolean } };

/** The command-line tool (`npm run admin`), recorded in the audit trail as "cli". */
export const COMMAND_LINE_ADMIN: ServerAdminAuth = { user: { id: null, email: "cli", isServerAdmin: true } };
