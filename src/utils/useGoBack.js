import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * A back button that actually goes back.
 *
 * Navigating to the parent route by name looks the same on screen but *pushes*
 * a new history entry, so the stack grows every time: settings → info → (push)
 * settings, and the hub's own back button then pops straight back into info.
 * Popping is the only thing that undoes a navigation.
 *
 * The fallback is for the case where there is nothing to pop — a deep link, a
 * refresh, or the app opened straight onto this screen. React Router numbers
 * the entries it created in `history.state.idx`, so idx 0 means this screen is
 * the session's first: `navigate(-1)` there would walk out of the app entirely.
 *
 * @param {string} fallback route to use when this screen has no history behind it
 */
export function useGoBack(fallback) {
  const navigate = useNavigate();

  return useCallback(() => {
    const idx = window.history.state?.idx;
    if (typeof idx === "number" && idx > 0) {
      navigate(-1);
      return;
    }
    // `replace` so the fallback doesn't itself become an entry the user has to
    // press back through a second time.
    navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
