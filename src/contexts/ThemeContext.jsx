import { createContext, useContext, useEffect, useState } from "react";
import { safeGet, safeSet } from "../utils/safeStorage.js";

const ThemeContext = createContext({ theme: "light", toggleTheme: () => {}, setTheme: () => {} });

const VALID = new Set(["light", "dark"]);

/**
 * What the OS paints around the app — the Android status bar, the browser tab
 * strip. These are the two `--bg-base` values from index.css; the same pair is
 * hardcoded in the anti-flash script in index.html, which has to run before any
 * stylesheet exists.
 */
const BAR_COLOR = { light: "#ffffff", dark: "#0D1420" };

/**
 * The status bar follows a <meta> tag, not CSS, so it is the one part of the
 * theme that does not come along for free with the `dark` class. The navigation
 * bar and the scrollbars follow `color-scheme`, which index.css sets on :root
 * and .dark — flipping the class is enough for those.
 */
function paintSystemBars(theme) {
  try {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", BAR_COLOR[theme] || BAR_COLOR.light);
  } catch { /* no document during SSR */ }
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const v = safeGet("theme", "light");
    return VALID.has(v) ? v : "light";
  });

  useEffect(() => {
    try {
      const root = document.documentElement;
      if (theme === "dark") root.classList.add("dark");
      else root.classList.remove("dark");
    } catch { /* document may not exist during SSR */ }
    paintSystemBars(theme);
    safeSet("theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }

  function setThemeDirect(val) {
    if (!VALID.has(val)) return;
    setTheme(val);
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme: setThemeDirect }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
