import { redirect } from "next/navigation";
import { getPageSession } from "@/lib/auth/page-session";
import { twoStepRequired } from "@/lib/auth/sessions";
import { BACKUP_KEY_REMINDER, backupKeyNeedsSaving } from "@/lib/backups/key";
import { listMembershipsForUser } from "@/lib/organisations/registry";
import { localAdminUrl } from "@/lib/server-admin/local";

/**
 * What the app shells (Accounting and the CRM) need for a signed-in page:
 * the user, their organisations and roles, and server warnings for server
 * admins. Sends anyone not fully signed in to the sign-in page.
 */
export async function loadPageWorkspace() {
  const session = await getPageSession();
  if (!session) {
    redirect("/login");
  }
  const memberships = await listMembershipsForUser(session.user.id);
  const organisations = memberships.map(({ organisation, role }) => ({
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
  }));
  const warnings: string[] = [];
  if (session.user.isServerAdmin && !twoStepRequired()) {
    warnings.push(
      "Two-step sign-in is off: this server has no TOHYEE_SECRET_KEY, so people sign in with a password only. Set it (32+ random characters) in the server's environment and restart Tohyee before letting anyone in from outside your network. The Windows installer sets it when you update.",
    );
  }
  if (session.user.isServerAdmin && (await backupKeyNeedsSaving())) {
    warnings.push(BACKUP_KEY_REMINDER);
  }
  return {
    user: session.user,
    organisations,
    serverSettingsUrl: session.user.isServerAdmin ? localAdminUrl() : null,
    warnings,
  };
}
