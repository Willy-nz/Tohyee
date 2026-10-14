import { publicFetchLike } from "@/lib/net/public-fetch";

/**
 * The network for every sales platform connector, so tests can swap it for
 * canned responses (`setSalesPlatformFetchForTests`).
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Public https addresses only, checked as each connection is made; answers up to 20 MB (decision 534). */
const network: FetchLike = publicFetchLike(20 * 1024 * 1024);
let fetcher: FetchLike = network;

export function platformFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetcher(input, init);
}

export function setSalesPlatformFetchForTests(replacement: FetchLike | null): void {
  fetcher = replacement ?? network;
}
