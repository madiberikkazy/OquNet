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

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  /**
   * viewRole — local-only UI toggle, never written to the database.
   *
   * null  → follow the real user.role from the DB (default)
   * "admin" | "user" → admin has manually switched their view
   *
   * Resets to null whenever the logged-in user changes (login / logout).
   */
  const [viewRole, setViewRole] = useState(null);

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
       * The role that drives the UI (RoleRoute, profile pages, etc.).
       * Defaults to the real DB role; overridden locally when an admin
       * calls switchView().
       */
      viewRole: viewRole ?? user?.role ?? "user",

      /** True only when the user's real DB role is "admin". */
      isAdmin: user?.role === "admin",

      /** True when an admin is currently browsing in user-view mode. */
      isViewingAsUser: user?.role === "admin" && (viewRole ?? user?.role) === "user",

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
        setViewRole(null);
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
        setViewRole(null);
      },

      /**
       * Toggle between admin and user views — LOCAL ONLY, no DB write.
       * Only available to users whose real role is "admin".
       */
      switchView() {
        if (!user || user.role !== "admin") return;
        setViewRole((prev) => {
          const current = prev ?? user.role;
          return current === "admin" ? "user" : "admin";
        });
      },
    }),
    [user, loading, viewRole]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
