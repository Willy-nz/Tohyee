import { json, requireAuth, route, searchParams } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { listLogFiles, logDirectory, readLogTail } from "@/lib/server-admin/logs";

/** GET: the server's log files, newest first; `?file=&search=`: the newest part of one (decision 1599). Server admins, on the server computer. */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const params = searchParams(request);
  const files = await listLogFiles();
  const file = params.get("file");
  return json({ folder: logDirectory(), files, tail: file ? await readLogTail(file, { search: params.get("search") }) : null });
});
