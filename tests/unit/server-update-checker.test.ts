import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { summariseStartup } from "@/lib/updates/server-starts";
import type { LatestReleaseCheck } from "@/lib/updates/server-updates";
import {
  checkForUpdatesNow,
  findWindowsSetupAsset,
  resetUpdateCheckState,
  sha256FromDigest,
  sha256FromFile,
  updateCheckState,
  windowsSetupFor,
} from "@/lib/updates/update-checker";
import { summariseCheck } from "@/lib/updates/updates";

const HASH = "a".repeat(40) + "0123456789abcdef01234567";

function latest(version: string, assets: { name: string; digest?: string | null }[]): LatestReleaseCheck {
  return {
    repository: "Willy-nz/Tohyee",
    currentVersion: "1.0.0",
    latestVersion: version,
    updateAvailable: true,
    release: {
      tagName: `v${version}`,
      name: `Tohyee v${version}`,
      htmlUrl: `https://github.com/Willy-nz/Tohyee/releases/tag/v${version}`,
      publishedAt: "2026-10-01T00:00:00Z",
      draft: false,
      prerelease: false,
      preferredAsset: null,
      assets: assets.map((asset) => ({
        name: asset.name,
        downloadUrl: `https://github.com/Willy-nz/Tohyee/releases/download/v${version}/${asset.name}`,
        size: 123,
        contentType: "application/octet-stream",
        digest: asset.digest ?? null,
      })),
    },
  };
}

