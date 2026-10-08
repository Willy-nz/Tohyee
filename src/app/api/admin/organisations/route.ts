import { json, readJson, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { createOrganisation, listAllOrganisations } from "@/lib/organisations/admin";
import { applyInitialModules, parseInitialModules } from "@/lib/organisations/initial-modules";

/** Every organisation on this server (server admins only). */
export const GET = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  return json({ organisations: await listAllOrganisations() });
});

/**
 * Creates an organisation and its own database, with `modules` ({ accounting,
 * gstRegistered, crm, analytics }) chosen for it (#181). If the database
 * isn't ready yet, the modules keep their defaults and can be set later.
 */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth, request);
  const body = await readJson(request);
  const modules = parseInitialModules(body.modules);
  const organisation = await createOrganisation(auth.user, {
    id: body.id,
    displayName: body.displayName,
    baseCurrency: body.baseCurrency,
    ownerEmail: body.ownerEmail,
  });
  let modulesNote: string | null = null;
  if (modules) {
    if (organisation.provisioningStatus === "ready") {
      await applyInitialModules(organisation, modules, { userId: auth.user.id, email: auth.user.email });
    } else {
      modulesNote = "The organisation's database isn't ready, so its modules weren't set. Set them under Modules once it's repaired.";
    }
  }
  return json({ organisation, modulesNote }, { status: 201 });
});
