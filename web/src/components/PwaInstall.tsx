import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { canInstall, INSTALL_SIZE_MB, isStandalone, onInstallAvailabilityChange, promptInstall } from "../lib/pwa";
import { useUi } from "../stores/ui";
import { Modal } from "./Modal";

/**
 * "Install Iskan Music" dialog. Shown from the header download button; the
 * browser's own prompt is fired when available (Chrome/Edge/Android), and iOS
 * users get the share-sheet instructions instead.
 */
export function PwaInstallDialog() {
  const open = useUi((s) => s.pwaPromptOpen);
  const setOpen = useUi((s) => s.setPwaOpen);
  const [installable, setInstallable] = useState(canInstall());
  const t = useT();

  useEffect(() => onInstallAvailabilityChange(() => setInstallable(canInstall())), []);

  const standalone = isStandalone();
  const button = !standalone && installable;

  return (
    <Modal open={open} onClose={() => setOpen(false)} title={t.dialogs.installPwaTitle}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">
          {standalone ? t.dialogs.installPwaInstalled : button ? t.dialogs.installPwaBody : t.dialogs.installPwaHow}
        </p>
        {button && (
          <button
            type="button"
            onClick={async () => {
              const ok = await promptInstall();
              if (ok) setOpen(false);
            }}
            className="flex h-12 items-center justify-center gap-2 rounded-lg bg-accent px-6 font-semibold text-accent-ink transition-transform active:scale-[0.98]"
          >
            {INSTALL_SIZE_MB ? t.dialogs.installWithSize(INSTALL_SIZE_MB) : t.common.install}
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="h-9 rounded-lg px-3 text-sm font-medium text-fg-2 hover:bg-surface-3 hover:text-fg"
        >
          {t.dialogs.installPwaDismiss}
        </button>
      </div>
    </Modal>
  );
}
