import { useEffect, useRef } from 'react';
import { useWebSocketContext } from '../context/WebSocketContext';
import type { MilestoneDays, Notification } from '../types';

/** Milestone toasts auto-dismiss after this many seconds (SPEC §9). */
const AUTO_DISMISS_MS = 4000;

/**
 * Auto-dismisses a single notification after the fixed delay (SPEC §9).
 * Isolated as its own component so each toast owns its own timer: the timer
 * starts when the toast mounts, and cleanup cancels it on manual dismiss or
 * unmount (whichever happens first) so a dismissed toast can't re-trigger.
 * Dismissing calls `dismissNotification`, which both removes the toast and
 * sends the `ack` so the server won't re-send the milestone.
 */
function Toast({
  notification,
  dismissNotification,
}: {
  notification: Notification;
  dismissNotification: (habitId: string, milestoneDays: MilestoneDays) => void;
}) {
  const { habitId, milestoneDays } = notification;
  // Hold the latest dismiss fn in a ref so the effect isn't re-run (and its
  // timer reset) when the callback identity changes.
  const dismissRef = useRef(dismissNotification);
  dismissRef.current = dismissNotification;

  useEffect(() => {
    const timer = setTimeout(() => {
      dismissRef.current(habitId, milestoneDays);
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [habitId, milestoneDays]);

  return (
    <div
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
              {milestoneDays}-day streak!
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
          onClick={() => dismissNotification(habitId, milestoneDays)}
          aria-label={`Dismiss notification for ${notification.habitName}`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/**
 * Fixed top-right toast stack of pending milestone notifications (SPEC §9).
 * Driven entirely by `WebSocketContext`. Each toast auto-dismisses after 4
 * seconds (or immediately on manual close); either path sends an `ack` over
 * the WebSocket so the server persists it and won't re-send the milestone.
 */
export function NotificationPanel() {
  const { notifications, dismissNotification } = useWebSocketContext();

  return (
    <div
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3"
      aria-live="polite"
    >
      {notifications.map((notification) => (
        <Toast
          key={notification.id}
          notification={notification}
          dismissNotification={dismissNotification}
        />
      ))}
    </div>
  );
}
