"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "@/lib/client/api";

type Query = Record<string, string | number | boolean | null | undefined>;

type LoadState<T> = {
  data: T | null;
  error: string | null;
  key: string | null;
};

/**
 * Loads JSON from the API whenever the path or query changes. Pass a null path
 * to skip loading (e.g. no organisation selected yet).
 */
export function useApiData<T>(path: string | null, query: Query = {}) {
  const queryKey = JSON.stringify(query);
  const requestKey = path ? `${path}?${queryKey}` : null;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<LoadState<T>>({ data: null, error: null, key: null });

  useEffect(() => {
    if (!path) {
      return;
    }
    let cancelled = false;
    const key = `${path}?${queryKey}`;
    api<T>(path, { query: JSON.parse(queryKey) as Query }).then(
      (data) => {
        if (!cancelled) setState({ data, error: null, key });
      },
      (error) => {
        if (!cancelled) setState({ data: null, error: errorMessage(error), key });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, queryKey, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const current = state.key === requestKey;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: requestKey !== null && !current,
    reload,
  };
}

const noopSubscribe = () => () => undefined;

/**
 * False while rendering on the server and during hydration, true afterwards.
 * Pages that depend on the browser (today's date, the chosen organisation)
 * render their content only once this is true, so server and browser HTML
 * never disagree.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
