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
import { queryClient } from "./lib/queryClient.js";
import { queryPersister } from "./lib/queryPersister.js";
import "./index.css";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { installGlobalErrorHandlers } from "./utils/logger.js";

installGlobalErrorHandlers();

// Buster tied to app version so a deploy discards persisted cache with
// incompatible shape. Bump when Firestore doc shapes change.
const CACHE_BUSTER = "oqunet-v1";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: queryPersister,
          maxAge: 24 * 60 * 60 * 1000,
          buster: CACHE_BUSTER,
        }}
      >
        <BrowserRouter>
          <LanguageProvider>
            <ThemeProvider>
              <AuthProvider>
                <NotificationProvider>
                  <CommunityProvider>
                    <App />
                  </CommunityProvider>
                </NotificationProvider>
              </AuthProvider>
            </ThemeProvider>
          </LanguageProvider>
        </BrowserRouter>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
