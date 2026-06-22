import { useState, type ReactElement } from "react";
import {
  clampExpiryDays,
  MAX_EXPIRY_DAYS,
  MIN_EXPIRY_DAYS,
  type NotificationPrefs
} from "./notifications";
import { NumberField } from "./components/NumberField";
import {
  notificationPermission,
  requestNotificationPermission,
  type NotifyPermission
} from "./osNotify";

export interface NotificationsSettingsProps {
  prefs: NotificationPrefs;
  onChange: (prefs: NotificationPrefs) => void;
}

/** Only the boolean-valued prefs are toggle rows (secretExpiryDays is a number, handled below). */
type BooleanPrefKey = {
  [K in keyof NotificationPrefs]: NotificationPrefs[K] extends boolean ? K : never;
}[keyof NotificationPrefs];

interface ToggleRow {
  key: BooleanPrefKey;
  label: string;
  hint: string;
}

/** The desktop-permission help text for each permission state. */
function permissionNoteFor(permission: NotifyPermission): string {
  switch (permission) {
    case "unsupported":
      return "This environment has no desktop notifications; the in-app Alerts feed still works.";
    case "denied":
      return "Desktop notifications are blocked in your browser/OS settings; the Alerts feed still works.";
    case "granted":
      return "Desktop notifications are allowed.";
    default:
      return "Desktop notifications need permission.";
  }
}

const TRIGGER_ROWS: ToggleRow[] = [
  { key: "chatFinished", label: "Chat finished", hint: "A chat response completes while you are not on that thread." },
  { key: "workAssigned", label: "Work assigned to me", hint: "A new issue or work item is assigned to you (GitHub + Azure DevOps)." },
  { key: "workMentioned", label: "Mentioned / tagged", hint: "You are @-mentioned on an issue or PR (GitHub; Azure DevOps has no mentions query)." },
  { key: "prReview", label: "PR needs my review", hint: "A pull request requests your review (GitHub + Azure DevOps)." },
  { key: "deadLetter", label: "New dead-letter", hint: "A Service Bus entity's dead-letter count rises." },
  { key: "secretExpiring", label: "Key Vault secret expiring", hint: "A Key Vault secret, key, or certificate in your selected subscriptions is within the expiry window below." }
];

/** Settings panel for the notification engine: a desktop-toast permission control + per-type
    toggles. Persisted by the parent. */
export function NotificationsSettings({
  prefs,
  onChange
}: Readonly<NotificationsSettingsProps>): ReactElement {
  const [permission, setPermission] = useState<NotifyPermission>(() => notificationPermission());

  const toggle = (key: BooleanPrefKey): void => {
    onChange({ ...prefs, [key]: !prefs[key] });
  };

  const enableDesktop = async (): Promise<void> => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      onChange({ ...prefs, desktop: true });
    }
  };

  const permissionNote = permissionNoteFor(permission);

  return (
    <section className="notif-settings" aria-label="Notifications settings">
      <h3>Notifications</h3>

      <div className="notif-desktop">
        <label className="notif-toggle" htmlFor="notif-toggle-desktop">
          <input
            id="notif-toggle-desktop"
            type="checkbox"
            aria-label="Desktop notifications"
            checked={prefs.desktop}
            disabled={permission === "unsupported" || permission === "denied"}
            onChange={() => toggle("desktop")}
          />
          <span>
            <span className="notif-toggle-label">Desktop notifications</span>
            <span className="notif-toggle-hint">{permissionNote}</span>
          </span>
        </label>
        {permission === "default" && (
          <button type="button" onClick={() => void enableDesktop()}>
            Enable desktop notifications
          </button>
        )}
      </div>

      <p className="notif-section-label">Notify me when…</p>
      <ul className="notif-toggles" aria-label="Notification types">
        {TRIGGER_ROWS.map((row) => (
          <li key={row.key}>
            <label className="notif-toggle" htmlFor={`notif-toggle-${row.key}`}>
              <input
                id={`notif-toggle-${row.key}`}
                type="checkbox"
                aria-label={row.label}
                checked={prefs[row.key]}
                onChange={() => toggle(row.key)}
              />
              <span>
                <span className="notif-toggle-label">{row.label}</span>
                <span className="notif-toggle-hint">{row.hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="notif-expiry">
        <span className="notif-toggle-label">Alert when expiring within</span>
        <NumberField
          className="notif-expiry-field"
          ariaLabel="Days before expiry to alert"
          value={String(prefs.secretExpiryDays)}
          min={MIN_EXPIRY_DAYS}
          max={MAX_EXPIRY_DAYS}
          onChange={(value) => {
            const days = Number(value);
            if (value.trim() !== "" && Number.isFinite(days)) {
              onChange({ ...prefs, secretExpiryDays: clampExpiryDays(days) });
            }
          }}
        />
        <span className="notif-expiry-unit">days</span>
      </div>
    </section>
  );
}
