import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
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
