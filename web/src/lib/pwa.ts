import { desktop } from "./desktop";

/**
 * PWA install support. Chrome/Edge expose an install prompt via beforeinstallprompt;
 * iOS Safari has none (users install from the share sheet), so there we only detect.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

declare global {
  interface Window {
    __iskanInstallEvent?: InstallPromptEvent | null;
  }
}

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (window.navigator as { standalone?: boolean }).standalone === true;

/** Which install flow the user has to follow, so the dialog never tells an Android user about the iPhone share sheet. */
export function installPlatform(): "ios" | "android" | "other" {
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

// The event can fire before this module runs: index.html catches it in a plain inline script and leaves it on window.
if (window.__iskanInstallEvent) deferred = window.__iskanInstallEvent;

const sync = () => {
  for (const fn of listeners) fn();
};

// The inline script in index.html announces the event it caught, and mirrors appinstalled as well.
window.addEventListener("iskan:install-available", () => {
  deferred = window.__iskanInstallEvent ?? null;
  sync();
});

if (!desktop) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    window.__iskanInstallEvent = deferred;
    sync();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    window.__iskanInstallEvent = null;
    sync();
  });
}

/** Whether an install prompt can be shown right now. */
export const canInstall = (): boolean => deferred !== null;

/** Fires the native install prompt. Resolves whether the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const p = deferred;
  deferred = null;
  await p.prompt();
  const { outcome } = await p.userChoice;
  return outcome === "accepted";
}

/** Notifies when install becomes possible (or is used up). Returns an unsubscribe function. */
export function onInstallAvailabilityChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * What an install downloads, in decimal MB. The build measures the precached files and writes the number in
 * (see the appSize plugin in vite.config.ts); it stays empty during development.
 */
const RAW_SIZE = "__APP_SIZE__";
export const INSTALL_SIZE_MB = RAW_SIZE.startsWith("__") ? "" : RAW_SIZE;
