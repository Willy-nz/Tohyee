import { json, route } from "@/lib/api/http";
import { authenticateAnyStage } from "@/lib/auth/guard";
import { configuredOrigin } from "@/lib/auth/origin";
import { getTwoStepStatus } from "@/lib/auth/two-step";
import { emailConfigured } from "@/lib/email/mailer";

/** Where this session is up to in signing in, and the user's two-step status. */
export const GET = route(async (request) => {
  const state = await authenticateAnyStage(request);
  const status = await getTwoStepStatus(state.user.id);
  return json({
    stage: state.pending && state.stage === "full" ? "signed_out" : state.stage,
    email: state.user.email,
    status,
    // Needs email and the server's public address for the link (#131).
    emailResetAvailable: state.stage === "verify" && (await emailConfigured()) && (await configuredOrigin()) !== null,
  });
});
