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

export async function assertPublicMailHost(host: string): Promise<void> {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) {
    throw new ValidationError("The mail server must be on the internet, not this server or its local network.");
  }
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new ValidationError(`Couldn't find the mail server ${host}. Check its name.`);
  }
  if (addresses.length === 0 || addresses.some(privateAddress)) {
    throw new ValidationError("The mail server must be on the internet, not this server or its local network.");
  }
}
