import { json, route } from "@/lib/api/http";
import { authenticate } from "@/lib/auth/guard";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { officeAddressesFor } from "@/lib/office/addin";

/**
 * GET: whether this server offers the PowerPoint add-in, and where its
 * manifest is (#429, decision 831), for Settings › PowerPoint add-in.
 * Signed in; nothing here is secret (the manifest itself is public).
 */
export const GET = route(async (request) => {
  await authenticate(request);
  const remoteAddress = await remoteAccessAddress();
  const addresses = officeAddressesFor(remoteAddress);
  return json({
    remoteAddress,
    available: addresses !== null,
    manifestUrl: addresses?.manifestUrl ?? null,
    contentUrl: addresses?.contentUrl ?? null,
  });
});
