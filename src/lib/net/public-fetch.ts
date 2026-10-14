import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { checkMailHost, privateAddress } from "@/lib/analytics/mail-host";

/*
 * Outgoing https calls to an address someone typed (a WooCommerce store, a
 * SimpleFIN Bridge), decision 534. The name is looked up when the connection
 * is made and every address it gives is checked there and then, and the
 * connection goes to one of those checked addresses. Checking first and
 * connecting later would look the name up twice, and a name can answer
 * differently the second time (pointing at this server or its network).
 *
 * Only https; redirects aren't followed (a 3xx comes back as it is); the
 * answer is read up to `maxBytes` and refused if it's bigger.
 */

export class PublicFetchError extends Error {}

/** The DNS lookup used for each connection: refuses names that give a private or local address. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  checkMailHost(hostname).then(
    (checked) => {
      if (!checked.ok) {
        const error = Object.assign(new PublicFetchError(checked.reason === "local" ? `${hostname} is on this server or its local network.` : `Couldn't find ${hostname}.`), {
          code: checked.reason === "local" ? "EPUBLICONLY" : "ENOTFOUND",
        });
        callback(error, "", 0);
        return;
      }
      const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
      const addresses = checked.addresses.map((address) => ({ address, family: isIP(address) })).filter((entry) => !wanted || entry.family === wanted);
      if (addresses.length === 0) {
        callback(Object.assign(new PublicFetchError(`Couldn't find ${hostname}.`), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      if (options.all) (callback as unknown as (error: null, list: typeof addresses) => void)(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    },
    (error: Error) => callback(error as NodeJS.ErrnoException, "", 0),
  );
};

export type PublicFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** The most the answer may be; bigger answers are refused. */
  maxBytes: number;
};

/** An https request to a public address only, as a fetch-style Response. */
export function publicFetch(input: string, init: PublicFetchInit): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "https:") return Promise.reject(new PublicFetchError("Only https:// addresses can be used."));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && privateAddress(host)) return Promise.reject(new PublicFetchError(`${host} is on this server or its local network.`));
  if (host === "localhost" || host.endsWith(".localhost")) return Promise.reject(new PublicFetchError(`${host} is on this server.`));
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers["content-length"] = String(Buffer.byteLength(init.body));
    const request = httpsRequest(
      url,
      { method: init.method ?? "GET", headers, lookup: publicLookup, signal: init.signal },
      (incoming) => {
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > init.maxBytes) {
            incoming.destroy();
            request.destroy();
            reject(new PublicFetchError(`${url.hostname} sent back more than ${Math.round(init.maxBytes / (1024 * 1024))} MB.`));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          if (total > init.maxBytes) return;
          const answerHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue;
            for (const entry of Array.isArray(value) ? value : [value]) answerHeaders.append(name, entry);
          }
          const status = incoming.statusCode ?? 500;
          const noBody = status === 204 || status === 205 || status === 304;
          resolve(new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), { status: status < 200 || status > 599 ? 502 : status, headers: answerHeaders }));
        });
      },
    );
    request.on("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

/**
 * `publicFetch` behind the usual fetch signature, for connectors whose tests
 * swap the network out. Bodies must be text; redirects are never followed.
 */
export function publicFetchLike(maxBytes: number): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init = {}) => {
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") return Promise.reject(new PublicFetchError("Only text request bodies are supported."));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    return publicFetch(input, { method: init.method, headers, body: (init.body as string | null | undefined) ?? undefined, signal: init.signal ?? undefined, maxBytes });
  };
}
