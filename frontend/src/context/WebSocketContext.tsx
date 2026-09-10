import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAuth } from '../hooks/useAuth';
import type { MilestoneDays, Notification } from '../types';

export interface WebSocketContextValue {
  notifications: Notification[];
  isConnected: boolean;
  /** Acknowledge + optimistically remove a milestone toast (SPEC §9). */
  dismissNotification: (habitId: string, milestoneDays: MilestoneDays) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

type MilestonePayload = {
  habitId: string;
  habitName: string;
  milestoneDays: MilestoneDays;
  currentStreak: number;
};

/**
 * Wraps the authenticated app (SPEC §9) so `NotificationPanel` can render
 * globally on top of any page whenever a user is logged in.
 *
 * Owns the single WebSocket connection (via `useWebSocket`) and the
 * notifications list. The connection is enabled only when there is a user, so
 * a logged-out state opens no socket.
 */
export function WebSocketProvider({ children }: { children: ReactNode }) {
  const { user, isAuthLoading } = useAuth();
  const enabled = !isAuthLoading && user !== null;

  const [notifications, setNotifications] = useState<Notification[]>([]);

  // De-duplicate by (habitId, milestoneDays) so the same milestone arriving
  // twice before it's acked doesn't produce two toasts (SPEC §9).
  const addMilestone = useCallback((payload: MilestonePayload) => {
    setNotifications((prev) => {
      const exists = prev.some(
        (n) => n.habitId === payload.habitId && n.milestoneDays === payload.milestoneDays,
      );
      if (exists) return prev;
      const next: Notification = {
        id: `${payload.habitId}:${payload.milestoneDays}`,
        habitId: payload.habitId,
        habitName: payload.habitName,
        milestoneDays: payload.milestoneDays,
        currentStreak: payload.currentStreak,
      };
      return [next, ...prev];
    });
  }, []);

  const remove = useCallback((habitId: string, milestoneDays: MilestoneDays) => {
    setNotifications((prev) =>
      prev.filter((n) => !(n.habitId === habitId && n.milestoneDays === milestoneDays)),
    );
  }, []);

  const { isConnected, ack } = useWebSocket({ enabled, onMilestone: addMilestone });

  const dismissNotification = useCallback(
    (habitId: string, milestoneDays: MilestoneDays) => {
      // Optimistically remove first so the toast vanishes immediately, then
      // send the ack so the server persists it and won't re-send later.
      remove(habitId, milestoneDays);
      ack(habitId, milestoneDays);
    },
    [remove, ack],
  );

  const value = useMemo<WebSocketContextValue>(
    () => ({ notifications, isConnected, dismissNotification }),
    [notifications, isConnected, dismissNotification],
  );

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

export function useWebSocketContext(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (ctx === null) {
    throw new Error('useWebSocketContext must be used within a WebSocketProvider');
  }
  return ctx;
}
