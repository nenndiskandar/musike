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

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (window.navigator as { standalone?: boolean }).standalone === true;

if (!desktop) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    for (const fn of listeners) fn();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    for (const fn of listeners) fn();
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
