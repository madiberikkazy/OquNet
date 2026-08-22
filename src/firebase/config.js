// Firebase initialization.
// Fill in your Firebase project credentials in a `.env` file at the project root.
// See `.env.example` for the keys. See FIREBASE_SETUP.md for step-by-step instructions.

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
// NOTE: firebase/storage is deliberately NOT imported here. Only three screens
// ever upload an image, so ./storage.js pulls the Storage SDK in on demand
// rather than letting it ride along in the initial bundle.

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey);

let app, auth, db;
if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // `initializeFirestore` with a persistent cache rather than `getFirestore`,
  // and the difference is the whole of this app's offline story.
  //
  // The default in-memory cache means two things, both of which readers hit.
  // Reads: everything is re-fetched from the network on every cold start, so
  // opening the app on a train is an empty shelf even though the same shelf
  // was on screen an hour ago. Writes: a write made while offline is held in
  // memory and replayed when the connection returns — but only if the tab
  // survives that long. Close the app, or let iOS evict it, and the post is
  // gone with no error anywhere, because from the SDK's point of view nothing
  // failed; it was still waiting.
  //
  // A persistent cache moves both to IndexedDB. Queries are answered from disk
  // while offline, and a queued write is replayed on the next launch even if
  // the app was killed in between. That is what makes "write a post in the
  // metro, it appears when you surface" true rather than aspirational, and it
  // is why there is no hand-rolled outbox in this codebase — the SDK's queue
  // is the outbox, and a second one on top of it would fight it.
  //
  // The multi-tab manager is required, not optional: IndexedDB persistence
  // takes a lock, and with the default single-tab manager the *second* tab a
  // reader opens fails to initialise its cache entirely. `persistentMultiple-
  // TabManager` elects a leader and shares the connection between tabs.
  //
  // Note that this can still fail — Safari in private mode has no usable
  // IndexedDB — but it fails by falling back to memory rather than throwing,
  // so there is nothing to catch here.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "[OquNet] Firebase config not detected. Running with localStorage fallback. " +
      "See FIREBASE_SETUP.md to connect your Firebase project."
  );
}

export { app, auth, db };
