import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ConnectConsent } from "@/components/auth/connect-consent";
import { consentDetails, isConnectHandle, OAUTH_BROWSER_COOKIE } from "@/lib/ai/oauth/authorize";
import { getPageSession } from "@/lib/auth/page-session";

// Reads the session and the request on every visit; never prerender.
export const dynamic = "force-dynamic";

/**
 * The consent screen for an AI app signing in (#427, decision 819). Not
 * signed in: Tohyee's normal sign-in first (password and two-step, or
 * Google), then back here.
 */
export default async function ConnectPage({ params }: PageProps<"/connect/[handle]">) {
  const { handle } = await params;
  if (!isConnectHandle(handle)) redirect("/connect/problem?reason=expired");
  const session = await getPageSession();
  if (!session) redirect(`/login?next=/connect/${handle}`);
  const details = await consentDetails(session, handle, (await cookies()).get(OAUTH_BROWSER_COOKIE)?.value ?? null);
  if (!details) redirect("/connect/problem?reason=expired");
  return <ConnectConsent handle={handle} details={details} />;
}
