import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { getAkahuServerSettings, updateAkahuServerSettings } from "@/lib/bank/akahu/settings";
import { syncDueBankFeeds } from "@/lib/bank/akahu/sync";

/** GET: the server's Akahu app (secrets are never returned, only whether they're set). Server admins only. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  return json({ akahu: await getAkahuServerSettings() });
});

/** Saves the Akahu app: `mode` (personal | oauth), tokens, redirect URL and how often to sync. `clear: true` removes it. */
export const PUT = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  const body = await readJson(request);
  return json({ akahu: await updateAkahuServerSettings(auth, body) });
});

/** Syncs every bank feed that's due now, across all organisations. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  return json({ result: await syncDueBankFeeds() });
});
