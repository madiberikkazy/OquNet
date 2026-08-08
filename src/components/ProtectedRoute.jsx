import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import { t } from "../utils/i18n.js";

/**
 * Gates a subtree of routes behind authentication.
 *
 * Pass `adminOnly` to additionally require the DB role to be "admin" — the two
 * book forms reached from a community page are the only routes that use it.
 * The role comes from the profile document, never from anything the client
 * holds, so there is no view to switch into that would open these.
 */
export default function ProtectedRoute({ adminOnly = false }) {
  const { user, loading, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ink-500">
        {t.loading}
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/auth/login" replace state={{ from: location.pathname }} />;
  }
  if (adminOnly && !isAdmin) {
    // Don't reveal a 404 vs. permission diff — just bounce home.
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
