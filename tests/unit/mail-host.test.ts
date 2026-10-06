import { describe, expect, it } from "vitest";
import { assertPublicMailHost, checkMailHost, privateAddress, setMailHostResolverForTests } from "@/lib/analytics/mail-host";

describe("report mailbox hosts must be on the internet", () => {
  it("treats this server, its networks and cloud metadata as private", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) {
      expect(privateAddress(address), address).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const address of ["142.250.72.109", "40.97.120.242", "172.32.0.1", "2607:f8b0:4004:c1b::6c", "::ffff:142.250.72.109"]) {
      expect(privateAddress(address), address).toBe(false);
    }
  });
});

describe("checking a mail server's name", () => {
  it("resolves it and returns the addresses it checked, or why it can't be used", async () => {
    setMailHostResolverForTests(async (host) => {
      if (host === "smtp.example.com") return ["203.0.113.10", "2607:f8b0:4004:c1b::6c"];
      if (host === "relay.example.com") return ["203.0.113.11", "10.0.0.5"];
      throw new Error("getaddrinfo ENOTFOUND");
    });
    try {
      expect(await checkMailHost("smtp.example.com")).toEqual({ ok: true, addresses: ["203.0.113.10", "2607:f8b0:4004:c1b::6c"] });
      expect(await checkMailHost("relay.example.com")).toEqual({ ok: false, reason: "local" });
      expect(await checkMailHost("localhost")).toEqual({ ok: false, reason: "local" });
      expect(await checkMailHost("mail.localhost.")).toEqual({ ok: false, reason: "local" });
      expect(await checkMailHost("127.0.0.1")).toEqual({ ok: false, reason: "local" });
      expect(await checkMailHost("::1")).toEqual({ ok: false, reason: "local" });
      expect(await checkMailHost("nowhere.example.com")).toEqual({ ok: false, reason: "not_found" });
      await expect(assertPublicMailHost("relay.example.com")).rejects.toThrow(/must be on the internet/);
      await expect(assertPublicMailHost("nowhere.example.com")).rejects.toThrow(/Couldn't find the mail server/);
    } finally {
      setMailHostResolverForTests(null);
    }
  });
});
