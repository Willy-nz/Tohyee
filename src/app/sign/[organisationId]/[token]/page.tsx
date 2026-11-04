import type { Metadata } from "next";
import { SignPage } from "@/components/signing/sign-page";

export const metadata: Metadata = { title: "Sign a document", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** A signer's page (decisions 1396-1410), opened from the emailed link. No Tohyee login. */
export default async function SigningLinkPage({ params }: PageProps<"/sign/[organisationId]/[token]">) {
  const { organisationId, token } = await params;
  return <SignPage organisationId={organisationId} token={token} />;
}
