import { cookies, headers } from "next/headers";
import { remoteWithoutTwoStep } from "@/lib/auth/remote";
import { getSessionState, getSessionUser, SESSION_COOKIE } from "@/lib/auth/sessions";

/** Fully signed-in session for server components and layouts (reads the cookie). None through remote access without two-step (#208). */
export async function getPageSession() {
  if (remoteWithoutTwoStep(await headers())) return null;
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value ?? null);
}

/** Any session, including one part-way through two-step sign-in. */
export async function getPageSessionState() {
  if (remoteWithoutTwoStep(await headers())) return null;
  const store = await cookies();
  return getSessionState(store.get(SESSION_COOKIE)?.value ?? null);
}
