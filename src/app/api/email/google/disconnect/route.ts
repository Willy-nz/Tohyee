import { assertSameOrigin } from "@/lib/auth/guard";
import { json, readJson, route, withOrganisation } from "@/lib/api/http";
import { disconnectGoogleSending } from "@/lib/email/google";
import { getOrganisationEmailSettings } from "@/lib/email/settings";

/** Forgets the Google mailbox's sign-in (admins); saved SMTP details or a Microsoft mailbox, if any, are used instead. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    await disconnectGoogleSending(tx);
    return getOrganisationEmailSettings(tx);
  });
  return json({ settings });
});
