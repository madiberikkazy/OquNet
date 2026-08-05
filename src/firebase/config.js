// Firebase initialization.
// Fill in your Firebase project credentials in a `.env` file at the project root.
// See `.env.example` for the keys. See FIREBASE_SETUP.md for step-by-step instructions.

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
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
  db = getFirestore(app);
} else {
  // eslint-disable-next-line no-console
  console.warn(
    "[OquNet] Firebase config not detected. Running with localStorage fallback. " +
      "See FIREBASE_SETUP.md to connect your Firebase project."
  );
}

export { app, auth, db };