describe("automatic update check (decision 328)", () => {
  const [major] = packageJson.version.split(".");
  const newer = `${Number.parseInt(major, 10) + 1}.0.0`;

  beforeEach(() => resetUpdateCheckState());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetUpdateCheckState();
  });

  it("keeps the last answer, and keeps it when a later check fails", async () => {
    expect(summariseCheck(updateCheckState())).toMatchObject({ checkedAt: null, latestVersion: null, updateAvailable: false });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        Response.json({ tag_name: `v${newer}`, name: null, html_url: "https://github.com/x", published_at: null, draft: false, prerelease: false, assets: [] }),
      ),
    );
    const first = await checkForUpdatesNow(() => new Date("2026-10-02T01:00:00Z"));
    expect(first).toMatchObject({ checkedAt: "2026-10-02T01:00:00.000Z", error: null });
    expect(summariseCheck(updateCheckState())).toMatchObject({ latestVersion: newer, updateAvailable: true, currentVersion: packageJson.version });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({}, { status: 503 })));
    await checkForUpdatesNow(() => new Date("2026-10-03T01:00:00Z"));
    expect(summariseCheck(updateCheckState())).toMatchObject({
      checkedAt: "2026-10-03T01:00:00.000Z",
      checkError: "GitHub release check failed with status 503.",
      latestVersion: newer,
      updateAvailable: true,
    });
  });

  it("shares one request between checks asked for at the same time", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ tag_name: "v0.0.1", name: null, html_url: "https://github.com/x", published_at: null, draft: false, prerelease: false, assets: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([checkForUpdatesNow(), checkForUpdatesNow()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the Windows installer and its fingerprint (decision 331)", () => {
  it("reads GitHub's digest and the release's .sha256 file", () => {
    expect(sha256FromDigest(`sha256:${HASH.toUpperCase()}`)).toBe(HASH);
    expect(sha256FromDigest("md5:abc")).toBeNull();
    expect(sha256FromDigest(null)).toBeNull();
    expect(sha256FromFile(`${HASH}  TohyeeSetup-1.2.0.exe\n`, "TohyeeSetup-1.2.0.exe")).toBe(HASH);
    expect(sha256FromFile(`${HASH} *TohyeeSetup-1.2.0.exe`, "TohyeeSetup-1.2.0.exe")).toBe(HASH);
    expect(sha256FromFile(HASH, "TohyeeSetup-1.2.0.exe")).toBe(HASH);
    // For a different file, or not a SHA-256: no.
    expect(sha256FromFile(`${HASH}  TohyeeSetup-1.1.0.exe`, "TohyeeSetup-1.2.0.exe")).toBeNull();
    expect(sha256FromFile("not a hash", "TohyeeSetup-1.2.0.exe")).toBeNull();
  });

  it("finds TohyeeSetup for the release's own version only", () => {
    expect(findWindowsSetupAsset(latest("1.2.0", [{ name: "tohyee-server-1.2.0.tar.gz" }, { name: "TohyeeSetup-1.2.0.exe" }]))?.name).toBe(
      "TohyeeSetup-1.2.0.exe",
    );
    expect(findWindowsSetupAsset(latest("1.2.0", [{ name: "TohyeeSetup-1.1.0.exe" }]))).toBeNull();
  });

  it("uses GitHub's digest first, then the .sha256 file, and refuses without either", async () => {
    const noFetch = vi.fn<typeof fetch>();
    expect(await windowsSetupFor(latest("1.2.0", [{ name: "TohyeeSetup-1.2.0.exe", digest: `sha256:${HASH}` }]), noFetch)).toEqual({
      setup: {
        name: "TohyeeSetup-1.2.0.exe",
        downloadUrl: "https://github.com/Willy-nz/Tohyee/releases/download/v1.2.0/TohyeeSetup-1.2.0.exe",
        size: 123,
        sha256: HASH,
        sha256From: "github-digest",
      },
    });
    expect(noFetch).not.toHaveBeenCalled();

    const sidecar = vi.fn<typeof fetch>(async () => new Response(`${HASH}  TohyeeSetup-1.2.0.exe\n`));
    const fromFile = await windowsSetupFor(latest("1.2.0", [{ name: "TohyeeSetup-1.2.0.exe" }, { name: "TohyeeSetup-1.2.0.exe.sha256" }]), sidecar);
    expect(fromFile).toMatchObject({ setup: { sha256: HASH, sha256From: "sha256-file" } });
    expect(sidecar.mock.calls[0][0]).toBe("https://github.com/Willy-nz/Tohyee/releases/download/v1.2.0/TohyeeSetup-1.2.0.exe.sha256");
    // Issue #154: the fingerprint fetch has a time limit too.
    expect(sidecar.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    expect(await windowsSetupFor(latest("1.2.0", [{ name: "TohyeeSetup-1.2.0.exe" }]), noFetch)).toEqual({
      problem: "Couldn't get a SHA-256 fingerprint for TohyeeSetup-1.2.0.exe from GitHub, so the download can't be checked. Download it from the release page and run it yourself instead.",
    });
    const broken = vi.fn<typeof fetch>(async () => new Response("nope", { status: 404 }));
    expect(await windowsSetupFor(latest("1.2.0", [{ name: "TohyeeSetup-1.2.0.exe" }, { name: "TohyeeSetup-1.2.0.exe.sha256" }]), broken)).toHaveProperty(
      "problem",
    );
    expect(await windowsSetupFor(latest("1.2.0", [{ name: "tohyee-server-1.2.0.tar.gz" }]), noFetch)).toEqual({
      problem: "Release v1.2.0 has no TohyeeSetup-1.2.0.exe, so it can't be installed from here.",
    });
  });
});

describe("what a start records (decision 330)", () => {
  it("counts the organisations checked, upgraded and blocked", () => {
    expect(
      summariseStartup({
        core: { applied: ["0004"] },
        organisations: [
          { organisationId: "a", ok: true, applied: ["0080"] },
          { organisationId: "b", ok: true, applied: [] },
          { organisationId: "c", ok: false, applied: [], error: "boom" },
        ],
      }),
    ).toEqual({
      coreApplied: ["0004"],
      organisationsChecked: 3,
      organisationsUpgraded: 1,
      organisationsBlocked: [{ organisationId: "c", error: "boom" }],
    });
  });
});
