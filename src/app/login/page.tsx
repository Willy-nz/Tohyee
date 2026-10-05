import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { configuredOrigin } from "@/lib/auth/origin";
import { getPageSessionState } from "@/lib/auth/page-session";
import { needsSetup } from "@/lib/auth/service";
import { emailConfigured } from "@/lib/email/mailer";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

/** Where to go after signing in: only Tohyee's own pages, never another site. */
function safeNext(value: string | string[] | undefined): string {
  const next = typeof value === "string" ? value : "";
  return /^\/(operations|server)(\/[A-Za-z0-9_\-/]*)?$/.test(next) ? next : "/operations";
}

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await needsSetup()) {
    redirect("/setup");
  }
  const next = safeNext((await searchParams).next);
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
  return <LoginForm next={next} />;
}
