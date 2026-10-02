import { json, route } from "@/lib/api/http";
import { assertLocalAdminRequest } from "@/lib/server-admin/local";
import { updateSummary } from "@/lib/updates/updates";

/**
 * For the tray icon on the server computer (decision 328): whether an update
 * is out, and how the last start went, as counts. Only through the
 * local-only address (127.0.0.1), and without signing in, so the icon can
 * show a notification before anyone signs in. No organisation names.
 */
export const GET = route(async (request) => {
  assertLocalAdminRequest(request.headers);
  return json(await updateSummary());
});
