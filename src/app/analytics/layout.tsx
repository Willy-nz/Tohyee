import { AppShell } from "@/components/app-shell";
import { loadPageWorkspace } from "@/lib/auth/page-workspace";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

/** Analytics is its own app (decision 353): the same sign-in and organisations, its own top bar. */
export default async function AnalyticsLayout({ children }: LayoutProps<"/analytics">) {
  const workspace = await loadPageWorkspace();
  return (
    <AppShell app="analytics" {...workspace}>
      {children}
    </AppShell>
  );
}
