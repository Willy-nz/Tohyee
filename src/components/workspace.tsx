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
};

const WorkspaceContext = createContext<Workspace | null>(null);
const STORAGE_KEY = "tohyee.currentOrganisation";
const listeners = new Set<() => void>();

function readStoredOrganisation(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function WorkspaceProvider({
  user,
  organisations,
  children,
}: {
  user: WorkspaceUser;
  organisations: WorkspaceOrganisation[];
  children: ReactNode;
}) {
  const storedId = useSyncExternalStore(subscribe, readStoredOrganisation, () => null);
  const current =
    organisations.find((organisation) => organisation.id === storedId) ?? organisations[0] ?? null;

  const selectOrganisation = useCallback((id: string) => {
    try {
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
    }),
    [user, organisations, current, selectOrganisation],
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
