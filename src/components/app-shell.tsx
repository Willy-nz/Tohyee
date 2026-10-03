"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type AppKey, AppSwitcher } from "@/components/app-switcher";
import { BrandMark } from "@/components/brand-mark";
import { CommandPalette } from "@/components/command-palette";
import { type Modules, useModules } from "@/components/modules";
import {
  AI_LINK,
  type Destination,
  destinations,
  inArea,
  isCurrent,
  type Menu,
  type MenuGroup,
  visibleMenus,
  visibleNewActions,
} from "@/components/navigation";
import { ThemeSwitch } from "@/components/theme";
import { ROLE_LABELS } from "@/lib/auth/roles";
import styles from "./app-shell.module.css";
import {
  useWorkspace,
  type WorkspaceOrganisation,
  WorkspaceProvider,
  type WorkspaceUser,
} from "./workspace";

/** Closes a popover on Escape (returning focus to its button), an outside click, or focus moving away. */
function useDismiss(open: boolean, close: () => void, container: RefObject<HTMLElement | null>, button: () => HTMLElement | null) {
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (container.current && !container.current.contains(event.target as Node)) close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
        button()?.focus();
      }
    }
    function onFocus(event: FocusEvent) {
      if (container.current && event.target instanceof Node && !container.current.contains(event.target)) close();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open, close, container, button]);
}

