import { describe, expect, it } from "vitest";
import { challengeIn, checkCounter, cleanPasskeyName, passkeyAddress, passkeyPlace, suggestPasskeyName } from "@/lib/auth/passkey-rules";

describe("where passkeys work (#450, decision 889)", () => {
  it("works on a proper https web address, with the name (not the port) as its ID", () => {
    expect(passkeyAddress("https://books.example.nz")).toEqual({ origin: "https://books.example.nz", rpId: "books.example.nz", problem: null });
    expect(passkeyAddress("https://Farm.Example.co.nz:8443")).toEqual({ origin: "https://farm.example.co.nz:8443", rpId: "farm.example.co.nz", problem: null });
    expect(passkeyAddress("https://kowhai.ts.net").rpId).toBe("kowhai.ts.net");
  });

  it("works on localhost on the server computer, even without https", () => {
    expect(passkeyAddress("http://localhost:3000")).toEqual({ origin: "http://localhost:3000", rpId: "localhost", problem: null });
    expect(passkeyAddress("https://localhost").rpId).toBe("localhost");
  });

  it("refuses home-network numbers and names, plain http, and nonsense, saying why", () => {
    for (const origin of ["http://192.168.1.20:3000", "https://10.0.0.5", "http://127.0.0.1:3000", "http://[::1]:3000", "https://203.0.113.9"]) {
      const address = passkeyAddress(origin);
      expect(address.rpId, origin).toBeNull();
      expect(address.problem).toMatch(/address made of numbers/);
    }
    for (const origin of ["http://farm-pc:3000", "https://tohyee.local", "https://server.lan", "http://tohyee.home.arpa"]) {
      expect(passkeyAddress(origin).problem, origin).toMatch(/home-network name/);
    }
    expect(passkeyAddress("http://books.example.nz").problem).toMatch(/secure \(https\)/);
    expect(passkeyAddress("not an address").problem).toMatch(/can't be used/);
  });

  it("says where a passkey works in words", () => {
    expect(passkeyPlace("localhost")).toBe("on the server computer (localhost)");
    expect(passkeyPlace("books.example.nz")).toBe("at books.example.nz");
  });
});

describe("a passkey's use count (decision 893)", () => {
  it("is fine at 0 (most phones) or counting up", () => {
    expect(checkCounter(0, 0)).toBe("ok");
    expect(checkCounter(0, 1)).toBe("ok");
    expect(checkCounter(41, 42)).toBe("ok");
  });
  it("refuses one that goes backwards (not to 0), and flags one that stands still or drops to 0", () => {
    expect(checkCounter(42, 41)).toBe("refuse");
    expect(checkCounter(42, 1)).toBe("refuse");
    expect(checkCounter(42, 42)).toBe("warn");
    expect(checkCounter(42, 0)).toBe("warn");
  });
});

describe("passkey names", () => {
  it("are trimmed to one line of up to 60 characters", () => {
    expect(cleanPasskeyName("  Jess's   iPhone \n")).toBe("Jess's iPhone");
    expect(cleanPasskeyName("a\u0000b")).toBe("a b");
    expect(cleanPasskeyName("")).toBeNull();
    expect(cleanPasskeyName("   ")).toBeNull();
    expect(cleanPasskeyName("x".repeat(61))).toBeNull();
    expect(cleanPasskeyName(42)).toBeNull();
  });
  it("start from the kind of device", () => {
    expect(suggestPasskeyName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(suggestPasskeyName("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("Android phone");
    expect(suggestPasskeyName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows computer");
    expect(suggestPasskeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe("Mac");
    expect(suggestPasskeyName(null)).toBe("Passkey");
  });
});

describe("reading the challenge a browser answered", () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  it("finds it in the client data", () => {
    expect(challengeIn(encode({ type: "webauthn.get", challenge: "abcdefghijklmnopqrstuvwxyz012345", origin: "https://books.example.nz" }))).toBe("abcdefghijklmnopqrstuvwxyz012345");
  });
  it("gives null for anything else", () => {
    expect(challengeIn(undefined)).toBeNull();
    expect(challengeIn("not base64!")).toBeNull();
    expect(challengeIn(encode({ challenge: "short" }))).toBeNull();
    expect(challengeIn(encode({ challenge: 42 }))).toBeNull();
    expect(challengeIn(Buffer.from("not json").toString("base64url"))).toBeNull();
    expect(challengeIn("A".repeat(5000))).toBeNull();
  });
});
