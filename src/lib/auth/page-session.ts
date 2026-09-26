import { cookies } from "next/headers";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth/sessions";

/** Session for server components and layouts (reads the cookie). */
export async function getPageSession() {
  const store = await cookies();
  return getSessionUser(store.get(SESSION_COOKIE)?.value ?? null);
}
