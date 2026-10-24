import { ForbiddenError, UnavailableError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { DEMO_REFUSED_MESSAGE } from "@/lib/demo/switch";

/*
 * What the demo farm won't do (#437, decision 858): anything that reaches
 * outside Tohyee. Sending email (documents, statements, payslips, CRM
 * emails, tests), connecting or checking mailboxes, bank and payment feeds,
 * Payday filing and online sales platforms, and adding other people. Reading
 * those pages still works; only changes are refused. The scheduled jobs are
 * paused for it as well (jobs_paused_at), so nothing runs by itself either.
 */

const REFUSED: RegExp[] = [
  /^\/api\/email\/(settings|microsoft|google|documents|statements)(\/|$)/,
  /^\/api\/bank-feeds\//,
  /^\/api\/bank-file-feeds\//,
  /^\/api\/bank-accounts\/[^/]+\/(feed|file-feeds|paypal|wise|stripe|simplefin)(\/|$)/,
  /^\/api\/bills\/inbox\/(mailboxes|mail-folders)(\/|$)/,
  /^\/api\/crm\/(mail|lead-mailboxes)(\/|$)/,
  /^\/api\/crm\/emails$/,
  /^\/api\/crm\/sequences(\/|$)/,
  /^\/api\/payroll\/pay-runs\/[^/]+\/(payday-filing|payslips)(\/|$)/,
  /^\/api\/payroll\/payday-filing-settings(\/|$)/,
  /^\/api\/online-payments\//,
  /^\/api\/my-mail(\/|$)/,
  /^\/api\/farming\/mail(\/|$)/,
  /^\/api\/sales-platforms\//,
  /^\/api\/organisations\/[^/]+\/analytics\/report-emails(\/|$)/,
  /^\/api\/organisations\/[^/]+\/(members|handover)(\/|$)/,
  /^\/api\/analytics\/(google|connections)(\/|$)/,
];

/** True when the demo farm refuses this request: a change (not a read) to one of the paths above. */
export function demoRefuses(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return REFUSED.some((pattern) => pattern.test(pathname));
}

/** Refuses what the demo farm doesn't do, and anything while it's still being made. Real organisations pass straight through. */
export function assertDemoAllows(request: Request, organisation: OrganisationRecord): void {
  if (!organisation.demo) return;
  if (organisation.demo.status !== "ready") throw new UnavailableError("The demo farm is still being made.");
  if (demoRefuses(request.method, new URL(request.url).pathname)) throw new ForbiddenError(DEMO_REFUSED_MESSAGE);
}

/** For services that send email whatever called them (document emails, payslips): refused for the demo farm. */
export function assertNotDemoForEmail(organisation: Pick<OrganisationRecord, "demo"> | null): void {
  if (organisation?.demo) throw new ForbiddenError(DEMO_REFUSED_MESSAGE);
}
