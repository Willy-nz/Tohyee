import { json, route } from "@/lib/api/http";
import { assertSameOrigin, authenticateAnyStage } from "@/lib/auth/guard";
import { configuredOrigin } from "@/lib/auth/origin";
import { emailTwoStepReset } from "@/lib/auth/two-step";
import { ConflictError } from "@/lib/errors";

/**
 * Emails a link to reset two-step sign-in (phone and backup codes lost). Only after the password.
 * The link only ever uses the server's configured public address, never the request's Host header,
 * so a forged request can't make the email point somewhere else (#131, Jess, 5 Oct 2026). Without
 * one (a server only reached on the local network), a server admin resets two-step instead.
 */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const state = await authenticateAnyStage(request);
  const origin = await configuredOrigin();
  if (!origin) {
    throw new ConflictError(
      "This server has no public address set (Settings › Remote access), so it can't email a reset link. Ask a server admin to reset your two-step sign-in.",
    );
  }
  await emailTwoStepReset(state, origin);
  return json({ sent: true });
});
