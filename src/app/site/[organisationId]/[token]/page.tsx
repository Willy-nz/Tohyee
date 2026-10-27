import type { Metadata } from "next";
import { SiteSignIn } from "@/components/site-sign-in";

export const metadata: Metadata = { title: "Sign in on the farm", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * A farm's sign-in page for visitors and contractors without a Tohyee
 * login (#446, decisions 948-952), opened from the QR code at the gate.
 */
export default async function SiteSignInPage({ params }: PageProps<"/site/[organisationId]/[token]">) {
  const { organisationId, token } = await params;
  return <SiteSignIn organisationId={organisationId} token={token} />;
}
