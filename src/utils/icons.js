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
/** The app mark itself — a full-bleed tile, so it carries its own background. */
export const logoIcon          = "/drawable/logo.svg";

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
  logo:          logoIcon,
});

export function iconSrc(name) {
  return ICONS[name] || "";
}
