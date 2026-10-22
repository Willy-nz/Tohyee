import { remoteAccessAddress } from "@/lib/ai/tokens";
import { mcpResourceFor, resourceMetadataUrlFor } from "@/lib/ai/oauth/format";

/**
 * Where Tohyee's sign-in for AI apps lives (decision 810): only on the
 * remote access address, and only when that is https. Cloud AI can't reach
 * anything else, and the MCP specification wants https for the
 * authorisation server. With remote access off there's no issuer, the
 * metadata isn't served and access tokens aren't accepted (keys still work).
 */
export type OAuthAddresses = {
  /** e.g. https://glimmers.tohyee.nz, also the authorisation server's issuer. */
  issuer: string;
  /** e.g. https://glimmers.tohyee.nz/api/mcp: what tokens are bound to. */
  resource: string;
  resourceMetadataUrl: string;
};

export function oauthAddressesFor(remoteAddress: string | null): OAuthAddresses | null {
  if (!remoteAddress) return null;
  let url: URL;
  try {
    url = new URL(remoteAddress);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const issuer = url.origin;
  const resource = mcpResourceFor(issuer);
  return { issuer, resource, resourceMetadataUrl: resourceMetadataUrlFor(resource) };
}

export async function oauthAddresses(): Promise<OAuthAddresses | null> {
  return oauthAddressesFor(await remoteAccessAddress());
}

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(addresses: OAuthAddresses) {
  return {
    resource: addresses.resource,
    authorization_servers: [addresses.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Tohyee",
  };
}

/**
 * RFC 8414 authorisation server metadata (decisions 812-816). No scopes:
 * what an app may do is chosen by the person on the consent screen, not
 * asked for by the app. Public clients only (no client secrets), the
 * authorisation code grant with PKCE S256, and refresh tokens. Apps can
 * register (RFC 7591) or give a client ID metadata document address.
 */
export function authorizationServerMetadata(addresses: OAuthAddresses) {
  return {
    issuer: addresses.issuer,
    authorization_endpoint: `${addresses.issuer}/oauth/authorize`,
    token_endpoint: `${addresses.issuer}/api/oauth/token`,
    registration_endpoint: `${addresses.issuer}/api/oauth/register`,
    revocation_endpoint: `${addresses.issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}
