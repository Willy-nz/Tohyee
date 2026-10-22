import { NextResponse } from "next/server";
import { RequestLimiter } from "@/lib/ai/limits";
import { startAuthorization } from "@/lib/ai/oauth/authorize";
import { route } from "@/lib/api/http";
import { returnOrigin } from "@/lib/auth/origin";
import { sessionMetaFrom } from "@/lib/auth/sessions";

/**
 * Where an AI app sends the person's browser to sign in (#427, decisions
 * 813, 814). Checks the request, keeps it for the consent screen and sends
 * the browser there (through sign-in when needed); a wrong app or redirect
 * address gets Tohyee's own page, other mistakes go back to the app.
 */
export const dynamic = "force-dynamic";

const limiter = new RequestLimiter(30);

export const GET = route(async (request) => {
  const origin = await returnOrigin(request);
  const address = sessionMetaFrom(request).ipAddress;
  if (address && !limiter.take(address)) return NextResponse.redirect(`${origin}/connect/problem?reason=busy`, 303);
  const result = await startAuthorization(request);
  if (result.kind === "problem") return NextResponse.redirect(`${origin}/connect/problem?reason=${result.problem}`, 303);
  if (result.kind === "redirect") return NextResponse.redirect(result.location, 303);
  const response = NextResponse.redirect(`${origin}${result.location}`, 303);
  response.headers.set("set-cookie", result.cookie);
  response.headers.set("cache-control", "no-store");
  return response;
});
