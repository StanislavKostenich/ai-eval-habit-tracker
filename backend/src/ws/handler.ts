import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { and, eq } from 'drizzle-orm';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { AppDatabase } from '../db/index.js';
import { checkins, habits, milestoneNotifications, users } from '../db/schema.js';
import { calculateStreaks } from '../utils/streaks.js';
import { getTodayISO } from '../utils/date.js';

/**
 * WebSocket milestone engine (docs/SPEC.md §8).
 *
 * Attaches a `ws` WebSocketServer to the app's HTTP server and accepts the
 * `GET /ws` upgrade. **Auth is enforced at the route level, before the
 * WebSocket handshake completes**: an unauthenticated upgrade is answered
 * with a plain `401` HTTP response and the socket is destroyed — the
 * connection is never upgraded (docs/SPEC.md §8: "Do not move auth logic into
 * the handler after the upgrade succeeds, since that leaves a window where the
 * connection is accepted but not yet authorized").
 *
 * The session is resolved directly from the upgrade request's `cookie` header
 * (see `resolveSessionUserId`): parse the `sessionId` cookie, unsign it with
 * the app's `SESSION_SECRET` (the same signer `@fastify/session` uses —
 * `@fastify/cookie`'s `Signer`, cookie name `sessionId`), look the row up in
 * the SQLite session store, and confirm the user still exists. This mirrors
 * `@fastify/session`'s own deserialization, applied to the raw upgrade request
 * (which does not run Fastify's hook pipeline).
 *
 * The message protocol is a JSON envelope `{ type, payload }`:
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
 */

const MILESTONES = [3, 7, 30] as const;
type MilestoneDays = (typeof MILESTONES)[number];

// WebSocket readyState constants (ws library): CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3.
// We use the numeric literal 1 (OPEN) because `import type WebSocket` is
// type-only — the `WebSocket` identifier is not available as a runtime value.
const WS_OPEN = 1;

/** The session cookie name `@fastify/session` uses by default. */
const SESSION_COOKIE_NAME = 'sessionId';

function send(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
  if (socket.readyState !== WS_OPEN) return;
  socket.send(JSON.stringify({ type, payload }));
}

function isMilestoneDays(value: unknown): value is MilestoneDays {
  return MILESTONES.includes(value as MilestoneDays);
}

/** The underlying better-sqlite3 client, reachable off the Drizzle instance. */
type RawSqliteClient = import('better-sqlite3').Database;
function rawClient(db: AppDatabase): RawSqliteClient {
  return (db as unknown as { session: { client: RawSqliteClient } }).session.client;
}

/**
 * `@fastify/cookie`'s `Signer` constructor. It is only reachable at runtime
 * (and in types) through the `fastifyCookie` namespace object, not as a top-
 * level named export, so we access it there.
 */
interface SignerLike {
  unsign: (value: string) => { valid: boolean; value?: string };
}
const SignerCtor = (fastifyCookie as unknown as { Signer: new (secret: string) => SignerLike }).Signer;

/**
 * Resolves the authenticated user id for a WS upgrade request, or `null` when
 * the request is not authenticated. Mirrors `@fastify/session`'s
 * deserialization, applied to the raw upgrade request.
 */
function resolveSessionUserId(db: AppDatabase, raw: IncomingMessage): string | null {
  const header = raw.headers.cookie;
  if (typeof header !== 'string') return null;

  // `@fastify/cookie`'s `parse` URL-decodes values (the ws client sends the
  // signed cookie URL-encoded); this matches the HTTP path's behavior.
  const cookies = (fastifyCookie as unknown as { parse: (h: string) => Record<string, string> }).parse(header);
  const sid = cookies[SESSION_COOKIE_NAME];
  if (typeof sid !== 'string' || sid.length === 0) return null;

  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
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

/**
 * Registers the WebSocket milestone engine.
 *
 * Attaches a `ws` WebSocketServer to `app.server` (the app's HTTP server) and
 * handles the `GET /ws` upgrade. Must be called once the app's HTTP server
 * exists (i.e. the plugin has been registered, before the server has started
 * listening — `attach()` only records the listener).
 */
export default async function wsRoutes(app: FastifyInstance): Promise<void> {
  const db = (app as unknown as { db: AppDatabase }).db;

  const wss = new WebSocketServer({ noServer: true });

  // Route-level auth (docs/SPEC.md §8): reject unauthenticated upgrades with a
  // 401 BEFORE the handshake completes. The socket is destroyed immediately,
  // so the connection is never upgraded and no window exists in which the
  // connection is accepted but not yet authorized.
  app.server.on('upgrade', (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws') {
      // Not our route — destroy (no other upgrade routes exist in this app).
      socket.destroy();
      return;
    }

    const userId = resolveSessionUserId(db, req);
    if (!userId) {
      // Reject with a real, flushed 401 response. A bare
      // `new ServerResponse(req).end()` + immediate `socket.destroy()` loses
      // the buffered bytes in practice (the client observes a raw hang-up,
      // not the 401), so the status line and headers are written directly to
      // the socket, the body is flushed with `end`, and teardown waits for
      // the write to complete.
      const body = JSON.stringify({ error: 'Unauthorized' });
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n' +
          'Content-Type: application/json\r\n' +
          'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          body,
      );
      socket.end(() => socket.destroy());
      return;
    }

    // Authenticated: complete the handshake, then hand the socket to wss.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      void userId; // userId is re-resolved from the socket's request in onConnection
    });
  });

  // Per-connection message handling. The socket's originating request carries
  // the same cookie the upgrade used, so we re-resolve the session to obtain
  // the authenticated user id for this connection.
  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const userId = resolveSessionUserId(db, req);
    if (!userId) {
      // Should not happen (auth already enforced at upgrade), but be safe:
      // close without a greeting.
      socket.close();
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
      // Swallow socket errors (e.g. client vanished mid-message); the `ws`
      // library's own teardown handles the connection lifecycle.
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
