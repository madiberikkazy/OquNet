import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vendor chunking.
//
// The point isn't a smaller total — it's a smaller *critical path* plus stable
// cache keys. These libraries only change when we bump a dependency, so keeping
// them out of the app chunk means a routine deploy invalidates a few kB of app
// code instead of ~250 kB of vendor code along with it.
//
// The split lines follow how the code is actually reached:
//   react       — needed to render anything at all.
//   firebase-*  — auth and firestore are both unavoidably on the critical path
//                 (AuthProvider resolves the session before any route can
//                 render), but they're separate packages that version-bump
//                 independently. Storage is dynamically imported by
//                 src/firebase/storage.js, so it lands in a chunk that the vast
//                 majority of sessions never fetch.
//   query       — TanStack Query and its persist adapters, pulled in by main.jsx.
function manualChunks(id) {
  if (!id.includes("node_modules")) return;

  // Resolve against the path after the LAST node_modules/ segment. npm nests
  // duplicated packages — `firebase` carries its own copy of @firebase/auth at
  // node_modules/firebase/node_modules/@firebase/auth — so anchoring on the
  // first occurrence silently captures "node" out of "node_modules" and lumps
  // the whole Auth SDK in with the wrong chunk.
  const pkgPath = id.split(/[\\/]node_modules[\\/]/).pop();

  if (/^(react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(pkgPath)) {
    return "react";
  }

  // Firebase ships in two layers: the scoped implementation packages
  // (@firebase/storage) and thin re-export facades under the name the app
  // actually imports (firebase/storage). BOTH must land in the same chunk.
  // Match only the scoped half and the facade stays behind in the entry chunk,
  // where its static `export * from "@firebase/storage"` drags the
  // implementation onto the critical path — silently undoing the dynamic
  // import in src/firebase/storage.js.
  const fb = /^(?:@firebase[\\/]|firebase[\\/])([a-z0-9-]+)/.exec(pkgPath);
  if (fb) {
    const pkg = fb[1];
    if (pkg === "firestore" || pkg === "webchannel-wrapper") return "firebase-firestore";
    if (pkg === "auth") return "firebase-auth";
    if (pkg === "storage") return "firebase-storage";
    return "firebase-core";
  }
  if (pkgPath.startsWith("@tanstack/")) return "query";
}

export default defineConfig({
  plugins: [react()],
  // PORT lets a supervisor (preview harness, container, CI) place the dev
  // server somewhere free; 5173 stays the default for a plain `npm run dev`.
  server: { port: Number(process.env.PORT) || 5173, open: true },
  build: {
    rollupOptions: { output: { manualChunks } },
  },
});
