import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { createUser, listUsers } from "@/lib/users/admin";

export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ users: await listUsers() });
});

export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const user = await createUser(auth.user, {
    email: body.email,
    displayName: body.displayName,
    password: body.password,
    isServerAdmin: body.isServerAdmin,
  });
  return json({ user }, { status: 201 });
});
