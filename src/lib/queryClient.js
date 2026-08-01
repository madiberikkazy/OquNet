import { QueryClient } from "@tanstack/react-query";

// Global defaults tuned for a mobile PWA:
// - staleTime 60s: within a minute, treat cache as fresh — no refetch on
//   remount, so Back navigation is instant.
// - gcTime 24h: keep unused caches around all day so returning to a screen
//   after a long detour still renders instantly.
// - refetchOnMount: false — never refetch just because a screen re-mounted;
//   staleness alone (or an explicit invalidate) drives refetches.
// - refetchOnWindowFocus: true — when user returns to the tab, quietly
//   revalidate stale queries in the background (stale-while-revalidate).
// - retry with exponential backoff — matches "retry with exponential backoff".
// - networkMode "offlineFirst": serve cached data even while offline.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 24 * 60 * 60 * 1000,
      refetchOnMount: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        if (error?.code === "permission-denied" || error?.code === "not-found") return false;
        return failureCount < 3;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
      networkMode: "offlineFirst",
    },
    mutations: {
      retry: 1,
      networkMode: "offlineFirst",
    },
  },
});
