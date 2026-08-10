/**
 * Notification Service
 * Handles sounds, browser notifications, and notification preferences
 */

// System sounds - using Web Audio API to generate simple tones
const audioContext = typeof AudioContext !== 'undefined' ? new AudioContext() : null;

function generateTone(frequency, duration, type = 'sine') {
  if (!audioContext) return null;
  
  try {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    oscillator.frequency.value = frequency;
    oscillator.type = type;
    
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);
    
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
    
    return true;
  } catch (err) {
    console.warn('Could not generate tone:', err);
    return false;
  }
}

// System sounds that can be used for notifications
export const NOTIFICATION_SOUNDS = {
  bell: { 
    name: 'Bell', 
    play: () => {
      generateTone(800, 0.15);
      setTimeout(() => generateTone(600, 0.1), 150);
    }
  },
  chime: { 
    name: 'Chime', 
    play: () => {
      generateTone(1000, 0.1);
      setTimeout(() => generateTone(1200, 0.1), 100);
      setTimeout(() => generateTone(1400, 0.12), 200);
    }
  },
  ding: { 
    name: 'Ding', 
    play: () => {
      generateTone(1200, 0.2);
    }
  },
  ping: { 
    name: 'Ping', 
    play: () => {
      generateTone(1500, 0.1);
    }
  },
  pop: { 
    name: 'Pop', 
    play: () => {
      generateTone(500, 0.05);
    }
  },
  alert: { 
    name: 'Alert', 
    play: () => {
      generateTone(900, 0.1);
      setTimeout(() => generateTone(900, 0.1), 120);
    }
  },
  none: { 
    name: 'None (Silent)', 
    play: () => {} 
  },
};

// Get default preferences
export function getDefaultNotificationPreferences() {
  return {
    soundEnabled: true,
    selectedSound: 'bell',
    browserNotificationsEnabled: true,
    notificationsEnabled: true,
  };
}

// Load preferences from localStorage
export function loadNotificationPreferences() {
  try {
    const stored = localStorage.getItem('notificationPreferences');
    if (stored) {
      return { ...getDefaultNotificationPreferences(), ...JSON.parse(stored) };
    }
  } catch (err) {
    console.error('Failed to load notification preferences:', err);
  }
  return getDefaultNotificationPreferences();
}

// Save preferences to localStorage
export function saveNotificationPreferences(prefs) {
  try {
    localStorage.setItem('notificationPreferences', JSON.stringify(prefs));
  } catch (err) {
    console.error('Failed to save notification preferences:', err);
  }
}

// Play notification sound
export function playNotificationSound(soundKey = 'bell') {
  try {
    const prefs = loadNotificationPreferences();
    
    if (!prefs.soundEnabled || !prefs.notificationsEnabled) {
      return;
    }

    const sound = NOTIFICATION_SOUNDS[soundKey] || NOTIFICATION_SOUNDS.bell;
    if (sound.play) {
      sound.play();
    }
  } catch (err) {
    console.error('Error playing notification sound:', err);
  }
}

// Request browser notification permission
export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    console.log('This browser does not support notifications');
    return false;
  }

  if (Notification.permission === 'granted') {
    return true;
  }

  if (Notification.permission !== 'denied') {
    try {
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    } catch (err) {
      console.error('Error requesting notification permission:', err);
      return false;
    }
  }

  return false;
}

// The app icon, as the manifest names it. This used to point at '/index.html',
// which is a document and not an image — so every notification that did get
// shown was drawn with the browser's generic fallback.
const NOTIFICATION_ICON = '/drawable/logo.svg';

/**
 * Show a notification in the phone's own notification system.
 *
 * It goes through the service worker registration rather than
 * `new Notification()`, and that is not a preference — it is the only thing
 * that works where this app actually runs. Chrome on Android throws
 * "Illegal constructor" for the page-level constructor, and an installed iOS
 * PWA has no page-level Notification to construct at all. A notification the
 * service worker owns also outlives the tab, and taps land in the
 * `notificationclick` handler in sw.js, which focuses the app and opens
 * `data.url`.
 *
 * The bare constructor stays as the desktop fallback for a browser with
 * notification support but no service worker (an unregistered dev page).
 */
export async function showBrowserNotification(title, options = {}) {
  try {
    const prefs = loadNotificationPreferences();

    if (!prefs.browserNotificationsEnabled || !prefs.notificationsEnabled) {
      return;
    }

    if (!('Notification' in window)) {
      console.log('Browser notifications not supported');
      return;
    }

    if (Notification.permission !== 'granted') {
      // Never ask from here. A permission prompt has to answer a question the
      // user just asked, and this fires on a background poll — the settings
      // screen is where they ask for it.
      return;
    }

    const payload = {
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      ...options,
    };

    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      await registration.showNotification(title, payload);
      return;
    }

    const notification = new Notification(title, payload);
    setTimeout(() => notification.close(), 5000);
    return notification;
  } catch (err) {
    console.error('Error showing browser notification:', err);
  }
}

// Send notification (both sound + browser notification)
export async function sendNotification(title, options = {}) {
  try {
    const prefs = loadNotificationPreferences();
    
    if (!prefs.notificationsEnabled) {
      return;
    }

    // Play sound
    if (prefs.soundEnabled) {
      playNotificationSound(prefs.selectedSound);
    }

    // Show browser notification
    if (prefs.browserNotificationsEnabled) {
      await showBrowserNotification(title, options);
    }
  } catch (err) {
    console.error('Error sending notification:', err);
  }
}

// Check if notifications are supported
export function areNotificationsSupported() {
  return 'Notification' in window;
}

// Get current notification permission status
export function getNotificationPermissionStatus() {
  if (!('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission; // 'granted', 'denied', or 'default'
}
