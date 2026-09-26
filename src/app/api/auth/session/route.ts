import { json, route } from "@/lib/api/http";
import { authenticate } from "@/lib/auth/guard";
import { listMembershipsForUser } from "@/lib/organisations/registry";

/** The signed-in user and the organisations they can open. */
export const GET = route(async (request) => {
  const auth = await authenticate(request);
  const memberships = await listMembershipsForUser(auth.user.id);
  return json({
    user: auth.user,
    organisations: memberships.map(({ organisation, role }) => ({
      id: organisation.id,
      displayName: organisation.displayName,
      baseCurrency: organisation.baseCurrency,
      role,
      status:
        organisation.provisioningStatus !== "ready"
          ? organisation.provisioningStatus
          : organisation.migrationStatus === "current"
            ? "ready"
            : organisation.migrationStatus,
    })),
  });
});
