/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // All colours are CSS-variable-driven so dark mode just flips the vars.
        brand: {
          DEFAULT: "var(--brand-500)",
          50:  "var(--brand-50)",
          100: "var(--brand-100)",
          200: "var(--brand-200)",
          500: "var(--brand-500)",
          600: "var(--brand-600)",
          700: "var(--brand-700)",
        },
        ink: {
          900: "var(--ink-900)",
          700: "var(--ink-700)",
          500: "var(--ink-500)",
          300: "var(--ink-300)",
          100: "var(--ink-100)",
        },
        // Named surface tokens — used in MobileShell, BottomNav, cards
        base:    "var(--bg-base)",
        surface: "var(--bg-surface)",
        ok:      "var(--ok)",
        okSoft:  "var(--okSoft)",
        warn:    "var(--warn)",
        warnSoft:"var(--warnSoft)",
        bad:     "var(--bad)",
        badSoft: "var(--badSoft)",
        statPurple: "var(--stat-purple)",
        statGreen:  "var(--stat-green)",
        statRed:    "var(--stat-red)",
        statPink:   "var(--stat-pink)",
        // Soft brand-tinted panel, and the accent text that belongs on it. Use
        // these rather than brand-50/brand-700 for anything panel-sized: unlike
        // the brand ramp, both flip in dark mode, so ink on the panel stays
        // legible. See the token comment in index.css.
        tint:    "var(--tint)",
        tintInk: "var(--tint-ink)",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      },
      boxShadow: { soft: "0 4px 16px rgba(15, 23, 36, 0.06)" },
      borderRadius: { xl: "14px", "2xl": "20px" },
    },
  },
  plugins: [],
};
