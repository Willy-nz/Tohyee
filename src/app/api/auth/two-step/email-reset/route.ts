import { json, route } from "@/lib/api/http";
import { assertSameOrigin, authenticateAnyStage } from "@/lib/auth/guard";
import { publicOrigin } from "@/lib/auth/origin";
import { emailTwoStepReset } from "@/lib/auth/two-step";

/** Emails a link to reset two-step sign-in (phone and backup codes lost). Only after the password. */
export const POST = route(async (request) => {
  assertSameOrigin(request);
  const state = await authenticateAnyStage(request);
  await emailTwoStepReset(state, await publicOrigin(request));
  return json({ sent: true });
});
