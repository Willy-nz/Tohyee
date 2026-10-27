import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { configuredOrigin } from "@/lib/auth/origin";
import { googleSignInMessage, safeNextPath } from "@/lib/auth/google-messages";
import { googleSignInAvailable } from "@/lib/auth/google-sign-in";
import { passkeySignInOffer, requestFromHeaders } from "@/lib/auth/passkeys";
import { getPageSessionState } from "@/lib/auth/page-session";
import { needsSetup } from "@/lib/auth/service";
import { emailConfigured } from "@/lib/email/mailer";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await needsSetup()) {
    redirect("/setup");
  }
  const params = await searchParams;
  // Where to go after signing in: only Tohyee's own pages, never another site.
  const next = safeNextPath(params.next);
  const state = await getPageSessionState();
  if (state && state.stage === "full" && !state.pending) {
    redirect(next);
  }
  if (state && (state.stage === "verify" || state.stage === "enrol")) {
    return (
      <LoginForm
        next={next}
        initialStage={state.stage}
        initialEmail={state.user.email}
        emailResetAvailable={state.stage === "verify" && (await emailConfigured()) && (await configuredOrigin()) !== null}
      />
    );
  }
  // Passkeys only where they work (#450): Tohyee's web address, or localhost.
  const passkeys = await passkeySignInOffer(requestFromHeaders(await headers(), "/login"));
  // Only a fixed message for a known code from the Google callback (#424), never text from the address.
  return (
    <LoginForm
      next={next}
      googleAvailable={await googleSignInAvailable()}
      googleMessage={googleSignInMessage(params.google)}
      passkeyAvailable={passkeys.available}
      passkeyProblem={passkeys.problem}
    />
  );
}
