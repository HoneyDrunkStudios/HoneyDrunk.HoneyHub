import type { Notification, NotificationKind } from "@honeydrunk/honeyhub-types";

const KIND_LABEL: Record<NotificationKind, string> = {
  needs_input: "Needs input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  pr_opened: "PR opened"
};

export interface NotificationListProps {
  notifications: Notification[];
}

// Renders the state-only notifications (status/backend/repo/link). It can only
// show what the Notification type carries, so no transcript/path content can
// reach the UI here.
export function NotificationList({ notifications }: NotificationListProps) {
  return (
    <section className="notifications" aria-label="Notifications">
      <header className="notifications-header">
        <h2>Notifications</h2>
        <span className="notifications-badge" aria-label="Notification count">
          {notifications.length}
        </span>
      </header>

      {notifications.length === 0 ? (
        <p className="body">No notifications yet.</p>
      ) : (
        <ul aria-label="Notification list">
          {notifications.map((notification) => (
            <li key={notification.id} className={`notification kind-${notification.kind}`}>
              <span className="notification-kind">{KIND_LABEL[notification.kind]}</span>
              <span className="notification-backend">{notification.backend}</span>
              {notification.repo !== undefined && (
                <span className="notification-repo">{notification.repo}</span>
              )}
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
