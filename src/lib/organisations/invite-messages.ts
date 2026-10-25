import { ROLE_LABELS, type Role } from "@/lib/auth/roles";

/** What the server gives back from inviting someone (#441); see InvitationLink in members.ts. */
export type InvitationOutcome = { emailed: boolean; url: string | null; localOnly: boolean; expiresAt: string };

/**
 * What People and roles says after Invite or Resend. Kept here (no server
 * code) so the page and its unit test share it.
 */
export function invitationMessage(
  action: "invite" | "resend",
  email: string,
  role: Role | null,
  invitation: InvitationOutcome | null,
): { tone: "success" | "warning"; text: string } {
  if (!invitation) {
    // They already had a login: added, as before (nothing is sent).
    return { tone: "success", text: `Added ${email}${role ? ` as ${ROLE_LABELS[role].toLowerCase()}` : ""}.` };
  }
  const lead = action === "invite" ? `Invited ${email}${role ? ` as ${ROLE_LABELS[role].toLowerCase()}` : ""}.` : `Sent ${email} a new invitation. The last link no longer works.`;
  if (invitation.emailed) return { tone: "success", text: `${lead} We've emailed them a link to set up their login.` };
  if (invitation.url) return { tone: "warning", text: `${lead} This server can't send email, so copy the link below and send it to them yourself.` };
  return {
    tone: "warning",
    text: `${lead} The email couldn't be sent. Ask a server admin to set up email sending, or to send them a setup link from Users.`,
  };
}
