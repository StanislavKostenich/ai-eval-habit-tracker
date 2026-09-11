import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, type AppDatabase } from '../src/db/index.js';
import { migrateDb } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { createRateLimiter, type RateLimiter } from '../src/middleware/rateLimit.js';

/**
 * Security hardening (docs/SPEC.md §6/§12 rate limiting; §9 field length
 * caps). These are not in the T1–T9 spec table; they cover the two production
 * hardening measures the spec names as the mitigation for the 404-vs-403
 * user-enumeration concern (rate limiting) and the client-bypassable field
 * caps (server-side name/description limits).
 *
 * The rate-limit integration test builds its own app wired with a low-budget
 * limiter and a deterministic injected clock (`now`) so it hits the 429
 * boundary exactly, without wall-clock timing. `createApp(db, { limiter })`
 * is the seam. The production default (300/15s per IP) is high enough that
 * the fast inject-based suites (auth/habits/checkins, which share one client
 * IP) never trip it.
 */
describe('hardening — rate limiting + input caps', () => {
  describe('rate limiter (429 Too Many Requests)', () => {
    let db: AppDatabase;
    let app: FastifyInstance;
    let now: number;

    beforeAll(async () => {
      process.env.SESSION_SECRET = 'test-session-secret-0123456789-0123456789';
      process.env.NODE_ENV = 'test';

      db = createDb(':memory:');
      migrateDb(db);

      // Deterministic clock that advances 100ms per hit so each hit lands in a
      // fresh-but-still-within-window slot (window is 15s). Budget is 3.
      now = 1_700_000_000_000;
      const limiter = createRateLimiter({
        windowMs: 15_000,
        max: 3,
        now: () => (now += 100),
      });
      app = createApp(db, { limiter });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows the budget, then returns 429 { error } from the (max+1)th request', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
        codes.push(res.statusCode);
        if (res.statusCode === 429) {
          // Assert the body shape on the first 429.
          expect(res.json()).toEqual({ error: 'Too many requests' });
        }
      }
      // /api/auth/me without a session is 401 when allowed, 429 once the
      // per-window budget (3) is exhausted.
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    });

    it('is keyed by the real client IP, not a client-controlled XFF entry', async () => {
      // The default inject client IP (socket 127.0.0.1) is over budget from the
      // previous test.
      const blocked = await app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(blocked.statusCode).toBe(429);

      // A request the way nginx actually sends it (frontend/nginx.conf appends
      // the real client IP as the LAST XFF entry) is keyed by that trusted last
      // entry and gets its own, still-full budget. `remoteAddress` simulates the
      // socket IP the backend sees (the proxy's address) — the unspoofable part.
      const viaProxy = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        remoteAddress: '172.19.0.2',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      expect(viaProxy.statusCode).toBe(401);

      // A client cannot dodge the limiter by prepending a spoofed source IP:
      // trustProxy=1 trusts only the last (proxy) entry, so this still resolves
      // to the exhausted real client (203.0.113.7 → its own socket, 127.0.0.1)
      // and stays blocked, not "freshly" 401/200.
      const spoofed = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '10.0.0.99, 127.0.0.1' },
      });
      expect(spoofed.statusCode).toBe(429);
    });

    it('the limiter unit admits exactly `max` hits in a window, then rejects', () => {
      const l = createRateLimiter({ windowMs: 1000, max: 2, now: () => 0 });
      expect(l.hit('a').allowed).toBe(true);
      expect(l.hit('a').allowed).toBe(true);
      expect(l.hit('a').allowed).toBe(false);
      // A different key has its own budget.
      expect(l.hit('b').allowed).toBe(true);
    });

    it('every response carries the RateLimit-Limit / -Remaining / -Reset headers', async () => {
      // A fresh client IP so this request starts from a full budget.
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        remoteAddress: '203.0.113.50',
      });
      // /api/auth/me without a session is 401 when allowed.
      expect(res.statusCode).toBe(401);
      expect(res.headers['ratelimit-limit']).toBe('3');
      expect(res.headers['ratelimit-remaining']).toBe('2');
      expect(res.headers['ratelimit-reset']).toBeTruthy();
      expect(Number(res.headers['ratelimit-reset']) > 0).toBe(true);

      // Draining the budget decrements Remaining; the over-budget request is
      // 429 and still carries the headers (Remaining 0).
      const r2 = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '203.0.113.50' });
      expect(r2.statusCode).toBe(401);
      expect(r2.headers['ratelimit-remaining']).toBe('1');
      const r3 = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '203.0.113.50' });
      expect(r3.statusCode).toBe(401);
      expect(r3.headers['ratelimit-remaining']).toBe('0');
      const r4 = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: '203.0.113.50' });
      expect(r4.statusCode).toBe(429);
      expect(r4.headers['ratelimit-limit']).toBe('3');
      expect(r4.headers['ratelimit-remaining']).toBe('0');
      expect(r4.headers['ratelimit-reset']).toBeTruthy();
    });
  });

  describe('server-side input caps (400 on over-length name/description)', () => {
    let db: AppDatabase;
    let app: FastifyInstance;
    let cookie: string;

    beforeAll(async () => {
      process.env.SESSION_SECRET = 'test-session-secret-0123456789-0123456789';
      process.env.NODE_ENV = 'test';
      db = createDb(':memory:');
      migrateDb(db);
      // Effectively-unlimited budget so these tests only exercise the caps.
      app = createApp(db, {
        limiter: createRateLimiter({ windowMs: 15_000, max: 1_000_000 }),
      });
      await app.ready();

      const login = await app.inject({ method: 'POST', url: '/api/auth/demo-login' });
      const setCookies = login.headers['set-cookie'] as string[] | undefined;
      cookie =
        (Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []).find((h) =>
          h.startsWith('sessionId='),
        )
          ?.split(';')[0] ?? '';
      expect(cookie).toBeTruthy();
    });

    afterAll(async () => {
      await app.close();
    });

    it('POST /habits rejects name longer than 100 chars (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'x'.repeat(101), startDate: '2026-01-01' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/name/);
    });

    it('POST /habits rejects description longer than 500 chars (400)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'Reading', description: 'y'.repeat(501), startDate: '2026-01-01' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/description/);
    });

    it('PATCH /habits/:id rejects an over-length name (400)', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'Reading', startDate: '2026-01-01' },
      });
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/habits/${id}`,
        headers: { cookie },
        payload: { name: 'z'.repeat(101) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/name/);
    });

    it('valid inputs still succeed (100-char name, 500-char description)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/habits',
        headers: { cookie },
        payload: { name: 'a'.repeat(100), description: 'b'.repeat(500), startDate: '2026-01-01' },
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
