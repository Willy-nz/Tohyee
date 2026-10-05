import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { readServerSetting, writeServerValue } from "@/lib/server-settings";

/**
 * "Allow local mail relay" (Server settings > Email, server admins only).
 * Off by default: an organisation's own SMTP server must then be on the
 * internet, not this server or its private network, because organisation
 * admins aren't server admins and on a shared server one organisation
 * mustn't make Tohyee connect to the server's own mail relay or other
 * services (#145). A server admin turns it on when organisations really do
 * send through a relay on this computer or the local network: then those
 * hosts are allowed, and a connection without encryption is allowed to a
 * relay on this computer (localhost) only.
 */
type LocalRelayValue = { allowed: boolean };

export type LocalMailRelay = { allowed: boolean; updatedAt: string | null; updatedByEmail: string | null };

const KEY = "local_mail_relay";

export async function getLocalMailRelay(): Promise<LocalMailRelay> {
  const stored = await readServerSetting<LocalRelayValue, Record<string, never>>(KEY);
  return { allowed: stored.value.allowed === true, updatedAt: stored.updatedAt, updatedByEmail: stored.updatedByEmail };
}

/** Whether organisations may send through a mail server on this computer or its local network. */
export async function localMailRelayAllowed(): Promise<boolean> {
  return (await getLocalMailRelay()).allowed;
}

/** Turns the switch on or off (server admins only), recorded in the server's audit trail. */
export async function updateLocalMailRelay(auth: ServerAdminAuth, input: { allowed?: unknown }): Promise<LocalMailRelay> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can allow a local mail relay.");
  if (typeof input.allowed !== "boolean") throw new ValidationError("Say whether a local mail relay is allowed (true or false).");
  const allowed = input.allowed;
  await withCoreTransaction(async (client) => {
    await writeServerValue<LocalRelayValue>(client, KEY, { allowed }, auth.user.email);
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.local_mail_relay_updated",
      entityType: "server_setting",
      entityId: KEY,
      details: { allowed },
    });
  });
  return getLocalMailRelay();
}
