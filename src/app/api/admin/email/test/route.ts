import { json, requireAuth, route } from "@/lib/api/http";
import { requireServerAdmin } from "@/lib/auth/guard";
import { sendEmail } from "@/lib/email/mailer";

/** Sends a test email to the signed-in server admin. */
export const POST = route(async (request) => {
  const auth = await requireAuth(request);
  requireServerAdmin(auth);
  await sendEmail({
    to: auth.user.email,
    subject: "Tohyee: test email",
    text: "This is a test email from your Tohyee server. Email is working: security alerts and two-step sign-in reset links will be sent from this address.",
  });
  return json({ sent: true, to: auth.user.email });
});
