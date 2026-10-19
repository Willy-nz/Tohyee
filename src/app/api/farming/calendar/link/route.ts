import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { requestOrigin } from "@/lib/crm/mail/origin";
import { calendarLinkStatus, makeCalendarLink, turnOffCalendarLink } from "@/lib/farming/calendar";

/** GET ?organisationId=: whether the member has a calendar link (FC22). The link itself is only shown when made. */
export const GET = route(async (request) => {
  const link = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => calendarLinkStatus(tx));
  return json({ link });
});

/** POST: makes a new link, stopping any earlier one (FC22). Body: { organisationId }. Returns its address, once. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const origin = await requestOrigin(request);
  const link = await withOrganisation(request, body.organisationId, "viewer", (tx) => makeCalendarLink(tx, origin));
  return json({ link });
});

/** DELETE ?organisationId=: turns the link off (FC23). */
export const DELETE = route(async (request) => {
  const link = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", (tx) => turnOffCalendarLink(tx));
  return json({ link });
});
