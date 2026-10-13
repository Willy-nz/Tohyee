import { sendNotices } from "@/lib/email/notices";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import type { PeopleNames } from "@/lib/people/names";

/**
 * Sends the emails asking approvers to approve (AW3, AW12). Plain text, with
 * a link that needs signing in; nothing is approved from the email. The
 * approvals page always lists what's waiting, so a failed email never holds
 * anything up. The sending itself is shared with other notices.
 */
export function sendApprovalEmails(organisation: OrganisationRecord, people: PeopleNames, now = new Date()): Promise<{ sent: number; failed: number; waiting: number }> {
  return sendNotices("approval_emails", organisation, people, now);
}
