import packageJson from "../../../package.json";

const GITHUB_REPOSITORY = "Willy-nz/Tohyee";
const GITHUB_RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
  digest?: string | null;
};

type GitHubReleaseResponse = {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
};

type ParsedVersion = {
  core: number[];
  prerelease: string[];
};

export type ReleaseAsset = {
  name: string;
  downloadUrl: string;
  size: number;
  contentType: string;
  digest: string | null;
};

export type LatestReleaseCheck = {
  repository: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  release: {
    tagName: string;
    name: string | null;
    htmlUrl: string;
    publishedAt: string | null;
    draft: boolean;
    prerelease: boolean;
    preferredAsset: ReleaseAsset | null;
    assets: ReleaseAsset[];
  };
};

function normalizeVersion(input: string) {
  return input.trim().replace(/^v/i, "").split("+")[0];
}

function parseVersion(input: string): ParsedVersion | null {
  const normalized = normalizeVersion(input);
  const [coreText, prereleaseText] = normalized.split("-", 2);
  const core = coreText.split(".");

  if (core.length === 0 || core.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  return {
    core: core.map((part) => Number(part)),
    prerelease:
      prereleaseText == null || prereleaseText.length === 0 ? [] : prereleaseText.split("."),
  };
}

function compareIdentifiers(left: string, right: string) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }

  if (leftNumeric) {
    return -1;
  }

  if (rightNumeric) {
    return 1;
  }

  return left.localeCompare(right);
}

function compareVersions(left: string, right: string) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  if (!leftVersion || !rightVersion) {
    return normalizeVersion(left).localeCompare(normalizeVersion(right));
  }

  const maxCoreLength = Math.max(leftVersion.core.length, rightVersion.core.length);
  for (let index = 0; index < maxCoreLength; index += 1) {
    const difference = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  const leftHasPrerelease = leftVersion.prerelease.length > 0;
  const rightHasPrerelease = rightVersion.prerelease.length > 0;

  if (!leftHasPrerelease && rightHasPrerelease) {
    return 1;
  }

  if (leftHasPrerelease && !rightHasPrerelease) {
    return -1;
  }

  const maxPrereleaseLength = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < maxPrereleaseLength; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];

    if (leftIdentifier == null) {
      return -1;
    }

    if (rightIdentifier == null) {
      return 1;
    }

    const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function selectPreferredAsset(assets: ReleaseAsset[]) {
  const scoreAsset = (name: string) => {
    let value = 0;

    if (name.endsWith(".tar.gz")) {
      value += 60;
    } else if (name.endsWith(".tgz")) {
      value += 50;
    } else if (name.endsWith(".zip")) {
      value += 20;
    } else if (name.endsWith(".exe")) {
      value -= 20;
    }

    if (name.includes("linux")) {
      value += 30;
    }

    if (name.includes("x64") || name.includes("amd64")) {
      value += 10;
    }

    if (name.includes("server")) {
      value += 5;
    }

    return value;
  };

  const ranked = assets
    .map((asset) => ({
      asset,
      score: scoreAsset(asset.name.toLowerCase()),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.asset);

  return ranked[0] ?? null;
}

export async function getLatestReleaseCheck(): Promise<LatestReleaseCheck> {
  const response = await fetch(GITHUB_RELEASES_LATEST_URL, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "tohyee-update-check",
    },
    cache: "no-store",
  });

  if (response.status === 404) {
    throw new Error("No GitHub releases found.");
  }

  if (!response.ok) {
    throw new Error(`GitHub release check failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as GitHubReleaseResponse;
  const currentVersion = packageJson.version;
  const latestVersion = normalizeVersion(payload.tag_name);
  const assets = payload.assets.map((asset) => ({
    name: asset.name,
    downloadUrl: asset.browser_download_url,
    size: asset.size,
    contentType: asset.content_type,
    digest: asset.digest ?? null,
  }));

  return {
    repository: GITHUB_REPOSITORY,
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
    release: {
      tagName: payload.tag_name,
      name: payload.name,
      htmlUrl: payload.html_url,
      publishedAt: payload.published_at,
      draft: payload.draft,
      prerelease: payload.prerelease,
      preferredAsset: selectPreferredAsset(assets),
      assets,
    },
  };
}
