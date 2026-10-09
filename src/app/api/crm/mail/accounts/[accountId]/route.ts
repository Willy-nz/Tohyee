import { roleAtLeast } from "@/lib/auth/roles";
import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { disconnect, setVisibility } from "@/lib/crm/mail/service";

type Context = { params: Promise<{ accountId: string }> };

/** Sets what the rest of the team sees from this mailbox (example MAIL7). Only its owner. */
export const PATCH = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request);
  const accounts = await withCrm(request, body.organisationId, "read", (tx) => setVisibility(tx, accountId, body.visibility));
  return json({ accounts });
});

/** Disconnects the mailbox and deletes what it synced (example MAIL9). Its owner, or an admin. */
export const DELETE = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const accounts = await withCrm(request, searchParams(request).get("organisationId"), "read", (tx, { membership }) =>
    disconnect(tx, accountId, roleAtLeast(membership.role, "admin")),
  );
  return json({ accounts });
});
