import { describe, expect, it } from "vitest";
import { assertPublicMailHost, checkMailHost, privateAddress, setMailHostResolverForTests } from "@/lib/analytics/mail-host";

describe("report mailbox hosts must be on the internet", () => {
  it("treats this server, its networks and cloud metadata as private", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) {
      expect(privateAddress(address), address).toBe(true);
    }
  });
  it("sees through IPv4 written as IPv6, however it's written", () => {
    for (const address of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:7f00:0001",
      "0:0:0:0:0:ffff:127.0.0.1",
      "::ffff:0:7f00:1",
      "::7f00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1",
      "2002:7f00:1::1",
      "2002:c0a8:101::1",
      "[::ffff:7f00:1]",
      "fe80::1%eth0",
    ]) {
      expect(privateAddress(address), address).toBe(true);
    }
  });
  it("treats benchmarking, tunnel and discard ranges as private", () => {
    for (const address of ["2001:2::1", "2001:0:4136:e378::1", "100::1", "fec0::1", "ff02::1", "198.18.0.1", "255.255.255.255"]) {
      expect(privateAddress(address), address).toBe(true);
    }
  });
  it("refuses anything it can't read as an address", () => {
    for (const address of ["1:2:3:4:5:6:7:8:9", "1::2::3", "gggg::1", ""]) expect(privateAddress(address), address).toBe(true);
  });
  it("allows public addresses", () => {
    for (const address of ["142.250.72.109", "40.97.120.242", "172.32.0.1", "2607:f8b0:4004:c1b::6c", "::ffff:142.250.72.109", "::ffff:8efa:486d", "64:ff9b::8efa:486d", "2002:8efa:486d::1", "2404:6800:4006:80a::200e"]) {
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
