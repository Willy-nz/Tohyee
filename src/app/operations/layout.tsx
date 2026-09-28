import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getPageSession } from "@/lib/auth/page-session";
import { twoStepRequired } from "@/lib/auth/sessions";
import { listMembershipsForUser } from "@/lib/organisations/registry";
import { localAdminUrl } from "@/lib/server-admin/local";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function OperationsLayout({ children }: LayoutProps<"/operations">) {
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
  const warnings =
    session.user.isServerAdmin && !twoStepRequired()
      ? [
          "Two-step sign-in is off: this server has no TOHYEE_SECRET_KEY, so people sign in with a password only. Set it (32+ random characters) in the server's environment and restart Tohyee before letting anyone in from outside your network. The Windows installer sets it when you update.",
        ]
      : [];
  return (
    <AppShell
      user={session.user}
      organisations={organisations}
      serverSettingsUrl={session.user.isServerAdmin ? localAdminUrl() : null}
      warnings={warnings}
    >
      {children}
    </AppShell>
  );
}
