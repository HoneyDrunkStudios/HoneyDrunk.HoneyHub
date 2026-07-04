import { useEffect, useRef, useState, type ReactElement } from "react";
import type { BackendCapability } from "@honeydrunk/honeyhub-types";
import { BridgeSettings } from "../../BridgeSettings";
import { NotificationsSettings } from "../../NotificationsSettings";
import { ThemeSettings } from "../../ThemeSettings";
import type { NotificationPrefs } from "../../notifications";
import type { ThemeId } from "../../theme";
import type { BridgeSettingsState } from "../../settingsModel";
import type { Plans } from "../../plans";
import type { WireClient } from "../../wire/client";
import {
  isPageVisible,
  TOGGLEABLE_PAGES,
  type PagePrefs
} from "../../pagePrefs";

/** The settings sections, shown as a left-hand vertical nav. Order matters. */
type SectionId = "general" | "pages" | "bridge" | "notifications";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "pages", label: "Pages" },
  { id: "bridge", label: "Bridge" },
  { id: "notifications", label: "Notifications" }
];

export interface SettingsModalProps {
  settings: BridgeSettingsState;
  onSettingsChange: (next: BridgeSettingsState) => void;
  catalog: BackendCapability[];
  client: WireClient;
  plans: Plans;
  onPlansChange: (next: Plans) => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  notificationPrefs: NotificationPrefs;
  onNotificationPrefsChange: (prefs: NotificationPrefs) => void;
  pagePrefs: PagePrefs;
  onPagePrefsChange: (prefs: PagePrefs) => void;
  onClose: () => void;
}

/** Settings as a modal overlay with a left section-nav, so the distinct groups (theme, page
    visibility, bridge/connectors, notifications) are easier to tell apart than a single scroll.
    Composes the existing settings components unchanged. Escape / backdrop click closes and
    returns focus to whatever opened it. */
export function SettingsModal({
  settings,
  onSettingsChange,
  catalog,
  client,
  plans,
  onPlansChange,
  theme,
  onThemeChange,
  notificationPrefs,
  onNotificationPrefsChange,
  pagePrefs,
  onPagePrefsChange,
  onClose
}: Readonly<SettingsModalProps>): ReactElement {
  const [section, setSection] = useState<SectionId>("general");
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The element focused before the modal opened, restored on close so keyboard focus
  // returns to the Settings trigger.
  const openerRef = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement
  );

  // Escape closes the modal (returning focus to the opener). Bound at the document level so it
  // works no matter where focus sits inside the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Move focus into the dialog on open; restore it to the opener on unmount.
  useEffect(() => {
    dialogRef.current?.focus();
    const opener = openerRef.current;
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus();
      }
    };
  }, []);

  const togglePage = (view: string): void => {
    const nextVisible = !isPageVisible(pagePrefs, view);
    onPagePrefsChange({ ...pagePrefs, [view]: nextVisible });
  };

  return (
    <>
      <button
        type="button"
        className="ws-backdrop"
        aria-label="Close settings"
        onClick={onClose}
      />
      <dialog
        ref={dialogRef}
        className="settings-modal"
        aria-label="Settings"
        open
        // A native <dialog open> is a normally-positioned element, but the UA stylesheet
        // still applies margin:auto, padding:1em, color:CanvasText, and inset-inline-end:0.
        // `.settings-modal` doesn't override those, so neutralize them inline (styles.css is
        // owned elsewhere) to render exactly where the previous <div role="dialog"> did.
        style={{ margin: 0, padding: 0, color: "inherit", insetInlineEnd: "auto" }}
      >
        <nav className="settings-modal-nav" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`settings-modal-nav-item${section === entry.id ? " is-active" : ""}`}
              aria-pressed={section === entry.id}
              onClick={() => setSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="settings-modal-body">
          <div className="settings-modal-head">
            <h2>Settings</h2>
            <button
              type="button"
              className="settings-modal-close"
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          {section === "general" && <ThemeSettings theme={theme} onChange={onThemeChange} />}

          {section === "pages" && (
            <section className="page-prefs" aria-label="Pages">
              <h3>Pages</h3>
              <p className="page-prefs-hint">
                Hidden pages still work and can be driven from chat; this just trims the sidebar.
              </p>
              <ul className="page-prefs-list" aria-label="Toggle pages">
                {TOGGLEABLE_PAGES.map((page) => (
                  <li key={page.view}>
                    <label className="page-prefs-toggle" htmlFor={`page-toggle-${page.view}`}>
                      <input
                        id={`page-toggle-${page.view}`}
                        type="checkbox"
                        aria-label={page.label}
                        checked={isPageVisible(pagePrefs, page.view)}
                        onChange={() => togglePage(page.view)}
                      />
                      <span>{page.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Kept mounted so its FolderBrowser / ConnectPhone bridge subscriptions stay live while
              the Bridge section is open; hidden (not unmounted) when another section shows. */}
          <div hidden={section !== "bridge"}>
            <BridgeSettings
              state={settings}
              onChange={onSettingsChange}
              catalog={catalog}
              client={client}
              active={section === "bridge"}
              plans={plans}
              onPlansChange={onPlansChange}
            />
          </div>

          {section === "notifications" && (
            <NotificationsSettings
              prefs={notificationPrefs}
              onChange={onNotificationPrefsChange}
            />
          )}
        </div>
      </dialog>
    </>
  );
}
