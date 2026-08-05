import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { defaultShouldDehydrateQuery } from "@tanstack/react-query";
import { get, set, del } from "idb-keyval";

// idb-keyval-backed async storage for React Query's persist plugin.
// Persisting to IndexedDB (not localStorage) keeps the main thread free of
// synchronous storage I/O and gives us ~50 MB+ of quota on modern browsers.
const idbStorage = {
  getItem: (key) => get(key),
  setItem: (key, value) => set(key, value),
  removeItem: (key) => del(key),
};

export const queryPersister = createAsyncStoragePersister({
  storage: idbStorage,
  key: "oqunet:react-query",
  // Small throttle to coalesce rapid cache writes into one IDB round-trip.
  throttleTime: 1000,
});

/**
 * Which queries are allowed into IndexedDB. Everything except infinite ones.
 *
 * An infinite query carries its `pageParams` alongside its pages, and for a
 * paged Firestore list a page param *is* a `DocumentSnapshot` — the object
 * `startAfter()` reads the ordered field values back out of. Two things go
 * wrong if one of those reaches the persister. It is not JSON-serializable
 * (it holds a reference to the Firestore instance, so `JSON.stringify` hits a
 * circular structure and throws), and a throw here does not fail one query, it
 * fails the write for the entire cache. And even if it serialized, what came
 * back would be an inert object literal that `startAfter()` rejects.
 *
 * Not persisting them costs one page of refetch on a cold start, which is what
 * a list the user has scrolled halfway down should do anyway. The alternative —
 * a cursor of raw field values, which does survive JSON — gives up Firestore's
 * document-id tie-break and would silently skip books sharing a `createdAt`.
 *
 * Composed with the library default rather than replacing it: passing
 * `shouldDehydrateQuery` overrides the built-in check entirely, and without it
 * pending and errored queries would start being persisted too.
 */
export function shouldPersistQuery(query) {
  return defaultShouldDehydrateQuery(query) && !Array.isArray(query.state.data?.pages);
}
