import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./contexts/AuthContext.jsx";
import { useLang } from "./contexts/LanguageContext.jsx";
import NotificationToast from "./components/NotificationToast.jsx";
import OfflineIndicator from "./components/OfflineIndicator.jsx";

import Register from "./pages/auth/Register.jsx";
import Login from "./pages/auth/Login.jsx";

import Home from "./pages/user/Home.jsx";
import Books from "./pages/user/Books.jsx";
import BookDetail from "./pages/user/BookDetail.jsx";
import PickupBook from "./pages/user/PickupBook.jsx";
import Notification from "./pages/user/Notification.jsx";
import NotificationDetail from "./pages/user/NotificationDetail.jsx";
import Profile from "./pages/user/Profile.jsx";
import OwnedBooks from "./pages/user/OwnedBooks.jsx";
import ReadingNow from "./pages/user/ReadingNow.jsx";
import CompletedBooks from "./pages/user/CompletedBooks.jsx";
import SavedBooks from "./pages/user/SavedBooks.jsx";
import Settings from "./pages/user/Settings.jsx";

import AdminHome from "./pages/admin/AdminHome.jsx";
import AdminBooks from "./pages/admin/AdminBooks.jsx";
import AddBook from "./pages/admin/AddBook.jsx";
import EditBook from "./pages/admin/EditBook.jsx";
import AdminNotification from "./pages/admin/AdminNotification.jsx";
import AdminProfile from "./pages/admin/AdminProfile.jsx";
import AdminMembers from "./pages/admin/AdminMembers.jsx";

import CreateCommunity from "./pages/community/CreateCommunity.jsx";
import JoinCommunity from "./pages/community/JoinCommunity.jsx";
import CommunityProfile from "./pages/community/CommunityProfile.jsx";
import UserProfile from "./pages/community/UserProfile.jsx";

import ProtectedRoute from "./components/ProtectedRoute.jsx";

function RoleRoute({ userElement, adminElement }) {
  const { viewRole } = useAuth();
  return viewRole === "admin" ? adminElement : userElement;
}

export default function App() {
  useLang(); // re-render entire tree whenever language changes so all t.key proxies update
  return (
    <>
      <OfflineIndicator />
      <NotificationToast />
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
          <Route path="/users/:id" element={<UserProfile />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}