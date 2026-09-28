import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { UnavailableError } from "@/lib/errors";
import { getLatestReleaseCheck } from "@/lib/updates/server-updates";

/** Compares this server's version with the latest GitHub release (server admins only). */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  try {
    return json(await getLatestReleaseCheck());
  } catch (error) {
    throw new UnavailableError(
      error instanceof Error ? error.message : "Couldn't check GitHub for the latest release.",
    );
  }
});
