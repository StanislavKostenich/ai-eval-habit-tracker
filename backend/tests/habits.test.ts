import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Signer } from '@fastify/cookie';
import { createDb, type AppDatabase } from '../src/db/index.js';
import { migrateDb } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { checkins, users } from '../src/db/schema.js';

/**
 * T2 + T5 (docs/SPEC.md §10) for the habits REST routes.
 *
 * - T2: `POST /habits` → 201; `GET /habits` returns it, including the
 *   computed streak fields (`currentStreak`, `bestStreak`, `totalCheckins`,
 *   `completedToday`).
 * - T5: two distinct, separately-authenticated users. User B accessing
 *   user A's habit → 403 { error: 'Forbidden' } on GET, PATCH, DELETE; a
 *   genuinely missing id → 404 { error: 'Not found' } (docs/SPEC.md §6,
 *   CLAUDE.md hard rule 3). This uses two real, separately-authenticated
 *   sessions, not a random nonexistent id.
 *
 * All HTTP goes through Fastify's `app.inject()` against an in-memory SQLite
 * database that is constructed fresh (`beforeAll`) and reset (`beforeEach`)
 * so the tests are order-independent (docs/SPEC.md §10).
 *
 * Two real sessions: user A logs in through the first-class
 * `/api/auth/demo-login` endpoint (no network). User B is a distinct, real
 * `users` row, and its session is minted by writing a row into the same
 * session store the app already uses, with a `sessionId` cookie signed by
 * the app's own `@fastify/cookie` Signer (the session cookie is a signed
 * value — `@fastify/session` rejects unsigned cookies via
 * `cookieSigner.unsign`). The signed cookie + a real store row give B a
 * genuine, separately-authenticated session.
 */
