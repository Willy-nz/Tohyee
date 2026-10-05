/**
 * The network for every sales platform connector, so tests can swap it for
 * canned responses (`setSalesPlatformFetchForTests`).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetcher: FetchLike = (input, init) => fetch(input, init);

export function platformFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetcher(input, init);
}

export function setSalesPlatformFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? ((input, init) => fetch(input, init));
}
