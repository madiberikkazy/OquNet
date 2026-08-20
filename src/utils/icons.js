// ─── Icon registry ────────────────────────────────────────────────────────────
//
// Every settings icon lives as its own file under public/drawable/ and is
// referenced here by a named export. They currently all hold the SAME
// placeholder artwork on purpose — swapping in the real icon is a matter of
// overwriting one file, with no code change anywhere.
//
// Paths are absolute so they resolve from the site root (public/ is copied
// verbatim into the build output, same as /drawable/logo.svg in index.html).

export const profileIcon       = "/drawable/profile.svg";
export const securityIcon      = "/drawable/security.svg";
export const notificationsIcon = "/drawable/notifications.svg";
export const themeIcon         = "/drawable/theme.svg";
export const languageIcon      = "/drawable/language.svg";
export const infoIcon          = "/drawable/info.svg";
export const supportIcon       = "/drawable/support.svg";
export const logoutIcon        = "/drawable/logout.svg";
export const deleteIcon        = "/drawable/delete.svg";
export const communityIcon     = "/drawable/community.svg";
export const roleIcon          = "/drawable/role.svg";
export const cameraIcon        = "/drawable/camera.svg";
export const settingsIcon      = "/drawable/settings.svg";
export const heartIcon         = "/drawable/heart.svg";
/** Profile screen: the community-standing badge and the share-profile action. */
export const cupIcon           = "/drawable/cup.svg";
export const shareProfileIcon  = "/drawable/share_profile.svg";
/**
 * The two stacks of books either side of the avatar on a profile banner.
 *
 * A pair rather than one file drawn twice: they are not mirror images — the
 * covers and the lean differ — because two identical piles flanking a face read
 * as a rendering bug rather than as artwork. Swapping either file re-skins the
 * banner with no code change, same as every other icon here.
 */
export const leftBookIcon      = "/drawable/left_book.svg";
export const rightBookIcon     = "/drawable/right_book.svg";
/** The app mark itself — a full-bleed tile, so it carries its own background. */
export const logoIcon          = "/drawable/logo.svg";

// ─── Bottom navigation ────────────────────────────────────────────────────────
//
// Two files per tab rather than one tinted by CSS. An <img> cannot be recoloured
// from the outside, and that is the trade this makes on purpose: the artwork
// owns its own colours, so a selected tab can differ from an unselected one by
// more than a hue — a filled shape, a heavier weight, a different glyph
// entirely — and none of it needs a code change. Overwrite the file, reload.

export const NAV_ICONS = Object.freeze({
  home: {
    active:   "/drawable/home_active.svg",
    inactive: "/drawable/home_inactive.svg",
  },
  books: {
    active:   "/drawable/books_active.svg",
    inactive: "/drawable/books_inactive.svg",
  },
  // The bell is no longer a tab — it sits in the corner of the Home header now
  // (see Home.jsx). The pair stays because the icon is still drawn there, and
  // because the notifications screen is still a screen.
  notification: {
    active:   "/drawable/notification_active.svg",
    inactive: "/drawable/notification_inactive.svg",
  },
  // Spelled `activ`/`inactiv` — no trailing "e" — because that is what the two
  // files in public/drawable are actually called. Deliberately not "corrected"
  // to match the tabs above: the filename here has to be the filename on disk,
  // and tidying this one to `chat_active.svg` without renaming the file is a
  // silently blank icon.
  chats: {
    active:   "/drawable/chat_activ.svg",
    inactive: "/drawable/chat_inactiv.svg",
  },
  profile: {
    active:   "/drawable/profile_active.svg",
    inactive: "/drawable/profile_inactive.svg",
  },
});

/** The file for one tab in one state. */
export function navIconSrc(name, active) {
  const pair = NAV_ICONS[name];
  if (!pair) return "";
  return active ? pair.active : pair.inactive;
}

/** Lookup table so a row can name its icon with a plain string. */
export const ICONS = Object.freeze({
  profile:       profileIcon,
  security:      securityIcon,
  notifications: notificationsIcon,
  theme:         themeIcon,
  language:      languageIcon,
  info:          infoIcon,
  support:       supportIcon,
  logout:        logoutIcon,
  delete:        deleteIcon,
  community:     communityIcon,
  role:          roleIcon,
  camera:        cameraIcon,
  settings:      settingsIcon,
  heart:         heartIcon,
  cup:           cupIcon,
  shareProfile:  shareProfileIcon,
  leftBook:      leftBookIcon,
  rightBook:     rightBookIcon,
  logo:          logoIcon,
});

export function iconSrc(name) {
  return ICONS[name] || "";
}