describe('T2 + T5 — habits (CRUD, streaks, ownership)', () => {
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

  /** UTC "today" — same rule as the rest of the app (docs/SPEC.md §7). */
  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** `YYYY-MM-DD` for `days` before UTC today (0 = today). */
  function daysAgoISO(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
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

  /** Reset the in-memory DB between tests (docs/SPEC.md §10). */
  beforeEach(() => {
    db.delete(checkins).run();
    db.delete(users).run();
    rawClient().prepare('DELETE FROM sessions').run();
  });

  // ---------------------------------------------------------------------
  // T2 — create a habit, list it, verify the computed streak fields.
  // ---------------------------------------------------------------------
  describe('T2 — POST /habits then GET /habits with computed streak fields', () => {
    it('POST /habits → 201; GET /habits returns it with streak fields', async () => {
      const cookie = await demoLogin();

      const post = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'Morning Run', startDate: daysAgoISO(3), description: 'Run 30 minutes' },
      });
      expect(post.statusCode).toBe(201);
      const created = post.json() as { id: string; name: string; status: string; startDate: string };
      expect(typeof created.id).toBe('string');
      expect(created.name).toBe('Morning Run');
      expect(created.startDate).toBe(daysAgoISO(3));
      expect(created.status).toBe('active'); // default

      const get = await app.inject({ method: 'GET', url: '/api/habits', headers: { cookie } });
      expect(get.statusCode).toBe(200);
      const list = get.json() as unknown[];
      expect(Array.isArray(list)).toBe(true);
      expect(list).toHaveLength(1);

      const item = list[0] as Record<string, unknown>;
      expect(item.id).toBe(created.id);
      // Computed streak fields are present and correct for a fresh habit.
      expect(item).toHaveProperty('currentStreak');
      expect(item).toHaveProperty('bestStreak');
      expect(item).toHaveProperty('totalCheckins');
      expect(item).toHaveProperty('completedToday');
      expect(item.currentStreak).toBe(0);
      expect(item.bestStreak).toBe(0);
      expect(item.totalCheckins).toBe(0);
      expect(item.completedToday).toBe(false);
    });

    it('computed streaks reflect seeded check-ins (current, best, total, completedToday)', async () => {
      const cookie = await demoLogin();

      const post = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'Journal', startDate: daysAgoISO(5) },
      });
      expect(post.statusCode).toBe(201);
      const habitId = (post.json() as { id: string }).id;

      // Seed 3 consecutive check-ins ending today (offsets 0,1,2) → a 3-day
      // current streak, best 3, total 3, completedToday true.
      const userId = (
        await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
      ).json() as { id: string };
      for (const offset of [0, 1, 2]) {
        db.insert(checkins)
          .values({
            id: randomUUID(),
            habitId,
            userId: userId.id,
            date: daysAgoISO(offset),
            createdAt: Math.floor(Date.now() / 1000),
          })
          .run();
      }

      const get = await app.inject({ method: 'GET', url: `/api/habits/${habitId}`, headers: { cookie } });
      expect(get.statusCode).toBe(200);
      const item = get.json() as Record<string, unknown>;
      expect(item.currentStreak).toBe(3);
      expect(item.bestStreak).toBe(3);
      expect(item.totalCheckins).toBe(3);
      expect(item.completedToday).toBe(true);
    });

    it('POST /habits → 400 when name or startDate is missing', async () => {
      const cookie = await demoLogin();
      const noName = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { startDate: daysAgoISO(1) },
      });
      expect(noName.statusCode).toBe(400);
      expect(noName.json()).toEqual({ error: expect.any(String) });

      const noDate = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'X' },
      });
      expect(noDate.statusCode).toBe(400);
    });

    it('GET /habits is 401 without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/habits' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized' });
    });
  });

  // ---------------------------------------------------------------------
  // T5 — two real, separately-authenticated users; ownership = 403, missing = 404.
  // ---------------------------------------------------------------------
  describe('T5 — two distinct users, ownership returns 403 (missing returns 404)', () => {
    it('user B → 403 on GET, PATCH, DELETE of user A\'s habit', async () => {
      // User A: the first-class demo user (real, separately authenticated).
      const cookieA = await demoLogin();
      const meA = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieA } });
      const userIdA = (meA.json() as { id: string }).id;

      // User A creates a habit.
      const post = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie: cookieA },
        payload: { name: 'A Private Habit', startDate: daysAgoISO(1) },
      });
      expect(post.statusCode).toBe(201);
      const habitId = (post.json() as { id: string }).id;

      // User B: a distinct, real user row with its own real session.
      const { id: userIdB, cookie: cookieB } = await mintSecondUser();

      // B is genuinely a different, authenticated user.
      const meB = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieB } });
      expect(meB.statusCode).toBe(200);
      expect((meB.json() as { id: string }).id).toBe(userIdB);
      expect(userIdA).not.toBe(userIdB);

      // B accessing A's habit → 403 on GET, PATCH, DELETE (ownership, not missing).
      const get = await app.inject({ method: 'GET', url: `/api/habits/${habitId}`, headers: { cookie: cookieB } });
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/habits/${habitId}`,
        headers: { cookie: cookieB },
        payload: { name: 'Hacked' },
      });
      const del = await app.inject({ method: 'DELETE', url: `/api/habits/${habitId}`, headers: { cookie: cookieB } });

      expect(get.statusCode).toBe(403);
      expect(patch.statusCode).toBe(403);
      expect(del.statusCode).toBe(403);
      for (const r of [get, patch, del]) {
        expect(r.json()).toEqual({ error: 'Forbidden' });
      }

      // The 403s are ownership, not "missing": A still owns and can read it.
      const getA = await app.inject({ method: 'GET', url: `/api/habits/${habitId}`, headers: { cookie: cookieA } });
      expect(getA.statusCode).toBe(200);

      // B can create and read its own habit (proves B's session works).
      const postB = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie: cookieB },
        payload: { name: 'B Habit', startDate: daysAgoISO(1) },
      });
      expect(postB.statusCode).toBe(201);
      const habitB = (postB.json() as { id: string }).id;
      const getB = await app.inject({ method: 'GET', url: `/api/habits/${habitB}`, headers: { cookie: cookieB } });
      expect(getB.statusCode).toBe(200);
    });

    it('GET /habits/:id → 404 for a missing habit id (distinct from 403 ownership)', async () => {
      const cookie = await demoLogin();
      const res = await app.inject({
        method: 'GET',
        url: '/api/habits/does-not-exist',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
    });
  });

  // ---------------------------------------------------------------------
  // Status transition matrix (docs/SPEC.md §6): active<->paused OK,
  // active|paused -> archived OK, archived -> anything (incl. no-op) = 422.
  // ---------------------------------------------------------------------
  describe('status transition matrix (PATCH)', () => {
    async function createHabit(cookie: string, status?: string): Promise<string> {
      const post = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'T', startDate: daysAgoISO(1), ...(status ? { status } : {}) },
      });
      expect(post.statusCode).toBe(201);
      return (post.json() as { id: string }).id;
    }

    it('active <-> paused allowed; active -> archived allowed', async () => {
      const cookie = await demoLogin();
      const id = await createHabit(cookie); // active

      // active -> paused
      let r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'paused' } });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { status: string }).status).toBe('paused');

      // paused -> active
      r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'active' } });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { status: string }).status).toBe('active');

      // active -> archived
      r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'archived' } });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { status: string }).status).toBe('archived');
    });

    it('archived -> anything (incl. no-op re-set) = 422 with the spec error message', async () => {
      const cookie = await demoLogin();
      const id = await createHabit(cookie, 'active');
      const archive = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'archived' } });
      expect(archive.statusCode).toBe(200);

      // archived -> active = 422
      let r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'active' } });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({ error: 'Cannot transition from archived to active' });

      // archived -> paused = 422
      r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'paused' } });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({ error: 'Cannot transition from archived to paused' });

      // archived -> archived (no-op) = 422
      r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'archived' } });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({ error: 'Cannot transition from archived to archived' });

      // Status is unchanged after the rejected transitions.
      const get = await app.inject({ method: 'GET', url: `/api/habits/${id}`, headers: { cookie } });
      expect((get.json() as { status: string }).status).toBe('archived');
    });

    it('PATCH with an invalid status = 400', async () => {
      const cookie = await demoLogin();
      const id = await createHabit(cookie);
      const r = await app.inject({ method: 'PATCH', url: `/api/habits/${id}`, headers: { cookie }, payload: { status: 'bogus' } });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: expect.any(String) });
    });
  });
});
