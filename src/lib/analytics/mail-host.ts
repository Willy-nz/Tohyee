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
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

/** An IPv6 address as eight 16-bit groups, or null when it isn't one. Handles "::", a zone ("%eth0") and a dotted IPv4 tail. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.some((group) => Number.isNaN(group)) ? null : groups;
}

const ipv4From = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * Whether an address is this server, a private or special-purpose network,
 * or an IPv4 one of those written as IPv6 (mapped, NAT64, 6to4 and the like),
 * whichever way the IPv6 is written: Node writes [::ffff:127.0.0.1] as
 * [::ffff:7f00:1], so a written-out pattern isn't enough. The documentation
 * ranges (203.0.113.0/24, 2001:db8::/32…) aren't reachable on the internet
 * and stand in for public addresses in examples and tests, so they count as
 * public.
 */
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Private(address);
  const g = ipv6Groups(address);
  if (!g) return true; // not an address we can read: refuse rather than guess
  const zeroUpTo = (count: number) => g.slice(0, count).every((group) => group === 0);
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d), compatible (::a.b.c.d, which includes :: and ::1), NAT64 (64:ff9b::/96).
  if (zeroUpTo(5) && g[5] === 0xffff) return ipv4Private(ipv4From(g[6], g[7]));
  if (zeroUpTo(4) && g[4] === 0xffff && g[5] === 0) return ipv4Private(ipv4From(g[6], g[7]));
  if (zeroUpTo(6)) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return ipv4Private(ipv4From(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  // 6to4 (2002::/16) carries an IPv4 address in its next 32 bits.
  if (g[0] === 0x2002) return ipv4Private(ipv4From(g[1], g[2]));
  return (
    (g[0] === 0x2001 && g[1] === 0) || // Teredo tunnels
    (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) || // benchmarking
    (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) || // discard
    (g[0] & 0xfe00) === 0xfc00 || // unique local
    (g[0] & 0xffc0) === 0xfe80 || // link-local
    (g[0] & 0xffc0) === 0xfec0 || // old site-local
    (g[0] & 0xff00) === 0xff00 // multicast
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
