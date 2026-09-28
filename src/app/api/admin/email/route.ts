import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate, requireServerAdmin } from "@/lib/auth/guard";
import { getEmailSettings, updateEmailSettings } from "@/lib/email/mailer";

/** GET: the server's email (SMTP) settings. The password is never returned. Server admins only. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  requireServerAdmin(auth);
  return json({ email: await getEmailSettings() });
});

/** Saves the SMTP settings (`host`, `port`, `username`, `password`, `fromAddress`, `fromName`); `clear: true` removes them. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  return json({ email: await updateEmailSettings(auth, await readJson(request)) });
});
