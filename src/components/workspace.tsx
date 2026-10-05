"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { type Role, roleAtLeast } from "@/lib/auth/roles";

export type WorkspaceUser = {
  id: string;
  email: string;
  displayName: string;
  isServerAdmin: boolean;
};

export type WorkspaceOrganisation = {
  id: string;
  displayName: string;
  baseCurrency: string;
  role: Role;
  status: string;
};

type Workspace = {
  user: WorkspaceUser;
  organisations: WorkspaceOrganisation[];
  current: WorkspaceOrganisation | null;
  selectOrganisation(id: string): void;
  /** True if the signed-in user has at least this role in the current organisation. */
  can(role: Role): boolean;
  /** Where server settings open on the server computer (for server admins); null if they're off. */
  serverSettingsUrl: string | null;
};

const WorkspaceContext = createContext<Workspace | null>(null);
const STORAGE_KEY = "tohyee.currentOrganisation";
const listeners = new Set<() => void>();

/**
 * Each tab keeps its own organisation (#143, Jess, 5 Oct 2026): this tab's
 * choice is in sessionStorage; localStorage only holds the last one chosen,
 * which a new tab starts on. Switching in another tab doesn't change this
 * one, so a half-filled form can't end up in another organisation.
 */
function readStoredOrganisation(): string | null {
  try {
    const own = window.sessionStorage.getItem(STORAGE_KEY);
    if (own) return own;
    // A new tab starts on the last one chosen, then keeps it whatever other tabs do.
    const last = window.localStorage.getItem(STORAGE_KEY);
    if (last) window.sessionStorage.setItem(STORAGE_KEY, last);
    return last;
  } catch {
    return null;
  }
}

/** Only this tab's own switches: no "storage" events from other tabs. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function WorkspaceProvider({
  user,
  organisations,
  serverSettingsUrl = null,
  children,
}: {
  user: WorkspaceUser;
  organisations: WorkspaceOrganisation[];
  serverSettingsUrl?: string | null;
  children: ReactNode;
}) {
  const storedId = useSyncExternalStore(subscribe, readStoredOrganisation, () => null);
  const current =
    organisations.find((organisation) => organisation.id === storedId) ?? organisations[0] ?? null;

  const selectOrganisation = useCallback((id: string) => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, id);
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private mode etc.: selection just won't persist.
    }
    listeners.forEach((listener) => listener());
  }, []);

  const value = useMemo<Workspace>(
    () => ({
      user,
      organisations,
      current,
      selectOrganisation,
      can: (role: Role) => (current ? roleAtLeast(current.role, role) : false),
      serverSettingsUrl,
    }),
    [user, organisations, current, selectOrganisation, serverSettingsUrl],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider.");
  }
  return workspace;
}
