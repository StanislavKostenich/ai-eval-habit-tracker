import { useCallback, useEffect, useRef, useState } from 'react';
import type { MilestoneDays, WSMessage } from '../types';

export interface UseWebSocketOptions {
  /** When false, no connection is opened and none is re-established. */
  enabled: boolean;
  /** Invoked for every `milestone` message received from the server. */
  onMilestone?: (payload: {
    habitId: string;
    habitName: string;
    milestoneDays: MilestoneDays;
    currentStreak: number;
  }) => void;
}

/**
 * Build the WS URL relative to the current location (SPEC §9). The same
 * expression routes correctly through the Vite dev proxy and nginx — never an
 * absolute backend origin.
 */
export function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/** Bounded reconnect attempts before the client gives up. */
const MAX_RECONNECT_ATTEMPTS = 10;

export interface UseWebSocketResult {
  isConnected: boolean;
  /** Re-subscribe the connection (sends `subscribe` again when open). */
  subscribe: () => void;
  /** Acknowledge a milestone; the server persists it so it won't re-appear. */
  ack: (habitId: string, milestoneDays: MilestoneDays) => void;
}

/**
 * Manages one WebSocket connection for the authenticated user (SPEC §9).
 *
 * - Sends `subscribe` immediately on open.
 * - Reconnects with exponential backoff `min(1000 * 2^attempts, 10000)` up to a
 *   bounded number of attempts on unexpected close.
 * - Does NOT reconnect (or connect at all) while `enabled` is false.
 */
export function useWebSocket(options: UseWebSocketOptions): UseWebSocketResult {
  const { enabled, onMilestone } = options;

  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  // Keep the latest onMilestone without re-running the connect effect.
  const onMilestoneRef = useRef(onMilestone);
  onMilestoneRef.current = onMilestone;

  const send = useCallback((message: WSMessage) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const subscribe = useCallback(() => {
    send({ type: 'subscribe', payload: { milestones: true } });
  }, [send]);

  const ack = useCallback(
    (habitId: string, milestoneDays: MilestoneDays) => {
      send({ type: 'ack', payload: { habitId, milestoneDays } });
    },
    [send],
  );

  useEffect(() => {
    if (!enabled) {
      disposedRef.current = false;
      return;
    }

    disposedRef.current = false;

    function cleanup() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const socket = socketRef.current;
      if (socket) {
        // Detach handlers so a closing socket can't trigger reconnect logic.
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        socketRef.current = null;
      }
      setIsConnected(false);
    }

    function connect() {
      if (disposedRef.current) return;
      const socket = new WebSocket(getWsUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        attemptsRef.current = 0;
        setIsConnected(true);
        // Send subscribe immediately on open (SPEC §9).
        send({ type: 'subscribe', payload: { milestones: true } });
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let message: WSMessage;
        try {
          message = JSON.parse(event.data) as WSMessage;
        } catch {
          return;
        }
        if (message.type === 'milestone') {
          onMilestoneRef.current?.(message.payload);
        }
      };

      socket.onclose = () => {
        setIsConnected(false);
        if (disposedRef.current) return;
        // Bounded exponential backoff on unexpected close.
        if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) return;
        const delay = Math.min(1000 * 2 ** attemptsRef.current, 10000);
        attemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // onclose will fire next and drive the reconnect.
      };
    }

    connect();

    return () => {
      disposedRef.current = true;
      cleanup();
    };
    // `send` is stable (empty deps), so only `enabled` gates the connection.
  }, [enabled, send]);

  return { isConnected, subscribe, ack };
}
