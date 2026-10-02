import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ServerShell } from "@/components/server-shell";
import { getPageSession } from "@/lib/auth/page-session";
import { twoStepRequired } from "@/lib/auth/sessions";
import { BACKUP_KEY_REMINDER, backupKeyNeedsSaving } from "@/lib/backups/key";
import { isLocalAdminRequest, SERVER_COMPUTER_ONLY } from "@/lib/server-admin/local";
import { updateCheckState } from "@/lib/updates/update-checker";
import { summariseCheck } from "@/lib/updates/updates";

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
  if (await backupKeyNeedsSaving()) warnings.push(BACKUP_KEY_REMINDER);
  // Found by the daily check (decision 328).
  const update = summariseCheck(updateCheckState());
  if (update.updateAvailable && update.latestVersion) {
    warnings.push(
      `Tohyee v${update.latestVersion} is out (this server runs v${update.currentVersion}). ` +
        (process.platform === "win32"
          ? "Install it from the Tohyee server app: click the Tohyee icon by the clock, then Updates. It backs everything up first."
          : "See Updates for how to install it."),
    );
  }
  return (
    <ServerShell user={session.user} warnings={warnings}>
      {children}
    </ServerShell>
  );
}
