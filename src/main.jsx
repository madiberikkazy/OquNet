import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import App from "./App.jsx";
import { AuthProvider } from "./contexts/AuthContext.jsx";
import { CommunityProvider } from "./contexts/CommunityContext.jsx";
import { ThemeProvider } from "./contexts/ThemeContext.jsx";
import { LanguageProvider } from "./contexts/LanguageContext.jsx";
import { NotificationProvider } from "./contexts/NotificationContext.jsx";
import { ChatProvider } from "./contexts/ChatContext.jsx";
import { queryClient } from "./lib/queryClient.js";
import { queryPersister, shouldPersistQuery } from "./lib/queryPersister.js";
import "./index.css";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { installGlobalErrorHandlers } from "./utils/logger.js";
import { installAnalytics } from "./utils/analytics.js";

installGlobalErrorHandlers();
// Registers the visibility/pagehide/online flush triggers, and drains
// whatever the previous session left in the queue. A no-op when the reader
// has Do Not Track on.
installAnalytics();

// Buster tied to app version so a deploy discards persisted cache with
// incompatible shape. Bump when Firestore doc shapes change.
// Bumped for the indexed-query migration: books gained `searchPrefixes`, and
// the paged list functions changed the shape of what they return.
//
// v3: the member-profile entry changed shape — it carries the member's posts
// now and no longer carries their owned books — and posts themselves gained a
// comment counter. A cached v2 entry read by v3 code is a screen that throws
// on the way in, which is exactly what this constant is for.
const CACHE_BUSTER = "oqunet-v3";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: queryPersister,
          maxAge: 24 * 60 * 60 * 1000,
          buster: CACHE_BUSTER,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <BrowserRouter>
          <LanguageProvider>
            <ThemeProvider>
              <AuthProvider>
                <NotificationProvider>
                  {/* Above the router, because the unread badge on the tab bar
                      is drawn on every screen — one subscription, not one per
                      visit to the chats tab. */}
                  <ChatProvider>
                    <CommunityProvider>
                      <App />
                    </CommunityProvider>
                  </ChatProvider>
                </NotificationProvider>
              </AuthProvider>
            </ThemeProvider>
          </LanguageProvider>
        </BrowserRouter>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
