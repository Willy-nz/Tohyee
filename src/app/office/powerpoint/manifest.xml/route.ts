import { NextResponse } from "next/server";
import packageJson from "../../../../../package.json";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { officeAddressesFor, officeManifestXml } from "@/lib/office/addin";

/**
 * The PowerPoint add-in's manifest for this server (#429, decision 832),
 * downloaded from Settings › PowerPoint add-in, or read by Microsoft 365
 * from this address. It only holds this server's public addresses, so it's
 * public too (Microsoft 365 can't sign in to fetch it). Only while remote
 * access is on with an https address (decision 831): otherwise 404.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const addresses = officeAddressesFor(await remoteAccessAddress());
  if (!addresses) return NextResponse.json({ error: "Remote access is off, so there's no PowerPoint add-in to install. A server admin can turn it on in the Tohyee server app." }, { status: 404 });
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(officeManifestXml(addresses, packageJson.version), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "no-cache",
      ...(download ? { "content-disposition": 'attachment; filename="tohyee-powerpoint-addin.xml"' } : {}),
    },
  });
}
