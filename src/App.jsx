import { Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
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
// first time its route renders. The two book-editing screens matter most here —
// the large majority of accounts never open them.
const Home               = lazyRoute(() => import("./pages/user/Home.jsx"));
const Books              = lazyRoute(() => import("./pages/user/Books.jsx"));
const BookDetail         = lazyRoute(() => import("./pages/user/BookDetail.jsx"));
const PickupBook         = lazyRoute(() => import("./pages/user/PickupBook.jsx"));
const Notification       = lazyRoute(() => import("./pages/user/Notification.jsx"));
const NotificationDetail = lazyRoute(() => import("./pages/user/NotificationDetail.jsx"));
const Profile            = lazyRoute(() => import("./pages/user/Profile.jsx"));
const OwnedBooks         = lazyRoute(() => import("./pages/user/OwnedBooks.jsx"));
const ReadingTimer       = lazyRoute(() => import("./pages/user/ReadingTimer.jsx"));
const ReadingNow         = lazyRoute(() => import("./pages/user/ReadingNow.jsx"));
const CompletedBooks     = lazyRoute(() => import("./pages/user/CompletedBooks.jsx"));
const SavedBooks         = lazyRoute(() => import("./pages/user/SavedBooks.jsx"));
const Settings           = lazyRoute(() => import("./pages/user/Settings.jsx"));
const LikedPosts         = lazyRoute(() => import("./pages/user/LikedPosts.jsx"));

// Settings sub-screens — one topic each, reached from the settings hub.
const PersonalData         = lazyRoute(() => import("./pages/user/settings/PersonalData.jsx"));
const SecuritySettings     = lazyRoute(() => import("./pages/user/settings/Security.jsx"));
const NotificationSettings = lazyRoute(() => import("./pages/user/settings/NotificationSettings.jsx"));
const ThemeSettings        = lazyRoute(() => import("./pages/user/settings/ThemeSettings.jsx"));
const LanguageSettings     = lazyRoute(() => import("./pages/user/settings/LanguageSettings.jsx"));
const AboutApp             = lazyRoute(() => import("./pages/user/settings/AboutApp.jsx"));
const Support              = lazyRoute(() => import("./pages/user/settings/Support.jsx"));
const CommunitySettings    = lazyRoute(() => import("./pages/user/settings/CommunitySettings.jsx"));
const DeleteAccount        = lazyRoute(() => import("./pages/user/settings/DeleteAccount.jsx"));

// Community management. There are no admin *screens* any more — the four tabs
// are the same app for everyone — only these two forms, which an admin reaches
// from the books tab of the community they own.
const AddBook            = lazyRoute(() => import("./pages/admin/AddBook.jsx"));
const EditBook           = lazyRoute(() => import("./pages/admin/EditBook.jsx"));

const CreateCommunity    = lazyRoute(() => import("./pages/community/CreateCommunity.jsx"));
const JoinCommunity      = lazyRoute(() => import("./pages/community/JoinCommunity.jsx"));
const CommunityProfile   = lazyRoute(() => import("./pages/community/CommunityProfile.jsx"));
const EditCommunity      = lazyRoute(() => import("./pages/community/EditCommunity.jsx"));
const LeaveCommunity     = lazyRoute(() => import("./pages/community/LeaveCommunity.jsx"));
const UserProfile        = lazyRoute(() => import("./pages/community/UserProfile.jsx"));

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
            {/* The four tabs are one app: an admin sees exactly what a reader
                sees. Managing a community happens on the community's own page,
                which is where the extra controls live. */}
            <Route path="/" element={<Home />} />
            <Route path="/books" element={<Books />} />
            <Route path="/books/:id" element={<BookDetail />} />

            {/* Pickup flow — replaces the old /request route */}
            <Route path="/books/:id/pickup" element={<PickupBook />} />

            {/* Admin-only routes — gated by the real DB role */}
            <Route element={<ProtectedRoute adminOnly />}>
              <Route path="/books/add" element={<AddBook />} />
              <Route path="/books/:id/edit" element={<EditBook />} />
            </Route>

            <Route path="/notifications" element={<Notification />} />
            {/* Join and leave requests are decided here, by whoever the request
                was addressed to — the list itself is the same for everyone. */}
            <Route path="/notifications/:id" element={<NotificationDetail />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/profile/owned"     element={<OwnedBooks />} />
            <Route path="/profile/timer"     element={<ReadingTimer />} />
            <Route path="/profile/reading"   element={<ReadingNow />} />
            <Route path="/profile/completed" element={<CompletedBooks />} />
            <Route path="/profile/saved"     element={<SavedBooks />} />
            <Route path="/profile/liked"     element={<LikedPosts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/settings/profile"       element={<PersonalData />} />
            <Route path="/settings/security"      element={<SecuritySettings />} />
            <Route path="/settings/notifications" element={<NotificationSettings />} />
            <Route path="/settings/theme"         element={<ThemeSettings />} />
            <Route path="/settings/language"      element={<LanguageSettings />} />
            <Route path="/settings/about"         element={<AboutApp />} />
            <Route path="/settings/support"       element={<Support />} />
            <Route path="/settings/community"     element={<CommunitySettings />} />
            <Route path="/settings/delete"        element={<DeleteAccount />} />

            <Route path="/community/create" element={<CreateCommunity />} />
            <Route path="/community/join" element={<JoinCommunity />} />
            <Route path="/community/:id" element={<CommunityProfile />} />
            {/* Owner-only in practice — the screen bounces anyone else. */}
            <Route path="/community/:id/edit" element={<EditCommunity />} />
            <Route path="/community/:id/leave" element={<LeaveCommunity />} />
            <Route path="/users/:id" element={<UserProfile />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
