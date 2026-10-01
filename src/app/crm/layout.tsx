import { AppShell } from "@/components/app-shell";
import { loadPageWorkspace } from "@/lib/auth/page-workspace";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

/** The CRM is its own app: the same sign-in and organisations, its own top bar and tabs. */
export default async function CrmLayout({ children }: LayoutProps<"/crm">) {
  const workspace = await loadPageWorkspace();
  return (
    <AppShell app="crm" {...workspace}>
      {children}
    </AppShell>
  );
}
