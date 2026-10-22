import { NextResponse } from "next/server";
import { authorizationServerMetadata, oauthAddresses, protectedResourceMetadata } from "@/lib/ai/oauth/config";
import { readLimitedBytes } from "@/lib/net/limited-body";
import { PayloadTooLargeError } from "@/lib/errors";

/** OAuth answers are never cached (RFC 6749 section 5.1). */
export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache", ...headers } });
}

export function oauthErrorResponse(error: string, description: string, status = 400): Response {
  return oauthJson({ error, error_description: description }, status);
}

/**
 * The metadata documents are public and hold no secrets, so any site may
 * read them (browser-based MCP tools need that); 404 while remote access is
 * off, since there's no https address to sign in at (decision 810).
 */
async function metadataAnswer(build: "resource" | "server"): Promise<Response> {
  const addresses = await oauthAddresses();
  const headers = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };
  if (!addresses) return NextResponse.json({ error: "Remote access is off, so AI apps can't sign in to this Tohyee." }, { status: 404, headers });
  return NextResponse.json(build === "resource" ? protectedResourceMetadata(addresses) : authorizationServerMetadata(addresses), { headers });
}

export const protectedResourceMetadataRoute = () => metadataAnswer("resource");
export const authorizationServerMetadataRoute = () => metadataAnswer("server");

/**
 * The fields of an OAuth request body: application/x-www-form-urlencoded as
 * RFC 6749 says (and JSON, which some clients send), at most 16 KB. A
 * client_id may also come in HTTP Basic (with any secret ignored: every app
 * is a public client).
 */
export async function readOAuthForm(request: Request): Promise<URLSearchParams> {
  let text: string;
  try {
    text = (await readLimitedBytes(request, 16 * 1024)).toString("utf8");
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw new FormProblem("The request is too big.");
    throw error;
  }
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  let form: URLSearchParams;
  if (type.startsWith("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FormProblem("The request body isn't JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FormProblem("The request body must be an object.");
    form = new URLSearchParams();
    for (const [name, value] of Object.entries(parsed)) if (typeof value === "string") form.set(name, value);
  } else {
    form = new URLSearchParams(text);
  }
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length > 1) throw new FormProblem(`${name} is given more than once.`);
  }
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (basic && !form.get("client_id")) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    let clientId = "";
    try {
      clientId = decodeURIComponent(decoded.split(":")[0] ?? "");
    } catch {
      throw new FormProblem("The Authorization header isn't readable.");
    }
    if (clientId) form.set("client_id", clientId);
  }
  return form;
}

export class FormProblem extends Error {}
