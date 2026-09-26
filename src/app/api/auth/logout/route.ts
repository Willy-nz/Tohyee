import { json, route } from "@/lib/api/http";
import { assertSameOrigin } from "@/lib/auth/guard";
import {
  clearSessionCookieHeader,
  deleteSession,
  hashSessionToken,
  readCookie,
  SESSION_COOKIE,
} from "@/lib/auth/sessions";

export const POST = route(async (request) => {
  assertSameOrigin(request);
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    await deleteSession(hashSessionToken(token));
  }
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookieHeader(request) } });
});
