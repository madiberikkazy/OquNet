import { createContext, useContext, useEffect, useState } from "react";
import { safeGet, safeSet } from "../utils/safeStorage.js";
import { resetSystemBars, syncSystemBars } from "../utils/systemBars.js";

const ThemeContext = createContext({ theme: "light", toggleTheme: () => {}, setTheme: () => {} });

const VALID = new Set(["light", "dark"]);

/**
 * The bars the OS paints around the app do not come along for free with the
 * `dark` class: the status bar follows a <meta> tag rather than CSS.
 *
 * Their colour is not a property of the theme, though — it is a property of the
 * screen, since the top of one page is a blue banner and the top of the next is
 * the page background. So this does not pick a colour; it tells
 * utils/systemBars.js that the palette moved and the two edges are worth
 * measuring again, after the class flip above has actually painted.
 *
 * Scrollbars and native controls are a different mechanism again and need
 * nothing here: they follow `color-scheme`, which index.css sets on :root and
 * .dark. The anti-flash script in index.html covers the first frame, before any
 * of this has run.
 */
function repaintSystemBars() {
  try {
    resetSystemBars();
    requestAnimationFrame(syncSystemBars);
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
    repaintSystemBars();
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
