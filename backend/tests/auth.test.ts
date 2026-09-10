import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb, type AppDatabase } from '../src/db/index.js';
import { migrateDb } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { users } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * T1 (docs/SPEC.md §10): demo login creates a session; `/auth/me` returns
 * the profile with it and 401s without it. No real OAuth / network calls —
 * authentication goes through the first-class `/api/auth/demo-login`
 * endpoint, and all HTTP goes through Fastify's `app.inject()`.
 */
describe('T1 — auth (demo login, /auth/me)', () => {
  let db: AppDatabase;
  let app: FastifyInstance;

  /** Pulls the signed session cookie value from a response's set-cookie header.
   *  Fastify's `inject()` returns `set-cookie` as a single string when one
   *  cookie is set and as an array when several are, so normalize both. */
  function sessionCookieFrom(setCookieHeaders: string | string[] | undefined): string {
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
    const header = list.find((h) => h.startsWith('sessionId='));
    expect(header, 'expected a sessionId cookie to be set').toBeDefined();
    return (header ?? '').split(';')[0] as string;
  }

  beforeAll(async () => {
    // Boot the app with a real (in-memory) session secret — no reliance on
    // the dev fallback.
    process.env.SESSION_SECRET = 'test-session-secret-0123456789-0123456789';
    process.env.NODE_ENV = 'test';

    db = createDb(':memory:');
    migrateDb(db);
    app = createApp(db);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('demo-login creates a user and a session; /me returns the safe profile', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/demo-login' });
    expect(login.statusCode).toBe(200);

    const body = login.json() as { message?: string; userId?: string };
    expect(typeof body.userId).toBe('string');
    expect(body.userId?.length).toBeGreaterThan(0);
    expect(body.message).toBeTruthy();

    const cookie = sessionCookieFrom(login.headers['set-cookie'] as string[] | undefined);

    // The session must contain ONLY the user id (docs/SPEC.md §5).
    const stored = db
      .select()
      .from(users)
      .where(eq(users.id, body.userId as string))
      .get();
    expect(stored?.provider).toBe('demo');
    expect(stored?.providerUserId).toBe('demo-user');
    expect(stored?.displayName).toBe('Demo User');
    expect(stored?.email).toBeNull();
    expect(stored?.avatarUrl).toBeNull();

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);

    const profile = me.json() as Record<string, unknown>;
    expect(profile).toMatchObject({
      id: body.userId,
      provider: 'demo',
      displayName: 'Demo User',
    });
    expect(profile).toHaveProperty('email');
    expect(profile).toHaveProperty('avatarUrl');
    expect(typeof profile.createdAt).toBe('number');
    // No internal-only fields leak through the safe profile.
    expect(profile).not.toHaveProperty('providerUserId');
    expect(profile).not.toHaveProperty('provider_user_id');
  });

  it('/me without a session cookie → 401 { error: "Unauthorized" }', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(401);
    expect(me.json()).toEqual({ error: 'Unauthorized' });
  });

  it('a second demo-login is idempotent — same userId, same session user', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/auth/demo-login' });
    const second = await app.inject({ method: 'POST', url: '/api/auth/demo-login' });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstUserId = (first.json() as { userId: string }).userId;
    const secondUserId = (second.json() as { userId: string }).userId;
    expect(secondUserId).toBe(firstUserId);

    // Still exactly one demo user row in the database.
    const rows = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.provider, 'demo'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(firstUserId);

    // The second session also resolves to the same user via /me.
    const cookie = sessionCookieFrom(second.headers['set-cookie'] as string[] | undefined);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { id: string }).id).toBe(firstUserId);
  });
});
