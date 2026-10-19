import { calendarLinkFeed } from "@/lib/farming/calendar";

type Context = { params: Promise<{ organisationId: string; file: string }> };

/**
 * A member's private farm calendar link (FC22, FC23), for Google, Apple or
 * Outlook to subscribe to. No sign-in: the random token in the address is
 * what lets it in, so it's "not found" alike for every refusal.
 */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { organisationId, file } = await context.params;
  const feed = await calendarLinkFeed(organisationId, file);
  if (feed === null) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(feed, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="farm-calendar.ics"',
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}
