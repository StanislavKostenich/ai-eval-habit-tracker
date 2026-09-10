// Single source of truth for all shared types (SPEC §2, §9). Every component
// imports these — never redeclare a structurally-similar local copy.

/** A signed-in user as returned by `GET /api/auth/me` (SPEC §5). */
export type UserProvider = 'google' | 'github' | 'demo';

export interface User {
  id: string;
  provider: UserProvider;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  /** Unix timestamp in seconds. */
  createdAt: number;
}

export type HabitStatus = 'active' | 'paused' | 'archived';

/**
 * A habit row enriched with computed streak fields (SPEC §6). This is what
 * `GET /api/habits` and `GET /api/habits/:id` return — the single `Habit` type.
 */
export interface Habit {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  /** YYYY-MM-DD (UTC). */
  startDate: string;
  status: HabitStatus;
  createdAt: number;
  updatedAt: number;
  currentStreak: number;
  bestStreak: number;
  totalCheckins: number;
  completedToday: boolean;
}

/** A single check-in row (SPEC §4/§6). */
export interface Checkin {
  id: string;
  habitId: string;
  userId: string;
  /** YYYY-MM-DD (UTC). */
  date: string;
  createdAt: number;
}

/** Payload for `POST /api/habits` (SPEC §6). */
export interface CreateHabitInput {
  name: string;
  description?: string;
  startDate: string;
  status?: HabitStatus;
}

/** Payload for `PATCH /api/habits/:id` (SPEC §6). All fields optional. */
export interface UpdateHabitInput {
  name?: string;
  description?: string | null;
  status?: HabitStatus;
}

/** A milestone reached on a habit's current streak. */
export type MilestoneDays = 3 | 7 | 30;

/**
 * WebSocket message envelope (SPEC §8). The server sends `connected` and
 * `milestone`; the client sends `subscribe` and `ack`.
 */
export type WSMessage =
  | { type: 'connected'; payload: { userId: string } }
  | {
      type: 'milestone';
      payload: {
        habitId: string;
        habitName: string;
        milestoneDays: MilestoneDays;
        currentStreak: number;
      };
    }
  | { type: 'subscribe'; payload: { milestones: true } }
  | { type: 'ack'; payload: { habitId: string; milestoneDays: MilestoneDays } };

/** A pending, not-yet-acknowledged milestone toast (SPEC §9 NotificationPanel). */
export interface Notification {
  id: string;
  habitId: string;
  habitName: string;
  milestoneDays: MilestoneDays;
  currentStreak: number;
}
