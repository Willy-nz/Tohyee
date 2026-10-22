import { createHash } from "node:crypto";

/*
 * Tohyee's PowerPoint add-in for Analytics (#429, decisions 830-849): the
 * addresses it lives at, its sign-in details as an OAuth app, and the
 * manifest PowerPoint installs it from. Pure, so it's unit tested on its
 * own. Everything is on the remote access (https) address and nowhere else
 * (decision 831): PowerPoint on the web and Microsoft 365 only load add-ins
 * from https, and the sign-in for apps is only offered there (decision 810).
 */

import { OFFICE_API_PATH, OFFICE_APP_NAME, OFFICE_CLIENT_PATH, OFFICE_CONTENT_PATH, OFFICE_MANIFEST_PATH, OFFICE_SIGNED_IN_PATH } from "@/lib/office/paths";

export { OFFICE_API_PATH, OFFICE_APP_NAME, OFFICE_CLIENT_PATH, OFFICE_CONTENT_PATH, OFFICE_MANIFEST_PATH, OFFICE_SIGNED_IN_PATH };

export type OfficeAddresses = {
  /** e.g. https://glimmers.tohyee.nz */
  origin: string;
  /** e.g. https://glimmers.tohyee.nz/api/office: what the add-in's tokens are bound to. */
  resource: string;
  /** The add-in's client_id: the address of its metadata document. */
  clientId: string;
  redirectUri: string;
  contentUrl: string;
  manifestUrl: string;
};

/** The add-in's addresses for a remote access address, or null when there's no https one. */
export function officeAddressesFor(remoteAddress: string | null): OfficeAddresses | null {
  if (!remoteAddress) return null;
  let url: URL;
  try {
    url = new URL(remoteAddress);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const origin = url.origin;
  return {
    origin,
    resource: `${origin}${OFFICE_API_PATH}`,
    clientId: `${origin}${OFFICE_CLIENT_PATH}`,
    redirectUri: `${origin}${OFFICE_SIGNED_IN_PATH}`,
    contentUrl: `${origin}${OFFICE_CONTENT_PATH}`,
    manifestUrl: `${origin}${OFFICE_MANIFEST_PATH}`,
  };
}

/** The add-in's client ID metadata document (draft-ietf-oauth-client-id-metadata-document): a public client, one redirect address. */
export function officeClientMetadata(addresses: OfficeAddresses) {
  return {
    client_id: addresses.clientId,
    client_name: OFFICE_APP_NAME,
    client_uri: addresses.origin,
    redirect_uris: [addresses.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * The add-in's Id in the manifest: a GUID made from the server's address
 * (an RFC 4122 version 5 style name-based UUID), so the same server always
 * gives the same add-in and downloading the manifest again updates it
 * rather than adding a second copy, while two servers' add-ins differ.
 */
export function officeAddinId(origin: string): string {
  const bytes = createHash("sha1").update(`tohyee-powerpoint-addin:${origin.toLowerCase()}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The add-in only (XML) manifest for a content add-in in PowerPoint
 * (decision 832). XML rather than the unified JSON manifest because it's the
 * one "Upload My Add-in" in PowerPoint takes on Windows, Mac and the web, and
 * Microsoft 365's Integrated apps takes it too; elements are in the order
 * the schema requires. Content add-ins can't have ribbon buttons; PowerPoint
 * lists them under Add-ins (Insert › Add-ins on Windows and Mac, Home ›
 * Add-ins on the web). Restricted is the least permission there is: the
 * add-in only uses its own settings in the presentation and whether the
 * slide show is running. AllowSnapshot keeps Office's own picture of the
 * add-in in the file, for anyone without the add-in (decision 840).
 */
export function officeManifestXml(addresses: OfficeAddresses, version: string): string {
  const id = officeAddinId(addresses.origin);
  const host = new URL(addresses.origin).host;
  const v = /^\d+\.\d+\.\d+$/.test(version) ? `${version}.0` : "1.0.0.0";
  const a = (value: string) => xmlAttribute(value);
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ContentApp">
  <Id>${id}</Id>
  <Version>${v}</Version>
  <ProviderName>Tohyee</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="${a(`Tohyee Analytics (${host})`.slice(0, 125))}"/>
  <Description DefaultValue="${a(`Live Tohyee Analytics reports on your slides, from ${host}. Everyone who views the slide sees only what they can see in Tohyee.`)}"/>
  <IconUrl DefaultValue="${a(`${addresses.origin}/office/icon-32.png`)}"/>
  <HighResolutionIconUrl DefaultValue="${a(`${addresses.origin}/office/icon-64.png`)}"/>
  <SupportUrl DefaultValue="${a(`${addresses.origin}${OFFICE_CONTENT_PATH}/help`)}"/>
  <AppDomains>
    <AppDomain>${a(addresses.origin)}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Presentation"/>
  </Hosts>
  <Requirements>
    <Sets DefaultMinVersion="1.1">
      <Set Name="DialogApi" MinVersion="1.1"/>
    </Sets>
  </Requirements>
  <DefaultSettings>
    <SourceLocation DefaultValue="${a(addresses.contentUrl)}"/>
    <RequestedWidth>800</RequestedWidth>
    <RequestedHeight>450</RequestedHeight>
  </DefaultSettings>
  <Permissions>Restricted</Permissions>
  <AllowSnapshot>true</AllowSnapshot>
</OfficeApp>
`;
}
