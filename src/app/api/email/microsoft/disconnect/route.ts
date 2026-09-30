import { assertSameOrigin } from "@/lib/auth/guard";
import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { disconnectMicrosoftSending } from "@/lib/email/microsoft";
import { getOrganisationEmailSettings } from "@/lib/email/settings";

/** Forgets the Microsoft mailbox's sign-in (admins); saved SMTP details, if any, are used again. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    await disconnectMicrosoftSending(tx);
    return getOrganisationEmailSettings(tx);
  });
  return json({ settings });
});
