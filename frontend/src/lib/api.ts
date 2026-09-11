import type {
  Checkin,
  CreateHabitInput,
  Habit,
  UpdateHabitInput,
  User,
} from '../types';

/**
 * The single API client (SPEC §9). Every REST call in the app goes through
 * this module and issues requests to RELATIVE paths only — never an absolute
 * backend origin. The same built bundle therefore works through the Vite dev
 * proxy and the nginx reverse proxy unchanged.
 */

/**
 * Optional AbortSignal for in-flight request cancellation. Vite's dev server
 * can serve a `stale-while-revalidate` response during HMR — if a stale GET
 * resolves after a newer one, its `body.json()` promise resolves late and its
 * (wrong) payload lands in the TanStack Query cache, flashing stale data.
 * Aborting the request when a newer one with the same key starts prevents
 * those late resolutions.
 */
declare global {
  interface Window {
    __apiInflight?: Map<string, AbortController>;
  }
}

function withAbort(path: string, options: RequestInit): RequestInit {
  const key = `${options.method ?? 'GET'} ${path}`;
  const prev = window.__apiInflight?.get(key);
  if (prev) prev.abort();
  const controller = new AbortController();
  if (!window.__apiInflight) window.__apiInflight = new Map();
  window.__apiInflight.set(key, controller);
  return { ...options, signal: controller.signal };
}

/** Uniform error shape for non-2xx responses (SPEC §6). */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const merged = withAbort(path, options);
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    ...merged,
  });
  // Drop the in-flight entry so a later request for the same key can
  // install its own controller without aborting an already-settled one.
  window.__apiInflight?.delete(`${options.method ?? 'GET'} ${path}`);

  if (res.status === 204) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') ?? '';
  const hasBody = !contentType.includes('application/json') ? false : true;
  let body: unknown = null;
  if (hasBody) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? ((body as { error: string }).error)
        : `Request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
  }

  return body as T;
}

export function toQueryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (_entry): _entry is [string, string] => _entry[1] !== undefined,
  );
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

/**
 * Filters driving the habits list query (SPEC §9 single query key).
 * Properties are `| undefined` so callers can build a partial object and
 * satisfy `exactOptionalPropertyTypes` (the client drops `undefined` in
 * `toQueryString`).
 */
export interface HabitsQuery {
  status?: 'active' | 'paused' | 'archived' | '' | undefined;
  q?: string | undefined;
  completedToday?: boolean | null | undefined;
}

export const api = {
  // --- Auth -------------------------------------------------------------
  /** No body; sets the session cookie. Returns `{ message, userId }` (SPEC §5). */
  demoLogin(): Promise<{ message: string; userId: string }> {
    return request('/api/auth/demo-login', { method: 'POST' });
  },
  me(): Promise<User> {
    return request('/api/auth/me');
  },
  logout(): Promise<void> {
    return request('/api/auth/logout', { method: 'POST' });
  },

  // --- Habits -----------------------------------------------------------
  listHabits(query: HabitsQuery = {}): Promise<Habit[]> {
    const qs = toQueryString({
      status: query.status || undefined,
      q: query.q && query.q.length > 0 ? query.q : undefined,
      completedToday: query.completedToday === null ? undefined : query.completedToday ? 'true' : 'false',
    });
    return request(`/api/habits${qs}`);
  },
  getHabit(id: string): Promise<Habit> {
    return request(`/api/habits/${id}`);
  },
  createHabit(input: CreateHabitInput): Promise<Habit> {
    return request('/api/habits', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateHabit(id: string, input: UpdateHabitInput): Promise<Habit> {
    return request(`/api/habits/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  deleteHabit(id: string): Promise<void> {
    return request(`/api/habits/${id}`, { method: 'DELETE' });
  },

  // --- Checkins ---------------------------------------------------------
  /** Check-ins for a habit, optionally scoped to a month (`YYYY-MM`), asc by date. */
  listCheckins(habitId: string, month?: string): Promise<Checkin[]> {
    const qs = month ? `?month=${month}` : '';
    return request(`/api/habits/${habitId}/checkins${qs}`);
  },
  createCheckin(habitId: string, date: string): Promise<Checkin> {
    return request(`/api/habits/${habitId}/checkins`, {
      method: 'POST',
      body: JSON.stringify({ date }),
    });
  },
  deleteCheckin(habitId: string, date: string): Promise<void> {
    return request(`/api/habits/${habitId}/checkins/${date}`, { method: 'DELETE' });
  },
};
