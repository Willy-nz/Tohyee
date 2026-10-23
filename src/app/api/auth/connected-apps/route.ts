import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { authenticate } from "@/lib/auth/guard";
import { disconnectOfficeConnection, listOfficeConnections } from "@/lib/office/connections";

/** GET: your PowerPoint add-in sign-ins (#429, decision 836), for Your account › Connected apps. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  return json({ connections: await listOfficeConnections(auth) });
});

/** DELETE `{ id }`: signs that PowerPoint add-in sign-in out, straight away. */
export const DELETE = route(async (request) => {
  const auth = await requireAuth(request);
  const body = await readJson(request);
  const connection = await disconnectOfficeConnection(auth, body.id);
  return json({ connection, connections: await listOfficeConnections(auth) });
});
