"use client";

import Link from "next/link";
import { ui } from "@/components/ui";

/** Settings › Email's two parts (decision 1391): the sending account, and the templates each email starts with. */
export function EmailTabs({ current }: { current: "account" | "templates" }) {
  const tabs = [
    { key: "account", href: "/operations/settings/email", label: "Account" },
    { key: "templates", href: "/operations/settings/email/templates", label: "Templates" },
  ] as const;
  return (
    <nav className={ui.tabs} aria-label="Email settings">
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} className={`${ui.tab} ${current === tab.key ? ui.tabActive : ""}`} aria-current={current === tab.key ? "page" : undefined}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
