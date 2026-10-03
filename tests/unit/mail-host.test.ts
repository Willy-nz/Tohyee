import { describe, expect, it } from "vitest";
import { privateAddress } from "@/lib/analytics/mail-host";

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
