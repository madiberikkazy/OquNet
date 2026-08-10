import { createContext, useContext, useEffect, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./AuthContext.jsx";
import { listNotifications } from "../firebase/firestore.js";
import { sendNotification } from "../utils/notificationService.js";
import { qk } from "../lib/queryKeys.js";

// React Query owns the notification list now. Benefits:
// - No 3-second polling: refetchInterval only fires while tab is visible,
//   and refetchOnWindowFocus catches the "user just came back" case.
// - Instant renders on route return (staleTime + persisted cache).
// - Dedupe: multiple `useNotifications()` consumers share one fetch.
// - Consumers keep the same public shape as before.

const NotificationContext = createContext(null);

const REFETCH_INTERVAL = 15_000;

export function NotificationProvider({ children }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevUnreadIdsRef = useRef(new Set());

  const query = useQuery({
    queryKey: user?.id ? qk.notifications.forUser(user.id) : ["notifications", "anonymous"],
    queryFn: () => listNotifications(user.id),
    enabled: !!user?.id,
    // Match app-wide defaults but poll while the tab is visible so the badge
    // stays approximately live without hammering Firestore.
    refetchInterval: REFETCH_INTERVAL,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });

  const notifications = query.data ?? [];
  const unreadCount = useMemo(
    () => notifications.reduce((n, x) => n + (x.read ? 0 : 1), 0),
    [notifications]
  );

  // Fire a system notification when a NEW unread item shows up (id-based diff,
  // not a count comparison — count-based diffs miscount on read/delete).
  useEffect(() => {
    const currentIds = new Set(
      notifications.filter((n) => !n.read).map((n) => n.id)
    );
    if (prevUnreadIdsRef.current.size > 0) {
      const fresh = notifications.find((n) => !n.read && !prevUnreadIdsRef.current.has(n.id));
      if (fresh) {
        sendNotification(fresh.title, {
          body: fresh.body,
          tag: `notification-${fresh.id}`,
          // Where a tap should land. sw.js reads this in `notificationclick`,
          // focuses the app if it is already open, and navigates here — so the
          // notification opens the thing it is about rather than the home feed.
          data: { url: `/notifications/${fresh.id}` },
        });
      }
    }
    prevUnreadIdsRef.current = currentIds;
  }, [notifications]);

  const loadNotifications = useCallback(async () => {
    if (!user?.id) return;
    await queryClient.invalidateQueries({ queryKey: qk.notifications.forUser(user.id) });
  }, [queryClient, user?.id]);

  const markAllAsRead = useCallback(() => {
    if (!user?.id) return;
    queryClient.setQueryData(qk.notifications.forUser(user.id), (prev = []) =>
      prev.map((n) => ({ ...n, read: true }))
    );
  }, [queryClient, user?.id]);

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      loading: query.isLoading,
      loadNotifications,
      markAllAsRead,
    }),
    [notifications, unreadCount, query.isLoading, loadNotifications, markAllAsRead]
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used inside <NotificationProvider>");
  }
  return ctx;
}
