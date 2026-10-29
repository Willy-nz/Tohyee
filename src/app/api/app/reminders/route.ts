import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { deviceReminders } from "@/lib/native/device-reminders";
import type { DeviceRemindersResponse } from "@/lib/native/reminders-shared";

/**
 * GET ?organisationId=: the signed-in person's reminders for the Android
 * app to schedule on the phone (#502, decisions 1146-1148). Farm records
 * role (Farm staff, viewer or higher), only farms they work on.
 */
export const GET = route(async (request) => {
  const organisationId = searchParams(request).get("organisationId");
  const reminders = await withFarmWork(request, organisationId, "read", (tx) => deviceReminders(tx, String(organisationId)));
  const body: DeviceRemindersResponse = { organisationId: String(organisationId), generatedAt: new Date().toISOString(), reminders };
  return json(body);
});
