import { Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useLang } from "./contexts/LanguageContext.jsx";
import OfflineIndicator from "./components/OfflineIndicator.jsx";
import SystemBars from "./components/SystemBars.jsx";
import { t } from "./utils/i18n.js";
import { lazyRoute } from "./utils/lazyRoute.js";
import { useInstallNotification } from "./utils/useInstallNotification.js";

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
const BookJourney        = lazyRoute(() => import("./pages/user/BookJourney.jsx"));
const PickupBook         = lazyRoute(() => import("./pages/user/PickupBook.jsx"));
const ReturnToOwner      = lazyRoute(() => import("./pages/user/ReturnToOwner.jsx"));
const Notification       = lazyRoute(() => import("./pages/user/Notification.jsx"));
const NotificationDetail = lazyRoute(() => import("./pages/user/NotificationDetail.jsx"));
const Chats              = lazyRoute(() => import("./pages/user/Chats.jsx"));
const Chat               = lazyRoute(() => import("./pages/user/Chat.jsx"));
const NewChat            = lazyRoute(() => import("./pages/user/NewChat.jsx"));
const Profile            = lazyRoute(() => import("./pages/user/Profile.jsx"));
const OwnedBooks         = lazyRoute(() => import("./pages/user/OwnedBooks.jsx"));
const ReadingTimer       = lazyRoute(() => import("./pages/user/ReadingTimer.jsx"));
const ReadingNow         = lazyRoute(() => import("./pages/user/ReadingNow.jsx"));
const CompletedBooks     = lazyRoute(() => import("./pages/user/CompletedBooks.jsx"));
const SavedBooks         = lazyRoute(() => import("./pages/user/SavedBooks.jsx"));
const Settings           = lazyRoute(() => import("./pages/user/Settings.jsx"));
const LikedPosts         = lazyRoute(() => import("./pages/user/LikedPosts.jsx"));
// Writing a post — a screen of its own, reached from the "+" on the feed.
const CreatePost         = lazyRoute(() => import("./pages/user/CreatePost.jsx"));
// One post and its replies — where the comment icon in the feed leads.
const PostDetail         = lazyRoute(() => import("./pages/user/PostDetail.jsx"));

// Settings sub-screens — one topic each, reached from the settings hub.
const PersonalData         = lazyRoute(() => import("./pages/user/settings/PersonalData.jsx"));
// Proving a phone number by SMS — the one gate on joining a community.
const PhoneVerify          = lazyRoute(() => import("./pages/user/settings/PhoneVerify.jsx"));
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
// Step two of leaving: the code that brings one of the member's books home.
const ReturnBook         = lazyRoute(() => import("./pages/community/ReturnBook.jsx"));
const UserProfile        = lazyRoute(() => import("./pages/community/UserProfile.jsx"));
// Ejecting a member, and settling the books they are holding on the way out.
const RemoveMember       = lazyRoute(() => import("./pages/community/RemoveMember.jsx"));
// The two lists behind the follow counters — one screen, both directions.
const FollowList         = lazyRoute(() => import("./pages/user/FollowList.jsx"));

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
  // Says hello once, when the app is added to the home screen. Here rather than
  // on a screen, because the install can happen on any of them.
  useInstallNotification();
  return (
    <>
      {/* Paints the OS strips above and below the app the colour of whatever
          the current screen puts against them. Inside the router, because the
          answer changes with the route. */}
      <SystemBars />
      <OfflineIndicator />
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
            {/* Where the book has been, read off its loans. */}
            <Route path="/books/:id/journey" element={<BookJourney />} />

            {/* Pickup flow — replaces the old /request route */}
            <Route path="/books/:id/pickup" element={<PickupBook />} />

            {/* Handing a book back, in two halves — the same shape as a pickup,
                run in the other direction. The holder offers and carries the
                code; the owner accepts and types it. `ReturnBook` is the same
                component the leave flow uses; only what surrounds the four
                digits differs, which is what `mode` selects. */}
            <Route path="/books/:id/return" element={<ReturnToOwner />} />
            <Route path="/books/:bookId/return/confirm" element={<ReturnBook mode="handover" />} />

            {/* Admin-only routes — gated by the real DB role */}
            <Route element={<ProtectedRoute adminOnly />}>
              <Route path="/books/add" element={<AddBook />} />
              <Route path="/books/:id/edit" element={<EditBook />} />
            </Route>

            {/* Conversations. The thread is addressed by the other person's
                id, not the chat's: every entry point already has one, and the
                chat id is derived from the pair rather than looked up. */}
            <Route path="/chats" element={<Chats />} />
            {/* Static before dynamic — React Router ranks it that way on its
                own, and no account id can be the word "new" anyway. */}
            <Route path="/chats/new" element={<NewChat />} />
            <Route path="/chats/:userId" element={<Chat />} />

            {/* Deliberately not a modal over the feed: writing is the one
                thing in this app you do at length. */}
            <Route path="/posts/new" element={<CreatePost />} />
            <Route path="/posts/:id" element={<PostDetail />} />

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
            <Route path="/settings/phone"         element={<PhoneVerify />} />
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
            <Route path="/community/:id/leave/return/:bookId" element={<ReturnBook />} />
            {/* A screen rather than a dialog: a member on their way out may be
                holding books, and each one needs somewhere to go. */}
            <Route path="/community/:id/members/:userId/remove" element={<RemoveMember />} />
            <Route path="/users/:id" element={<UserProfile />} />
            {/* Who follows this person, and who they follow. The same two
                routes serve the reader's own profile — a followers list is the
                same list whoever opened it. */}
            <Route path="/users/:id/followers" element={<FollowList mode="followers" />} />
            <Route path="/users/:id/following" element={<FollowList mode="following" />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
