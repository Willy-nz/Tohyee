import { cookies } from "next/headers";
import { getSessionState, getSessionUser, SESSION_COOKIE } from "@/lib/auth/sessions";

/** Fully signed-in session for server components and layouts (reads the cookie). */
export async function getPageSession() {
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value ?? null);
}

/** Any session, including one part-way through two-step sign-in. */
export async function getPageSessionState() {
  const store = await cookies();
  return getSessionState(store.get(SESSION_COOKIE)?.value ?? null);
}
