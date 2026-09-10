import { useWebSocketContext } from '../context/WebSocketContext';

/**
 * Fixed top-right toast stack of pending milestone notifications (SPEC §9).
 * Driven entirely by `WebSocketContext` — no auto-dismiss. Dismiss sends an
 * `ack` over the WebSocket and optimistically removes the toast.
 */
export function NotificationPanel() {
  const { notifications, dismissNotification } = useWebSocketContext();

  return (
    <div
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3"
      aria-live="polite"
    >
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className="pointer-events-auto animate-toast rounded-xl border border-line border-l-4 border-l-fire/50 bg-surface p-4 shadow-lift"
          role="status"
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 text-2xl leading-none" aria-hidden="true">
              🔥
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h4 className="truncate font-display text-sm font-semibold text-ink">
                  {notification.habitName}
                </h4>
                <span className="badge shrink-0 bg-fire-soft text-fire">
                  {notification.milestoneDays}-day streak!
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                Current streak is {notification.currentStreak} day
                {notification.currentStreak === 1 ? '' : 's'}.
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost -mr-1 -mt-1 px-2 py-1 text-ink-faint hover:text-ink"
              onClick={() =>
                dismissNotification(notification.habitId, notification.milestoneDays)
              }
              aria-label={`Dismiss notification for ${notification.habitName}`}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
