import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { createOrganisation, listAllOrganisations } from "@/lib/organisations/admin";

/** Every organisation on this server (server admins only). */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ organisations: await listAllOrganisations() });
});

/** Creates an organisation and its own database. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const organisation = await createOrganisation(auth.user, {
    id: body.id,
    displayName: body.displayName,
    baseCurrency: body.baseCurrency,
    ownerEmail: body.ownerEmail,
  });
  return json({ organisation }, { status: 201 });
});
