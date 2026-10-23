import { NextResponse } from "next/server";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { officeAddressesFor, officeClientMetadata } from "@/lib/office/addin";

/**
 * The PowerPoint add-in's OAuth client ID metadata document (#429, decision
 * 834): public, like any app's. Tohyee itself knows the add-in without
 * reading this; it's here so the add-in's client_id is a real address, as
 * the client ID metadata document draft says. 404 while remote access is off.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const addresses = officeAddressesFor(await remoteAccessAddress());
  if (!addresses) return NextResponse.json({ error: "Remote access is off, so the PowerPoint add-in isn't available on this Tohyee." }, { status: 404 });
  return NextResponse.json(officeClientMetadata(addresses), { headers: { "cache-control": "public, max-age=3600" } });
}
