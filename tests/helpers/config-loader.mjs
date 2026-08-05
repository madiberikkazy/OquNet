// Resolve hook: swap src/firebase/config.js for a stub.
//
// config.js reads `import.meta.env`, which only exists under Vite — importing it
// from plain Node throws before any test can run. The stub also pins
// `isFirebaseConfigured` to false, which is the point: it selects the
// localStorage branch of the data layer, so these tests exercise the real
// firestore.js rather than a reimplementation of it.
import { pathToFileURL } from "node:url";

const STUB = new URL("./config-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (resolved.url.endsWith("/src/firebase/config.js")) {
    return { ...resolved, url: STUB, shortCircuit: true };
  }
  return resolved;
}
