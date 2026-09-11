import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Signer } from '@fastify/cookie';
import { createDb, type AppDatabase } from '../src/db/index.js';
import { migrateDb } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { checkins, users } from '../src/db/schema.js';
import { and, eq } from 'drizzle-orm';

/**
 * T3 + T4 (docs/SPEC.md section 10) for the check-in REST routes.
 *
 * - T3: POST /habits/:id/checkins for today -> 201; a second identical POST
 *   (same date) -> 409 { error: 'Check-in already exists for this date' }.
 * - T4: POST with a future date (relative to UTC today) -> 422; POST on a
 *   paused habit -> 422 { error: 'Habit is not active' }; archived -> same.
 *
 * Also covers the rest of the check-in contract (docs/SPEC.md section 6):
 *   - malformed date -> 400 (first in the validation order),
 *   - DELETE .../checkins/:date for a non-today date -> 422,
 *   - today undo -> 204 and the habit's completedToday/totalCheckins
 *     decrement (proves undo works),
 *   - GET .../checkins?month=YYYY-MM returns the month's check-ins ascending,
 *   - ownership on the check-in routes: a request on another user's habit is
 *     403 { error: 'Forbidden' } (404 is reserved for missing), via two real,
 *     separately-authenticated sessions (same pattern as habits.test.ts T5).
 *
 * In-memory SQLite, constructed fresh in beforeAll and reset in beforeEach so
 * the tests are order-independent (docs/SPEC.md section 10). Authentication
 * uses the first-class /api/auth/demo-login endpoint for user A and a real
 * second user row + signed session for user B. All HTTP goes through
 * app.inject().
 */
