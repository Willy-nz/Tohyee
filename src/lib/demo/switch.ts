/*
 * The demo farm's one switch (#437, decision 866): on unless the server's
 * environment has TOHYEE_DEMO_FARM=off. Turning it off takes "Add demo
 * farm" off the server settings (#445) and refuses adding one; demo farms
 * already made stay until deleted.
 * Kept apart from the rest so pages can ask without loading the build.
 */

export const DEMO_FARM_NAME = "Kōwhai Dairies Ltd";

export const DEMO_JOBS_PAUSED_REASON = "The demo farm: made-up data, so nothing is ever sent, imported or connected.";

export const DEMO_OFF_MESSAGE = "The demo farm is turned off on this server.";

/** What the demo farm refuses (sending email, bank and IRD feeds, mailboxes and other connections). */
export const DEMO_REFUSED_MESSAGE =
  "This is the demo farm: its data is made up, so Tohyee doesn't send email, connect to banks, IRD or mailboxes, or import from other systems for it. Try it in your own organisation.";

export function demoFarmEnabled(): boolean {
  const value = process.env.TOHYEE_DEMO_FARM?.trim().toLowerCase();
  return !(value === "off" || value === "false" || value === "0" || value === "no");
}
