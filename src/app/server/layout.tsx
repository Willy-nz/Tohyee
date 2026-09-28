import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ServerShell } from "@/components/server-shell";
import { getPageSession } from "@/lib/auth/page-session";
import { twoStepRequired } from "@/lib/auth/sessions";
import { isLocalAdminRequest, SERVER_COMPUTER_ONLY } from "@/lib/server-admin/local";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

/**
 * Server settings: organisations, users, remote access, email and updates.
 * Kept apart from the books, and only open on the server computer itself,
 * through the local-only address (src/lib/server-admin/local.ts).
 */
export default async function ServerLayout({ children }: LayoutProps<"/server">) {
  if (!isLocalAdminRequest(await headers())) {
    return (
      <main style={{ maxWidth: 560, margin: "15vh auto", padding: "0 16px" }}>
        <h1>Server settings</h1>
        <p>{SERVER_COMPUTER_ONLY}</p>
        <p>
          <a href="/operations">Back to the books</a>
        </p>
      </main>
    );
  }
  const session = await getPageSession();
  if (!session) {
    redirect("/login?next=/server");
  }
  if (!session.user.isServerAdmin) {
    return (
      <main style={{ maxWidth: 560, margin: "15vh auto", padding: "0 16px" }}>
        <h1>Server settings</h1>
        <p>Only a server admin can change the server settings. You&apos;re signed in as {session.user.email}.</p>
        <p>
          <a href="/operations">Back to the books</a>
        </p>
      </main>
    );
  }
  const warnings = twoStepRequired()
    ? []
    : [
        "Two-step sign-in is off: this server has no TOHYEE_SECRET_KEY, so people sign in with a password only. Set it (32+ random characters) in the server's environment and restart Tohyee before letting anyone in from outside your network. The Windows installer sets it when you update.",
      ];
  return (
    <ServerShell user={session.user} warnings={warnings}>
      {children}
    </ServerShell>
  );
}
