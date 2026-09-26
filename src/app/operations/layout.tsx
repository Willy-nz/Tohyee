import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getPageSession } from "@/lib/auth/page-session";
import { listMembershipsForUser } from "@/lib/organisations/registry";

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
  return (
    <AppShell user={session.user} organisations={organisations}>
      {children}
    </AppShell>
  );
}
