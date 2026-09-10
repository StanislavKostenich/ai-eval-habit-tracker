import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import fastifyCookie from '@fastify/cookie';
import { WebSocket } from 'ws';
import type { AppDatabase } from '../db/index.js';
import { checkins, habits, milestoneNotifications, users } from '../db/schema.js';
import { calculateStreaks } from '../utils/streaks.js';
import { getTodayISO } from '../utils/date.js';

/**
 * WebSocket milestone engine (docs/SPEC.md §8).
 *
 * Registers a single `GET /ws` (HTTP upgrade) route behind the app's session
 * cookie. The message protocol is a JSON envelope `{ type, payload }`:
 *
 *   Server → Client
 *     `connected`   { userId }                                           on upgrade
 *     `milestone`   { habitId, habitName, milestoneDays, currentStreak }  on `subscribe`
 *   Client → Server
 *     `subscribe`   { milestones: true }
 *     `ack`         { habitId, milestoneDays: 3|7|30 }
 *
 * Milestone rules (docs/SPEC.md §8):
 *   - A milestone is sent for each of [3, 7, 30] where `currentStreak >=
 *     milestone` AND there is no row in `milestone_notifications` for
 *     `(habit_id, milestone_days)`.
 *   - Nothing is persisted at send time. A client that disconnects without
 *     acking will see the same milestone again on its next `subscribe` — that
 *     is how "not yet acknowledged" is defined.
 *   - The `ack` handler verifies `habit.userId === <connected session userId>`
 *     before writing (security-critical: without it, a user could forge acks
 *     for another user's habits and suppress their milestones). A missing or
 *     not-owned habit is silently ignored.
 *
 * Ownership convention: an unauthenticated upgrade is rejected with close code
 * 1008 (policy violation) (docs/SPEC.md §8).
 *
 * Session auth on the upgrade: `@fastify/websocket` v10 hands the handler the
 * socket AFTER the HTTP upgrade. The upgrade request is dispatched in the
 * server's `upgrade` handler and does NOT run Fastify's normal hook pipeline,
 * so `@fastify/session`/`@fastify/cookie` (which parse + load the session in
 * `onRequest`) never populate `request.session` for the WS route. We therefore
 * resolve the session ourselves from the raw `cookie` header: parse it with
 * `@fastify/cookie`'s `parse` (which URL-decodes values the way the HTTP path
 * does), unsign the `sessionId` with the app's session secret (the same secret
 * `createApp` uses, via `process.env.SESSION_SECRET` and the dev fallback),
 * look the session row up in the SQLite store, and confirm the user still
 * exists. This reuses the app's own utilities and secret.
 *
 * The upgraded socket is attached to the raw request by the plugin under a
 * symbol and destroyed by its `onResponse` hook when `request.ws` is true
 * (without checking `reply.hijacked`). We delete that symbol from the raw
 * request once the `ws` socket is ours so the plugin does not tear down the
 * connection.
 */

const MILESTONES = [3, 7, 30] as const;
type MilestoneDays = (typeof MILESTONES)[number];

/** Dev-only fallback for SESSION_SECRET — must stay in sync with src/app.ts. */
const DEV_SESSION_SECRET_FALLBACK = 'dev-only-insecure-session-secret-0123456789';

/** Shape of the `unsign` method we rely on (the `SignerBase` interface is
 *  declared inside the `@fastify/cookie` namespace but not re-exported as a
 *  named type, so we declare the slice we use). */
interface SignerLike {
  unsign: (value: string) => { valid: boolean; value?: string };
}

/** The `@fastify/cookie` Signer constructor. `parse` and `Signer` are only
 *  reachable at runtime (and in types) through the `fastifyCookie` namespace
 *  object, not as top-level named exports, so we access them there. */
const fc = fastifyCookie as unknown as {
  parse: (cookieHeader: string) => Record<string, string>;
  Signer: new (secret: string) => SignerLike;
};
const SignerCtor = fc.Signer;

/** The underlying better-sqlite3 client, reachable off the Drizzle instance. */
type RawSqliteClient = import('better-sqlite3').Database;
function rawClient(db: AppDatabase): RawSqliteClient {
  return (db as unknown as { session: { client: RawSqliteClient } }).session.client;
}

/**
 * Resolves the authenticated user id for a WS upgrade request, or `null` when
 * the request is not authenticated. Mirrors what `@fastify/session` does on
 * the HTTP path, applied to the raw upgrade request.
 */
function resolveSessionUserId(db: AppDatabase, raw: { headers: Record<string, unknown> }): string | null {
  const header = raw.headers.cookie;
  if (typeof header !== 'string') return null;

  // `@fastify/cookie`'s parse URL-decodes values (the ws client sends the
  // signed cookie URL-encoded); this matches the HTTP path's behavior.
  const cookies = fc.parse(header);
  const sid = cookies['sessionId'];
  if (typeof sid !== 'string' || sid.length === 0) return null;

  const secret = process.env.SESSION_SECRET || DEV_SESSION_SECRET_FALLBACK;
  const { valid, value } = new SignerCtor(secret).unsign(sid);
  if (!valid || typeof value !== 'string') return null;

  const row = rawClient(db).prepare('SELECT sess FROM sessions WHERE sid = ?').get(value) as
    | { sess: string }
    | undefined;
  if (!row) return null;

  let parsed: { userId?: string };
  try {
    parsed = JSON.parse(row.sess);
  } catch {
    return null;
  }
  if (typeof parsed.userId !== 'string') return null;

  // A stale session pointing at a deleted user is treated as logged out.
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, parsed.userId)).get();
  return user ? parsed.userId : null;
}

