import type { ReactElement } from "react";
import type { AppNotification, AppNotificationKind } from "./notifications";
import { formatRelative, useRelativeNow } from "./relativeTime";

const KIND_LABEL: Record<AppNotificationKind, string> = {
  chat_finished: "Chat",
  work_assigned: "Assigned",
  work_mentioned: "Mentioned",
  pr_review: "Review",
  dead_letter: "Dead-letter",
  secret_expiring: "Expiring"
};

export interface NotificationListProps {
  notifications: AppNotification[];
  active: boolean;
  onMarkAllRead: () => void;
  onClear: () => void;
}

/** The Alerts feed: chat-finished, work assigned/mentioned, PR review requests, and new
    dead-letters. Populated by the notification engine; OS toasts mirror these when desktop
    notifications are enabled in Settings. */
export function NotificationList({
  notifications,
  active,
  onMarkAllRead,
  onClear
}: Readonly<NotificationListProps>): ReactElement {
  const now = useRelativeNow(active);
  return (
    <section className="notifications" aria-label="Notifications">
      <header className="notifications-header">
        <h2>Alerts</h2>
        <div className="notifications-actions">
          <span className="notifications-badge" aria-label="Notification count">
            {notifications.length}
          </span>
          {notifications.length > 0 && (
            <>
              <button type="button" className="link-button" onClick={onMarkAllRead}>
                Mark all read
              </button>
              <button type="button" className="link-button" onClick={onClear}>
                Clear
              </button>
            </>
          )}
        </div>
      </header>

      {notifications.length === 0 ? (
        <p className="body">
          No alerts yet. You will be notified when a chat finishes while you are elsewhere, work
          is assigned to you or mentions you, a PR needs your review, or a new dead-letter
          arrives. Tune these in <strong>Settings → Notifications</strong>.
        </p>
      ) : (
        <ul aria-label="Notification list">
          {notifications.map((notification) => (
            <li
              key={notification.id}
              className={`notification kind-${notification.kind} ${notification.read ? "is-read" : "is-unread"}`}
            >
              <span className={`notification-kind kind-${notification.kind}`}>
                {KIND_LABEL[notification.kind]}
              </span>
              <div className="notification-main">
                <span className="notification-title">{notification.title}</span>
                <span className="notification-body">{notification.body}</span>
              </div>
              <span className="notification-time">
                {formatRelative(now, Date.parse(notification.createdAt))}
              </span>
              {notification.link !== undefined && (
                <a href={notification.link} target="_blank" rel="noopener noreferrer">
                  open
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
