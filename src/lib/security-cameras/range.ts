/* Byte ranges for playing and seeking clips (#508). Pure; tested in tests/unit/security-camera-range.test.ts. */

/** A byte range from a Range header ("bytes=a-b", "bytes=a-", "bytes=-n"), or null for the whole file; "bad" when it can't be met. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "bad";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "bad";
  return { start, end };
}
