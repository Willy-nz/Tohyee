import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "@/lib/errors";

/**
 * An IMAP report mailbox must be on the internet, not this server or its
 * network: the host is resolved and every address it gives is checked, when
 * the mailbox is saved and again before each connection (a name can be
 * pointed somewhere else later).
 */
type Resolve = (host: string) => Promise<string[]>;

const resolveWithDns: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
let resolve: Resolve = resolveWithDns;

/** Tests use made-up host names; they resolve them here. */
export function setMailHostResolverForTests(next: Resolve | null): void {
  resolve = next ?? resolveWithDns;
}

function ipv4Private(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Private(address);
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]);
  return (
    lower === "::" || lower === "::1" ||
    /^f[cd]/.test(lower) || // unique local
    /^fe[89ab]/.test(lower) || // link-local
    lower.startsWith("ff") // multicast
  );
}

/**
 * Resolves a mail server's name and checks every address it gives. "local"
 * means the name or an address is this server or a private, loopback or
 * link-local network; "not_found" that the name doesn't resolve. On success,
 * the checked addresses, so a caller can connect to one of them rather than
 * look the name up again (it could answer differently the second time).
 */
export async function checkMailHost(host: string): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: "local" | "not_found" }> {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return { ok: false, reason: "local" };
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (addresses.length === 0) return { ok: false, reason: "not_found" };
  if (addresses.some(privateAddress)) return { ok: false, reason: "local" };
  return { ok: true, addresses };
}

export async function assertPublicMailHost(host: string): Promise<void> {
  const checked = await checkMailHost(host);
  if (checked.ok) return;
  if (checked.reason === "not_found") throw new ValidationError(`Couldn't find the mail server ${host}. Check its name.`);
  throw new ValidationError("The mail server must be on the internet, not this server or its local network.");
}
