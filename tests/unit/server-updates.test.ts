import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json";
import { getLatestReleaseCheck, UPDATE_FETCH_TIME_LIMIT_MS } from "@/lib/updates/server-updates";

/** A GitHub "latest release" response for this tag. */
function release(tagName: string, assetNames: string[] = []) {
  return {
    tag_name: tagName,
    name: `Tohyee ${tagName}`,
    html_url: `https://github.com/Willy-nz/Tohyee/releases/tag/${tagName}`,
    published_at: "2026-09-20T00:00:00Z",
    draft: false,
    prerelease: false,
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://github.com/Willy-nz/Tohyee/releases/download/${tagName}/${name}`,
      size: 1024,
      content_type: "application/gzip",
    })),
  };
}

/** Answers every fetch with this status and JSON body. */
function stubGitHub(status: number, payload: unknown = {}) {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(payload, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("update check", () => {
  const [major] = packageJson.version.split(".");
  const newer = `v${Number.parseInt(major, 10) + 1}.0.0`;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks GitHub for the latest Tohyee release", async () => {
    const fetchMock = stubGitHub(200, release(`v${packageJson.version}`));
    const check = await getLatestReleaseCheck();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/Willy-nz/Tohyee/releases/latest");
    expect(init).toMatchObject({
      headers: { accept: "application/vnd.github+json", "user-agent": "tohyee-update-check" },
      cache: "no-store",
    });
    // Issue #154: a stalled connection gives up rather than holding the check.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(UPDATE_FETCH_TIME_LIMIT_MS).toBe(15_000);
    expect(check).toMatchObject({
      repository: "Willy-nz/Tohyee",
      currentVersion: packageJson.version,
      latestVersion: packageJson.version,
      updateAvailable: false,
      release: { tagName: `v${packageJson.version}`, htmlUrl: expect.stringContaining("/Willy-nz/Tohyee/") },
    });
  });

  it("reports an update only when the latest release is newer than this server", async () => {
    stubGitHub(200, release(newer));
    expect(await getLatestReleaseCheck()).toMatchObject({ latestVersion: newer.slice(1), updateAvailable: true });
    stubGitHub(200, release(`${newer}-rc.1`));
    expect((await getLatestReleaseCheck()).updateAvailable).toBe(true);
    stubGitHub(200, release(`v${packageJson.version}-rc.1`));
    expect((await getLatestReleaseCheck()).updateAvailable).toBe(false);
    stubGitHub(200, release("v0.0.0"));
    expect((await getLatestReleaseCheck()).updateAvailable).toBe(false);
  });

  it("offers the Linux x64 tarball first", async () => {
    stubGitHub(
      200,
      release(newer, ["tohyee-server-windows-x64.zip", "tohyee-server-linux-x64.tar.gz", "tohyee-source.tgz"]),
    );
    const { release: latest } = await getLatestReleaseCheck();
    expect(latest.assets.map((asset) => asset.name)).toEqual([
      "tohyee-server-windows-x64.zip",
      "tohyee-server-linux-x64.tar.gz",
      "tohyee-source.tgz",
    ]);
    expect(latest.preferredAsset).toMatchObject({
      name: "tohyee-server-linux-x64.tar.gz",
      downloadUrl: `https://github.com/Willy-nz/Tohyee/releases/download/${newer}/tohyee-server-linux-x64.tar.gz`,
      size: 1024,
      digest: null,
    });
  });

  it("says so when there are no releases or GitHub can't be reached", async () => {
    stubGitHub(404, { message: "Not Found" });
    await expect(getLatestReleaseCheck()).rejects.toThrow("No GitHub releases found.");
    stubGitHub(503);
    await expect(getLatestReleaseCheck()).rejects.toThrow("GitHub release check failed with status 503.");
  });
});
