import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getPageSessionState } from "@/lib/auth/page-session";
import { needsSetup } from "@/lib/auth/service";
import { emailConfigured } from "@/lib/email/mailer";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await needsSetup()) {
    redirect("/setup");
  }
  const state = await getPageSessionState();
  if (state && state.stage === "full" && !state.pending) {
    redirect("/operations");
  }
  if (state && (state.stage === "verify" || state.stage === "enrol")) {
    return (
      <LoginForm
        initialStage={state.stage}
        initialEmail={state.user.email}
        emailResetAvailable={state.stage === "verify" && (await emailConfigured())}
      />
    );
  }
  return <LoginForm />;
}
