import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "../firebase/config.js";
import { getUserById, updateUser } from "../firebase/firestore.js";
import {
  getMockSession,
  signOut as svcSignOut,
  deleteAccount as svcDeleteAccount,
  requestEmailChange as svcRequestEmailChange,
  syncEmailFromAuth,
} from "../firebase/auth.js";
import { setAnalyticsUser } from "../utils/analytics.js";
import { syncSubscription } from "../utils/webPush.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  // Analytics holds the current user id in a module variable so that `track`
  // can be called from anywhere, including code with no access to a React
  // context. This is the one place that knows when it changes — including
  // back to null on sign-out, which matters: events attributed to the
  // previous account after somebody else signs in on the same phone would be
  // wrong in the worst possible direction.
  useEffect(() => { setAnalyticsUser(user?.id); }, [user?.id]);

  // Re-file this device's push subscription with the server, once a session
  // exists. Quiet and idempotent — it asks for nothing, subscribes nothing
  // that was not already subscribed, and does nothing at all for a reader who
  // has never turned push on. It is here because subscriptions rotate and get
  // pruned, and the symptom of a stale one is notifications silently stopping.
  // See utils/webPush.js.
  useEffect(() => {
    if (!user?.id) return;
    syncSubscription();
  }, [user?.id]);

  useEffect(() => {
    let unsubscribe = () => {};
    if (isFirebaseConfigured) {
      unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
  try {
    if (fbUser) {
      const profile = await getUserById(fbUser.uid);
      // An email change is confirmed from the new inbox, outside this app —
      // so the account can come back with an address the profile has never
      // seen. This is where the profile catches up.
      setUser(await syncEmailFromAuth(profile));
    } else {
      setUser(null);
    }
  } catch (err) {
    console.error("Auth state load failed:", err);
    setUser(null);
  } finally {
    setLoading(false);
  }
});
    } else {
      const session = getMockSession();
      if (session?.uid) {
        getUserById(session.uid).then((u) => {
          setUser(u);
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }
    return () => unsubscribe();
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      setUser,

      /**
       * True when the user's DB role is "admin".
       *
       * There is one interface now: every screen an admin sees is the screen a
       * reader sees, and this only decides whether the community they own hands
       * them its management controls on top. It is not a mode — there is
       * nothing to switch into and nothing to switch back from.
       */
      isAdmin: user?.role === "admin",

      async refresh() {
        if (!user?.id) return;
        const fresh = await getUserById(user.id);
        setUser(fresh);
      },
      async updateProfile(patch) {
        if (!user?.id) return;
        await updateUser(user.id, patch);
        setUser({ ...user, ...patch });
      },
      async signOut() {
        await svcSignOut();
        setUser(null);
      },

      /**
       * Ask Firebase to send a confirmation link to a new address. Nothing
       * changes until the user opens it, so there is no local state to update
       * here — except in mock mode, where the change is immediate and the
       * refreshed profile is what the screen should show.
       */
      async changeEmail({ newEmail, password }) {
        const sentTo = await svcRequestEmailChange({ newEmail, password });
        if (!isFirebaseConfigured && user?.id) {
          setUser(await getUserById(user.id));
        }
        return sentTo;
      },

      /**
       * Delete the account for good. Clears the session exactly like signOut
       * does, so ProtectedRoute sends the (now non-existent) user to /auth.
       */
      async deleteAccount({ password } = {}) {
        await svcDeleteAccount({ password });
        setUser(null);
      },
    }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