function Caret() {
  return (
    <svg className={styles.caret} width="10" height="10" viewBox="0 0 10 10" aria-hidden focusable="false">
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M8 1.5c.4 2.9 1.6 4.1 4.5 4.5-2.9.4-4.1 1.6-4.5 4.5-.4-2.9-1.6-4.1-4.5-4.5 2.9-.4 4.1-1.6 4.5-4.5ZM12.5 10c.2 1.4.8 2 2.2 2.2-1.4.2-2 .8-2.2 2.2-.2-1.4-.8-2-2.2-2.2 1.4-.2 2-.8 2.2-2.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** A dropdown's links, arranged as labelled columns. */
function MenuPanel({
  id,
  groups,
  pathname,
  search,
  onNavigate,
  label,
  align = "start",
}: {
  id: string;
  groups: MenuGroup[];
  pathname: string;
  search: URLSearchParams;
  onNavigate: () => void;
  label: string;
  align?: "start" | "end";
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Keep the panel inside the window: wide panels near the right edge shift left.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    if (getComputedStyle(element).position === "fixed") return;
    const rect = element.getBoundingClientRect();
    const overflow = rect.right - (window.innerWidth - 12);
    if (overflow > 0) element.style.setProperty("translate", `-${Math.min(overflow, Math.max(0, rect.left - 12))}px 0`);
    else if (rect.left < 12) element.style.setProperty("translate", `${12 - rect.left}px 0`);
  }, []);
  return (
    <div
      id={id}
      ref={panel}
      className={`${styles.dropdown} ${align === "end" ? styles.dropdownEnd : ""}`}
      style={{ gridTemplateColumns: `repeat(${Math.min(groups.length, 4)}, minmax(176px, auto))` }}
      aria-label={label}
      role="group"
    >
      {groups.map((group) => (
        <div key={group.heading} className={styles.dropdownGroup} role="group" aria-labelledby={`${id}-${group.heading}`}>
          <div className={styles.dropdownHeading} id={`${id}-${group.heading}`}>
            {group.heading}
          </div>
          {group.links.map((link) => {
            const current = isCurrent(pathname, search, link.href);
            return (
              <Link
                key={`${link.href}|${link.label}`}
                href={link.href}
                className={`${styles.dropdownLink} ${current ? styles.dropdownLinkActive : ""}`}
                aria-current={current ? "page" : undefined}
                onClick={onNavigate}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DesktopMenus({ menus }: { menus: Menu[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const bar = useRef<HTMLElement>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const idPrefix = useId();
  const close = useCallback(() => setOpen(null), []);
  const openButton = useCallback(() => (open ? (buttons.current[open] ?? null) : null), [open]);
  useDismiss(open !== null, close, bar, openButton);

  return (
    <nav aria-label="Main" className={styles.menuBar} ref={bar}>
      {menus.map((menu) => {
        const active = inArea(pathname, menu);
        if (menu.href) {
          return (
            <Link
              key={menu.label}
              href={menu.href}
              className={`${styles.menuButton} ${active ? styles.menuButtonActive : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={close}
            >
              {menu.label}
            </Link>
          );
        }
        const panelId = `${idPrefix}-${menu.label}`;
        const isOpen = open === menu.label;
        return (
          <div key={menu.label} className={styles.menu}>
            <button
              type="button"
              ref={(element) => {
                buttons.current[menu.label] = element;
              }}
              className={`${styles.menuButton} ${active ? styles.menuButtonActive : ""}`}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen(isOpen ? null : menu.label)}
            >
              {menu.label}
              <Caret />
            </button>
            {isOpen ? (
              <MenuPanel
                id={panelId}
                label={menu.label}
                groups={menu.groups}
                pathname={pathname}
                search={search}
                onNavigate={close}
              />
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/** "+ New": every create action in one place (bookkeepers and up). */
function NewMenu({ groups }: { groups: MenuGroup[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  const focusButton = useCallback(() => button.current, []);
  useDismiss(open, close, wrap, focusButton);
  if (groups.length === 0) return null;
  return (
    <div className={styles.menu} ref={wrap}>
      <button
        type="button"
        ref={button}
        className={styles.newButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="New"
        onClick={() => setOpen((value) => !value)}
      >
        <PlusIcon />
        <span className={styles.newLabel}>New</span>
      </button>
      {open ? (
        <MenuPanel
          id={panelId}
          label="New"
          groups={groups}
          pathname={pathname}
          search={search}
          onNavigate={close}
          align="end"
        />
      ) : null}
    </div>
  );
}

function subscribeNothing() {
  return () => undefined;
}

/** "⌘K" on a Mac, "Ctrl K" elsewhere (Ctrl K until the browser says otherwise). */
function useShortcutLabel() {
  return useSyncExternalStore(
    subscribeNothing,
    () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K"),
    () => "Ctrl K",
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const { user, current } = useWorkspace();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  const focusButton = useCallback(() => button.current, []);
  useDismiss(open, close, wrap, focusButton);
  return (
    <div className={styles.menu} ref={wrap}>
      <button
        type="button"
        ref={button}
        className={styles.avatarButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${user.displayName}: profile, theme and sign out`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar} aria-hidden>
          {initials(user.displayName)}
        </span>
      </button>
      {open ? (
        <div id={panelId} className={`${styles.dropdown} ${styles.dropdownEnd} ${styles.userPanel}`} role="group" aria-label="Your account">
          <div className={styles.userSummary}>
            <div className={styles.userName}>{user.displayName}</div>
            <div className={styles.userEmail}>{user.email}</div>
            {current ? (
              <div className={styles.userEmail}>
                {ROLE_LABELS[current.role]} · {current.baseCurrency}
              </div>
            ) : null}
          </div>
          <Link href="/operations/profile" className={styles.dropdownLink} onClick={close}>
            Profile and two-step sign-in
          </Link>
          <div className={styles.userTheme}>
            <ThemeSwitch />
          </div>
          <button type="button" className={`${styles.dropdownLink} ${styles.signOut}`} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Phones and narrow windows: a ☰ button opens every section as a full-screen list. */
function PhoneMenu({ app, modules, menus, onSignOut }: { app: AppKey; modules: Modules | null; menus: Menu[]; onSignOut: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { user } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // The list opens under the top bar.
  const [top, setTop] = useState(56);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setExpanded(null);
  }

  return (
    <>
      <button
        type="button"
        className={`${styles.iconButton} ${styles.phoneMenuButton}`}
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={(event) => {
          if (open) {
            close();
            return;
          }
          const bar = event.currentTarget.closest("header");
          setTop(bar ? Math.round(bar.getBoundingClientRect().bottom) : 56);
          setOpen(true);
        }}
      >
        <span aria-hidden className={styles.phoneMenuGlyph}>
          {open ? "✕" : "☰"}
        </span>
      </button>
      {open ? (
        <div className={styles.phoneMenu} style={{ top }} role="dialog" aria-modal="true" aria-label="Menu">
          <div className={styles.phoneApps}>
            <AppSwitcher current={app} modules={modules} />
          </div>
          <nav aria-label="Main">
            {menus.map((menu) => {
              if (menu.href) {
                return (
                  <Link
                    key={menu.label}
                    href={menu.href}
                    className={styles.phoneSection}
                    aria-current={inArea(pathname, menu) ? "page" : undefined}
                    onClick={close}
                  >
                    {menu.label}
                  </Link>
                );
              }
              const isExpanded = expanded === menu.label || (expanded === null && inArea(pathname, menu));
              return (
                <div key={menu.label}>
                  <button
                    type="button"
                    className={styles.phoneSection}
                    aria-expanded={isExpanded}
                    onClick={() => setExpanded(isExpanded ? "" : menu.label)}
                  >
                    {menu.label}
                    <span aria-hidden className={isExpanded ? styles.phoneCaretOpen : styles.phoneCaret}>
                      <Caret />
                    </span>
                  </button>
                  {isExpanded ? (
                    <div className={styles.phoneGroups}>
                      {menu.groups.map((group) => (
                        <div key={group.heading}>
                          <div className={styles.phoneHeading}>{group.heading}</div>
                          {group.links.map((link) => (
                            <Link
                              key={`${link.href}|${link.label}`}
                              href={link.href}
                              className={`${styles.phoneLink} ${isCurrent(pathname, search, link.href) ? styles.phoneLinkActive : ""}`}
                              aria-current={isCurrent(pathname, search, link.href) ? "page" : undefined}
                              onClick={close}
                            >
                              {link.label}
                            </Link>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <Link
              href={AI_LINK.href}
              className={styles.phoneSection}
              aria-current={pathname === AI_LINK.href ? "page" : undefined}
              onClick={close}
            >
              {AI_LINK.label}
            </Link>
          </nav>
          <div className={styles.phoneFooter}>
            <div>
              <div className={styles.userName}>{user.displayName}</div>
              <div className={styles.userEmail}>{user.email}</div>
            </div>
            <Link href="/operations/profile" onClick={close}>
              Profile and two-step sign-in
            </Link>
            <ThemeSwitch />
            <button type="button" className={styles.linkButton} onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function OrganisationPicker() {
  const { organisations, current, selectOrganisation } = useWorkspace();
  if (organisations.length === 0) {
    return <span className={styles.orgMeta}>No organisations yet</span>;
  }
  return (
    <div className={styles.orgPicker}>
      <span className={styles.orgInitial} aria-hidden>
        {(current?.displayName ?? "?").trim().charAt(0).toUpperCase()}
      </span>
      <select
        id="organisation-picker"
        aria-label="Organisation"
        title={current ? `${current.displayName} · ${ROLE_LABELS[current.role]} · ${current.baseCurrency}` : undefined}
        value={current?.id ?? ""}
        onChange={(event) => selectOrganisation(event.target.value)}
      >
        {organisations.map((organisation) => (
          <option key={organisation.id} value={organisation.id}>
            {organisation.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A short fade and rise of the page on each navigation, so moving around doesn't feel abrupt. */
function usePageEntrance(target: RefObject<HTMLElement | null>, pathname: string) {
  useEffect(() => {
    const element = target.current;
    if (!element || typeof element.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 180, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
    return () => animation.cancel();
  }, [target, pathname]);
}

function TopBarActions({ newActions, onSearch, onSignOut }: { newActions: MenuGroup[]; onSearch: () => void; onSignOut: () => void }) {
  const pathname = usePathname();
  const shortcut = useShortcutLabel();
  const aiCurrent = pathname === AI_LINK.href || pathname.startsWith(`${AI_LINK.href}/`);
  return (
    <div className={styles.actions}>
      <NewMenu groups={newActions} />
      <button type="button" className={styles.searchButton} onClick={onSearch} aria-label={`Search (${shortcut})`} aria-keyshortcuts="Control+K Meta+K">
        <SearchIcon />
        <span className={styles.searchText}>Search</span>
        <kbd className={styles.kbd}>{shortcut}</kbd>
      </button>
      <Link
        href={AI_LINK.href}
        className={`${styles.aiLink} ${aiCurrent ? styles.aiLinkActive : ""}`}
        aria-current={aiCurrent ? "page" : undefined}
      >
        <SparkIcon />
        {AI_LINK.label}
      </Link>
      <div className={styles.desktopOnly}>
        <UserMenu onSignOut={onSignOut} />
      </div>
    </div>
  );
}

function Shell({ app, children, warnings }: { app: AppKey; children: ReactNode; warnings: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const { can, current } = useWorkspace();
  const modules = useModules(current?.id ?? null);
  const menus = useMemo(() => visibleMenus(app, { can, modules }), [app, can, modules]);
  const newActions = useMemo(() => visibleNewActions({ can, modules }), [can, modules]);
  const items = useMemo<Destination[]>(
    () =>
      destinations(menus, newActions, [
        { href: AI_LINK.href, label: "AI assistant", group: "AI" },
        { href: "/operations/profile", label: "Profile and two-step sign-in", group: "You" },
        ...(app !== "accounting" ? [{ href: "/operations", label: "Accounting", group: "Apps" }] : []),
        ...(app !== "crm" && modules?.crm ? [{ href: "/crm", label: "CRM", group: "Apps" }] : []),
        ...(app !== "analytics" && modules?.analytics ? [{ href: "/analytics", label: "Analytics", group: "Apps" }] : []),
      ]),
    [menus, newActions, app, modules],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  usePageEntrance(page, pathname);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink} data-print="hide">
        Skip to content
      </a>
      <header className={styles.topbar} data-print="hide">
        <div className={styles.topRow}>
          <Link href={app === "crm" ? "/crm" : app === "analytics" ? "/analytics" : "/operations"} className={styles.brand} aria-label="Tohyee home">
            <BrandMark size={26} className={styles.brandMark} />
            <span className={styles.brandText}>Tohyee</span>
          </Link>
          <div className={styles.desktopOnly}>
            <AppSwitcher current={app} modules={modules} />
          </div>
          <OrganisationPicker />
          <span className={styles.divider} aria-hidden />
          <Suspense fallback={<nav aria-label="Main" className={styles.menuBar} />}>
            <DesktopMenus menus={menus} />
          </Suspense>
          <Suspense fallback={<div className={styles.actions} />}>
            <TopBarActions newActions={newActions} onSearch={() => setPaletteOpen(true)} onSignOut={() => void signOut()} />
          </Suspense>
          <Suspense fallback={null}>
            <PhoneMenu app={app} modules={modules} menus={menus} onSignOut={() => void signOut()} />
          </Suspense>
        </div>
      </header>
      <main id="main-content" className={styles.content} tabIndex={-1}>
        {warnings.length > 0 ? (
          <div className={styles.warnings} data-print="hide">
            {warnings.map((warning) => (
              <div key={warning} role="alert" className={styles.serverWarning}>
                <span className={styles.warningIcon} aria-hidden>
                  !
                </span>
                <span>{warning}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div ref={page} className={styles.page}>
          {children}
        </div>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={items} />
    </div>
  );
}

export function AppShell({
  app = "accounting",
  user,
  organisations,
  serverSettingsUrl = null,
  warnings = [],
  children,
}: {
  /** Which app's top bar and menus to show. */
  app?: AppKey;
  user: WorkspaceUser;
  organisations: WorkspaceOrganisation[];
  /** Where server settings open on the server computer (passed for server admins). */
  serverSettingsUrl?: string | null;
  /** Server problems shown on every page (only passed for server admins). */
  warnings?: string[];
  children: ReactNode;
}) {
  return (
    <WorkspaceProvider user={user} organisations={organisations} serverSettingsUrl={serverSettingsUrl}>
      <Shell app={app} warnings={warnings}>
        {children}
      </Shell>
    </WorkspaceProvider>
  );
}
