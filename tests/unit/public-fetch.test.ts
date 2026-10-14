import { afterEach, describe, expect, it } from "vitest";
import { setMailHostResolverForTests } from "@/lib/analytics/mail-host";
import { readLimitedBytes } from "@/lib/net/limited-body";
import { localHostName } from "@/lib/net/local-names";
import { publicFetch, publicLookup } from "@/lib/net/public-fetch";

/** Decision 534: outgoing calls to typed-in addresses only reach the internet. */
describe("public-only outgoing calls (decision 534)", () => {
  afterEach(() => setMailHostResolverForTests(null));

  const lookup = (host: string, all = false) =>
    new Promise<unknown>((resolve, reject) => {
      publicLookup(host, { all }, (error, address, family) => (error ? reject(error) : resolve(all ? address : { address, family })));
    });

  it("checks the addresses as the connection is made and connects to a checked one", async () => {
    setMailHostResolverForTests(async () => ["203.0.113.10", "2001:db8::10"]);
    await expect(lookup("shop.example.nz")).resolves.toEqual({ address: "203.0.113.10", family: 4 });
    await expect(lookup("shop.example.nz", true)).resolves.toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]);
  });

  it("refuses a name that now points at this server or its network, even if it didn't before", async () => {
    let calls = 0;
    // The first answer is public, the next one isn't: the connection uses the second.
    setMailHostResolverForTests(async () => (calls++ === 0 ? ["203.0.113.10"] : ["127.0.0.1"]));
    await expect(lookup("rebind.example.nz")).resolves.toMatchObject({ address: "203.0.113.10" });
    await expect(lookup("rebind.example.nz")).rejects.toThrow("local network");
    setMailHostResolverForTests(async () => ["203.0.113.10", "169.254.169.254"]);
    await expect(publicFetch("https://mixed.example.nz/", { maxBytes: 1024 })).rejects.toThrow("local network");
  });

  it("refuses local addresses and http before connecting", async () => {
    for (const url of ["https://127.0.0.1/", "https://[::1]/", "https://10.1.2.3/", "https://localhost/", "https://admin.localhost/"]) {
      await expect(publicFetch(url, { maxBytes: 1024 })).rejects.toThrow(/this server/);
    }
    await expect(publicFetch("http://shop.example.nz/", { maxBytes: 1024 })).rejects.toThrow("https");
  });

  it("knows local names", () => {
    for (const host of ["localhost", "farm-pc", "tohyee.local", "books.home.arpa", "x.internal", "192.168.1.5:3000", "[fe80::1]:3000", "100.64.0.1"]) expect(localHostName(host)).toBe(true);
    for (const host of ["shop.glimmers.nz", "203.0.113.4", "[2001:db8::1]:443", "books.kowhai.nz:443"]) expect(localHostName(host)).toBe(false);
  });

  it("stops reading an answer once it's too big, with or without a length", async () => {
    const big = new Response(new Uint8Array(2048));
    await expect(readLimitedBytes(big, 1024, "The answer")).rejects.toThrow("The answer is too large (at most 1 KB)");
    const declared = new Response("small", { headers: { "content-length": "999999" } });
    await expect(readLimitedBytes(declared, 1024)).rejects.toThrow("too large");
    expect((await readLimitedBytes(new Response("fine"), 1024)).toString()).toBe("fine");
  });
});
