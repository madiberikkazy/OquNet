import { createNotification } from "../firebase/firestore.js";
import {
  ensureNotificationPermission,
  markNotificationAnnounced,
  sendNotification,
} from "./notificationService.js";
import { safeGet, safeRemove, safeSet } from "./safeStorage.js";
import { logger } from "./logger.js";
import { t } from "./i18n.js";

// The message itself. The React side of this — which install actually looks
// like on each platform — is in useInstallNotification.js.

/** Set when the app was installed but nobody was signed in to tell. */
export const PENDING_KEY = "installPending";

/** Per account, because the message lands in that account's notification list. */
export function notifiedKey(userId) {
  return `installNotified:${userId}`;
}

/**
 * Tell the user, once, that OquNet is now on their home screen.
 *
 * Two notifications, deliberately: a document in Firestore, so the message is
 * in the in-app list next to everything else and survives being missed, and the
 * OS notification, which is the one that actually appears — and which doubles
 * as proof that notifications work from the installed app, on the one occasion
 * where that is exactly what the user is wondering.
 *
 * The write comes first and the OS notification second, so a refused permission
 * still leaves the message somewhere the user can find it.
 */
export async function announceInstall(userId) {
  if (!userId) return null;

  const key = notifiedKey(userId);
  if (safeGet(key)) return null;

  // Claimed before the write, not after: `appinstalled` firing twice would
  // otherwise put two identical messages in the list while the first is still
  // in flight. Released again if the write fails, so someone who was offline at
  // the moment of installing still gets it on the next launch.
  safeSet(key, String(Date.now()));

  let created;
  try {
    created = await createNotification({
      recipientId: userId,
      title: t.installedTitle,
      body: t.installedBody,
      type: "app-installed",
    });
  } catch (err) {
    safeRemove(key);
    logger.error("install.notify", err?.message, { code: err?.code });
    return null;
  }

  safeRemove(PENDING_KEY);

  // The one place outside settings that asks for permission. The user has just
  // installed OquNet — this is the moment the question makes sense, and an
  // installed app that cannot notify is half an app. On iOS the ask waits for
  // their next tap; the in-app message is already written either way.
  const permitted = await ensureNotificationPermission();
  if (!permitted) return created;

  // The same tag and destination the notification poll would have used, and
  // claimed here so that poll does not say it a second time when the document
  // comes back to it.
  markNotificationAnnounced(created.id);
  await sendNotification(t.installedTitle, {
    body: t.installedBody,
    tag: `notification-${created.id}`,
    data: { url: `/notifications/${created.id}` },
  });

  return created;
}
