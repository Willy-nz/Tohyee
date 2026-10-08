import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { twoStepRequired } from "@/lib/auth/sessions";
import { createUser, listUsers } from "@/lib/users/admin";

export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  // twoStepRequired: new logins get a setup link instead of a password (#208).
  return json({ users: await listUsers(), twoStepRequired: twoStepRequired() });
});

export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  // With two-step sign-in on, no password: the answer has the setup link to send (#208).
  const created = await createUser(auth.user, {
    email: body.email,
    displayName: body.displayName,
    password: body.password,
    isServerAdmin: body.isServerAdmin,
  });
  return json(created, { status: 201 });
});
