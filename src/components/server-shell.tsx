"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { BrandMark } from "./brand-mark";
import styles from "./server-shell.module.css";
import { ThemeSwitch } from "./theme";
import { WorkspaceProvider, type WorkspaceUser } from "./workspace";

const LINKS = [
  { href: "/server/organisations", label: "Organisations" },
  { href: "/server/users", label: "Users" },
  { href: "/server/remote-access", label: "Remote access" },
  { href: "/server/email", label: "Email" },
  { href: "/server/updates", label: "Updates" },
];

/** The server settings area: no accounting here, only the server itself. */
export function ServerShell({ user, warnings, children }: { user: WorkspaceUser; warnings: string[]; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login?next=/server");
    router.refresh();
  }

  return (
    <WorkspaceProvider user={user} organisations={[]}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <BrandMark size={26} className={styles.brandMark} />
            Tohyee
            <span className={styles.serverTag}>Server</span>
          </div>
          <nav aria-label="Server settings" className={styles.nav}>
            {LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link key={link.href} href={link.href} className={`${styles.link} ${active ? styles.active : ""}`} aria-current={active ? "page" : undefined}>
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className={styles.user}>
            <div className={styles.theme}>
              <ThemeSwitch />
            </div>
            <span className={styles.email}>{user.email}</span>
            <button type="button" className={styles.signOut} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <main id="main-content" className={styles.content}>
          <p className={styles.note}>
            These settings are for the whole server, and open only on this computer. The books are at{" "}
            <a href="/operations">Tohyee</a>.
          </p>
          {warnings.map((warning) => (
            <div key={warning} role="alert" className={styles.warning}>
              <span className={styles.warningIcon} aria-hidden>
                !
              </span>
              <span>{warning}</span>
            </div>
          ))}
          {children}
        </main>
      </div>
    </WorkspaceProvider>
  );
}