describe('T3 + T4 — check-ins (check-in, duplicate, status, undo, list, ownership)', () => {
  let db: AppDatabase;
  let app: FastifyInstance;
  const SESSION_SECRET = 'test-session-secret-0123456789-0123456789';

  /** The underlying better-sqlite3 client (used to mint B's session row). */
  function rawClient(): import('better-sqlite3').Database {
    return (db as unknown as { session: { client: import('better-sqlite3').Database } }).session.client;
  }

  /** The app's session-cookie signer (same secret + algorithm as @fastify/session). */
  function signer(): { sign: (v: string) => string } {
    return new (Signer as new (s: string) => { sign: (v: string) => string; unsign: (v: string) => { valid: boolean; value?: string } })(
      SESSION_SECRET,
    );
  }

  /** Pulls the signed session cookie value from a response's set-cookie header. */
  function sessionCookieFrom(setCookieHeaders: string | string[] | undefined): string {
    const list = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders
        ? [setCookieHeaders]
        : [];
    const header = list.find((h) => h.startsWith('sessionId='));
    expect(header, 'expected a sessionId cookie to be set').toBeDefined();
    return (header ?? '').split(';')[0] as string;
  }

  /** Logs in the first-class demo user (user A) and returns its session cookie. */
  async function demoLogin(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/demo-login' });
    expect(res.statusCode).toBe(200);
    return sessionCookieFrom(res.headers['set-cookie'] as string[] | undefined);
  }

  /**
   * Creates a second, distinct user (user B) as a real `users` row and mints
   * a real, separately-authenticated session for it. Returns B's id and
   * session cookie.
   */
  async function mintSecondUser(): Promise<{ id: string; cookie: string }> {
    const id = randomUUID();
    db.insert(users)
      .values({
        id,
        provider: 'demo',
        providerUserId: 'demo-user-2',
        email: null,
        displayName: 'Second Demo User',
        avatarUrl: null,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();
    const sid = randomUUID();
    // Write the session row into the store the app already uses. `expired`
    // is a millisecond timestamp (connect-sqlite3 convention).
    const sess = JSON.stringify({
      userId: id,
      cookie: { originalMaxAge: 86400000, httpOnly: true, path: '/', sameSite: 'lax' },
    });
    rawClient()
      .prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?,?,?)')
      .run(sid, sess, Date.now() + 86400000);
    // The session cookie is a signed value; sign the sid with the app's own
    // signer so @fastify/session accepts it.
    const cookie = `sessionId=${signer().sign(sid)}`;
    return { id, cookie };
  }

  /** UTC "today" — same rule as the rest of the app (docs/SPEC.md section 7). */
  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** `YYYY-MM-DD` for `days` before UTC today (0 = today). */
  function daysAgoISO(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  /** `YYYY-MM` for `months` before the current UTC month (0 = current month). */
  function monthAgoISO(months: number): string {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - months);
    return d.toISOString().slice(0, 7);
  }

  /** Creates a habit (optionally in a given status) and returns its id. */
  async function createHabit(cookie: string, status?: string): Promise<string> {
    const post = await app.inject({
      method: 'POST',
      url: '/api/habits',
      headers: { cookie },
      payload: { name: 'T', startDate: daysAgoISO(1) },
    });
    expect(post.statusCode).toBe(201);
    const id = (post.json() as { id: string }).id;
    if (status && status !== 'active') {
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/habits/${id}`,
        headers: { cookie },
        payload: { status },
      });
      expect(patch.statusCode).toBe(200);
    }
    return id;
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.NODE_ENV = 'test';

    db = createDb(':memory:');
    migrateDb(db);
    app = createApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Reset the in-memory DB between tests (docs/SPEC.md section 10). */
  beforeEach(() => {
    db.delete(checkins).run();
    db.delete(users).run();
    rawClient().prepare('DELETE FROM sessions').run();
  });

  // ---------------------------------------------------------------------
  // T3 — POST a check-in for today, then duplicate it.
  // ---------------------------------------------------------------------
  describe('T3 — POST /habits/:id/checkins for today, duplicate -> 409', () => {
    it('POST check-in for today -> 201 with the stored row; second identical POST -> 409', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie);

      const first = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: todayISO() },
      });
      expect(first.statusCode).toBe(201);
      const created = first.json() as { id: string; habitId: string; date: string; createdAt: number };
      expect(created.id).toBeTruthy();
      expect(created.habitId).toBe(habitId);
      expect(created.date).toBe(todayISO());
      expect(typeof created.createdAt).toBe('number');

      // A second identical POST (same date) is rejected as a duplicate.
      const second = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: todayISO() },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'Check-in already exists for this date' });

      // Exactly one check-in row exists for (habitId, today).
      const rows = db
        .select()
        .from(checkins)
        .where(and(eq(checkins.habitId, habitId), eq(checkins.date, todayISO())))
        .all();
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------
  // T4 — future date, paused, archived.
  // ---------------------------------------------------------------------
  describe('T4 — POST rejected for future date / paused / archived habit', () => {
    it('POST with a future date -> 422 (date must not be in the future)', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie); // active
      const res = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: daysAgoISO(-1) }, // tomorrow (UTC)
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'date must not be in the future' });
    });

    it('POST on a paused habit -> 422 { error: "Habit is not active" }', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie, 'paused');
      const res = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: todayISO() },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'Habit is not active' });
    });

    it('POST on an archived habit -> 422 { error: "Habit is not active" }', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie, 'archived');
      const res = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: todayISO() },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'Habit is not active' });
    });
  });

  // ---------------------------------------------------------------------
  // Validation-order and remaining contract coverage.
  // ---------------------------------------------------------------------
  describe('check-in validation order and contract', () => {
    it('POST with a malformed date -> 400 (before any ownership/DB work)', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie);
      const res = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: 'not-a-date' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: expect.any(String) });
    });

    it('DELETE for a non-today date -> 422 { error: "Can only delete today\'s check-in" }', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie);
      // Seed a check-in for yesterday so the "non-today" case is real.
      const meY = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      const userId = (meY.json() as { id: string }).id;
      const yesterday = daysAgoISO(1);
      db.insert(checkins)
        .values({ id: randomUUID(), habitId, userId, date: yesterday, createdAt: Math.floor(Date.now() / 1000) })
        .run();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/habits/${habitId}/checkins/${yesterday}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: "Can only delete today's check-in" });

      // The yesterday check-in is still there (not deleted).
      const rows = db
        .select()
        .from(checkins)
        .where(and(eq(checkins.habitId, habitId), eq(checkins.date, yesterday)))
        .all();
      expect(rows).toHaveLength(1);
    });

    it('DELETE for today after a check-in -> 204, and the habit reflects the undo', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie);

      // Check in for today.
      const post = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitId}/checkins`,
        headers: { cookie },
        payload: { date: todayISO() },
      });
      expect(post.statusCode).toBe(201);

      const before = await app.inject({ method: 'GET', url: `/api/habits/${habitId}`, headers: { cookie } });
      expect((before.json() as Record<string, unknown>).completedToday).toBe(true);
      expect((before.json() as Record<string, unknown>).totalCheckins).toBe(1);

      // Undo (delete today's check-in).
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/habits/${habitId}/checkins/${todayISO()}`,
        headers: { cookie },
      });
      expect(del.statusCode).toBe(204);

      const after = await app.inject({ method: 'GET', url: `/api/habits/${habitId}`, headers: { cookie } });
      expect((after.json() as Record<string, unknown>).completedToday).toBe(false);
      expect((after.json() as Record<string, unknown>).totalCheckins).toBe(0);
    });

    it('GET /habits/:id/checkins?month=YYYY-MM returns the month\'s check-ins ascending', async () => {
      const cookie = await demoLogin();
      const habitId = await createHabit(cookie);
      const meM = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      const userId = (meM.json() as { id: string }).id;

      // Seed check-ins for the current month on several days (inserted out of
      // order to prove the route sorts ascending, not by insertion order).
      const dates = [daysAgoISO(4), daysAgoISO(1), daysAgoISO(2)];
      for (const date of dates) {
        db.insert(checkins)
          .values({ id: randomUUID(), habitId, userId, date, createdAt: Math.floor(Date.now() / 1000) })
          .run();
      }

      const res = await app.inject({
        method: 'GET',
        url: `/api/habits/${habitId}/checkins?month=${monthAgoISO(0)}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as Array<{ date: string }>;
      expect(rows.map((r) => r.date)).toEqual([...dates].sort());
    });
  });

  // ---------------------------------------------------------------------
  // Ownership for check-in routes: 403 for another user's habit,
  // 404 for a missing habit.
  // ---------------------------------------------------------------------
  describe('check-in ownership -> 403 (missing habit -> 404)', () => {
    it('user B POSTing/DELETEing a check-in on user A\'s habit -> 403 { error: "Forbidden" }', async () => {
      // User A: the first-class demo user (real, separately authenticated).
      const cookieA = await demoLogin();
      const meA = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieA } });
      const userIdA = (meA.json() as { id: string }).id;
      const habitA = await createHabit(cookieA); // active, owned by A

      // User B: a distinct, real user row with its own real session.
      const { id: userIdB, cookie: cookieB } = await mintSecondUser();
      const meB = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieB } });
      expect(meB.statusCode).toBe(200);
      expect((meB.json() as { id: string }).id).toBe(userIdB);
      expect(userIdA).not.toBe(userIdB);

      // B POSTing a check-in for A's habit -> 403 (ownership; not 404, not 422).
      const post = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitA}/checkins`,
        headers: { cookie: cookieB },
        payload: { date: todayISO() },
      });
      expect(post.statusCode).toBe(403);
      expect(post.json()).toEqual({ error: 'Forbidden' });

      // B DELETEing a check-in for A's habit -> 403.
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/habits/${habitA}/checkins/${todayISO()}`,
        headers: { cookie: cookieB },
      });
      expect(del.statusCode).toBe(403);
      expect(del.json()).toEqual({ error: 'Forbidden' });

      // A missing habit id is 404 (distinct from 403 ownership).
      const missing = await app.inject({
        method: 'POST',
        url: '/api/habits/does-not-exist/checkins',
        headers: { cookie: cookieB },
        payload: { date: todayISO() },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'Not found' });

      // A is unaffected: still owns the habit and can check in.
      const getA = await app.inject({ method: 'GET', url: `/api/habits/${habitA}`, headers: { cookie: cookieA } });
      expect(getA.statusCode).toBe(200);
      const postA = await app.inject({
        method: 'POST',
        url: `/api/habits/${habitA}/checkins`,
        headers: { cookie: cookieA },
        payload: { date: todayISO() },
      });
      expect(postA.statusCode).toBe(201);
    });
  });
});