// WebSocket readyState constants (ws library): CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3.
// We use the numeric literal 1 (OPEN) because `import type WebSocket from 'ws'` is
// type-only — the `WebSocket` identifier is not available as a runtime value.
const WS_OPEN = 1;

function send(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
  if (socket.readyState !== WS_OPEN) return;
  socket.send(JSON.stringify({ type, payload }));
}

function isMilestoneDays(value: unknown): value is MilestoneDays {
  return MILESTONES.includes(value as MilestoneDays);
}

/**
 * Registers the `GET /ws` route. `@fastify/websocket` v10 passes the raw
 * `ws.WebSocket` and the Fastify request.
 */
export default async function wsRoutes(app: FastifyInstance): Promise<void> {
  const db = (app as unknown as { db: AppDatabase }).db;

  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    // Prevent the plugin's `onResponse` hook from destroying the upgraded
    // socket. The plugin stashes the raw net socket on `request.raw` under a
    // private symbol and, in its `onResponse` hook, calls `.destroy()` on it
    // whenever `request.ws` is true (without checking `reply.hijacked`). We
    // replace that stashed socket with a no-op stub so the `onResponse` hook
    // has nothing real to destroy. The `ws` `socket` we hold is the same
    // underlying connection, so it is unaffected.
    const raw = req.raw as unknown as Record<symbol, unknown>;
    for (const sym of Object.getOwnPropertySymbols(raw)) {
      const val = raw[sym];
      if (val && typeof (val as { destroy?: unknown }).destroy === 'function') {
        raw[sym] = { destroy: () => {} };
      }
    }

    const userId = resolveSessionUserId(db, req.raw);

    // Reject unauthenticated upgrades (docs/SPEC.md §8 → 1008 policy violation).
    if (!userId) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    // Attach all listeners synchronously so no message is dropped before the
    // `connected` greeting is flushed.
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: { type?: unknown; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      if (!msg || typeof msg.type !== 'string') return;
      const payload = msg.payload ?? {};

      if (msg.type === 'subscribe') {
        handleSubscribe(socket, userId);
      } else if (msg.type === 'ack') {
        handleAck(userId, payload);
      }
    });

    socket.on('error', (err: Error) => {
      // Swallow socket errors (e.g. client vanished mid-message). The plugin's
      // teardown handles the connection lifecycle.
      void err;
    });

    // Announce the authenticated connection (docs/SPEC.md §8: `connected`).
    send(socket, 'connected', { userId });
  });

  /** Evaluates milestones for all of the user's habits and pushes the
   *  unacknowledged ones (docs/SPEC.md §8 milestone logic). Nothing is
   *  persisted here — persistence happens only on `ack`. */
  function handleSubscribe(socket: WebSocket, uid: string): void {
    const habitRows = db.select().from(habits).where(eq(habits.userId, uid)).all();
    const today = getTodayISO();

    for (const habit of habitRows) {
      const checkinRows = db
        .select({ date: checkins.date })
        .from(checkins)
        .where(eq(checkins.habitId, habit.id))
        .all();
      const { current } = calculateStreaks(checkinRows.map((r) => r.date), today);

      for (const milestone of MILESTONES) {
        if (current < milestone) continue;
        // Only send milestones not yet acknowledged. `and(eq(...), eq(...))`
        // for the two-part uniqueness condition — never plain-JS `&&`
        // (CLAUDE.md hard rule 2).
        const acknowledged = db
          .select({ id: milestoneNotifications.id })
          .from(milestoneNotifications)
          .where(and(eq(milestoneNotifications.habitId, habit.id), eq(milestoneNotifications.milestoneDays, milestone)))
          .get();
        if (acknowledged) continue;

        send(socket, 'milestone', {
          habitId: habit.id,
          habitName: habit.name,
          milestoneDays: milestone,
          currentStreak: current,
        });
      }
    }
  }

  /** Persists an acknowledged milestone. Security-critical: the habit must
   *  exist AND belong to the connected user; otherwise silently ignore
   *  (no write, no error) (docs/SPEC.md §8). */
  function handleAck(uid: string, payload: Record<string, unknown>): void {
    const habitId = payload.habitId;
    const milestoneDays = payload.milestoneDays;
    if (typeof habitId !== 'string' || !isMilestoneDays(milestoneDays)) {
      return; // silently ignore malformed acks
    }

    // `and(eq(...), eq(...))` — the habit must exist AND be owned by the
    // caller (CLAUDE.md hard rule 2; docs/SPEC.md §8 security rule).
    const habit = db
      .select()
      .from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, uid)))
      .get();
    if (!habit) return; // missing or not-owned → silently ignore (no write)

    // Persist on ack, idempotently via the UNIQUE(habit_id, milestone_days)
    // constraint — `INSERT OR IGNORE` makes a duplicate ack a no-op.
    const stmt = rawClient(db).prepare(
      'INSERT OR IGNORE INTO milestone_notifications (id, habit_id, user_id, milestone_days, sent_at) VALUES (?, ?, ?, ?, ?)',
    );
    stmt.run(randomUUID(), habitId, uid, milestoneDays, Math.floor(Date.now() / 1000));
  }
}
