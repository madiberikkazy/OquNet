import { Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./contexts/AuthContext.jsx";
import { useLang } from "./contexts/LanguageContext.jsx";
import NotificationToast from "./components/NotificationToast.jsx";
import OfflineIndicator from "./components/OfflineIndicator.jsx";
import { t } from "./utils/i18n.js";
import { lazyRoute } from "./utils/lazyRoute.js";

// Eager: the auth screens and the route gate. These are on the critical path
// for a signed-out visitor, so splitting them would only add a round trip.
import Register from "./pages/auth/Register.jsx";
import Login from "./pages/auth/Login.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";

// Lazy: everything behind the gate. Each becomes its own chunk, fetched the
// first time its route renders. Admin screens matter most here — the large
// majority of accounts are not admins and should never download them.
const Home               = lazyRoute(() => import("./pages/user/Home.jsx"));
const Books              = lazyRoute(() => import("./pages/user/Books.jsx"));
const BookDetail         = lazyRoute(() => import("./pages/user/BookDetail.jsx"));
const PickupBook         = lazyRoute(() => import("./pages/user/PickupBook.jsx"));
const Notification       = lazyRoute(() => import("./pages/user/Notification.jsx"));
const NotificationDetail = lazyRoute(() => import("./pages/user/NotificationDetail.jsx"));
const Profile            = lazyRoute(() => import("./pages/user/Profile.jsx"));
const OwnedBooks         = lazyRoute(() => import("./pages/user/OwnedBooks.jsx"));
const ReadingNow         = lazyRoute(() => import("./pages/user/ReadingNow.jsx"));
const CompletedBooks     = lazyRoute(() => import("./pages/user/CompletedBooks.jsx"));
const SavedBooks         = lazyRoute(() => import("./pages/user/SavedBooks.jsx"));
const Settings           = lazyRoute(() => import("./pages/user/Settings.jsx"));

const AdminHome          = lazyRoute(() => import("./pages/admin/AdminHome.jsx"));
const AdminBooks         = lazyRoute(() => import("./pages/admin/AdminBooks.jsx"));
const AddBook            = lazyRoute(() => import("./pages/admin/AddBook.jsx"));
const EditBook           = lazyRoute(() => import("./pages/admin/EditBook.jsx"));
const AdminNotification  = lazyRoute(() => import("./pages/admin/AdminNotification.jsx"));
const AdminProfile       = lazyRoute(() => import("./pages/admin/AdminProfile.jsx"));
const AdminMembers       = lazyRoute(() => import("./pages/admin/AdminMembers.jsx"));

const CreateCommunity    = lazyRoute(() => import("./pages/community/CreateCommunity.jsx"));
const JoinCommunity      = lazyRoute(() => import("./pages/community/JoinCommunity.jsx"));
const CommunityProfile   = lazyRoute(() => import("./pages/community/CommunityProfile.jsx"));
const LeaveCommunity     = lazyRoute(() => import("./pages/community/LeaveCommunity.jsx"));
const UserProfile        = lazyRoute(() => import("./pages/community/UserProfile.jsx"));

function RoleRoute({ userElement, adminElement }) {
  const { viewRole } = useAuth();
  // Only the branch that is actually returned gets rendered, so only that
  // element's chunk is fetched — building the other JSX element is free.
  return viewRole === "admin" ? adminElement : userElement;
}

// Matches ProtectedRoute's loading state so a gated route doesn't visibly
// swap between two different spinners while it resolves.
function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center text-ink-500">
      {t.loading}
    </div>
  );
}

export default function App() {
  useLang(); // re-render entire tree whenever language changes so all t.key proxies update
  return (
    <>
      <OfflineIndicator />
      <NotificationToast />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/auth/register" element={<Register />} />
          <Route path="/auth/login" element={<Login />} />

          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<RoleRoute userElement={<Home />} adminElement={<AdminHome />} />} />
            <Route path="/books" element={<RoleRoute userElement={<Books />} adminElement={<AdminBooks />} />} />
            <Route path="/books/:id" element={<BookDetail />} />

            {/* Pickup flow — replaces the old /request route */}
            <Route path="/books/:id/pickup" element={<PickupBook />} />

            {/* Admin-only routes — gated by the real DB role */}
            <Route element={<ProtectedRoute adminOnly />}>
              <Route path="/books/add" element={<AddBook />} />
              <Route path="/books/:id/edit" element={<EditBook />} />
              <Route path="/admin/members" element={<AdminMembers />} />
            </Route>

            <Route path="/notifications" element={<RoleRoute userElement={<Notification />} adminElement={<AdminNotification />} />} />
            {/* Notification detail — shared between user and admin */}
            <Route path="/notifications/:id" element={<NotificationDetail />} />
            <Route path="/profile" element={<RoleRoute userElement={<Profile />} adminElement={<AdminProfile />} />} />
            <Route path="/profile/owned"     element={<OwnedBooks />} />
            <Route path="/profile/reading"   element={<ReadingNow />} />
            <Route path="/profile/completed" element={<CompletedBooks />} />
            <Route path="/profile/saved"     element={<SavedBooks />} />
            <Route path="/settings" element={<Settings />} />

            <Route path="/community/create" element={<CreateCommunity />} />
            <Route path="/community/join" element={<JoinCommunity />} />
            <Route path="/community/:id" element={<CommunityProfile />} />
            <Route path="/community/:id/leave" element={<LeaveCommunity />} />
            <Route path="/users/:id" element={<UserProfile />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
