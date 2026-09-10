import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createDb, type AppDatabase } from '../src/db/index.js';
import { migrateDb } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { checkins, habits, users } from '../src/db/schema.js';

/**
 * T6–T9 (docs/SPEC.md §8 + §10): the WebSocket milestone engine.
 *
 * Unlike the HTTP test files, these tests drive a REAL `ws` client against a
 * running Fastify instance (`app.listen({ port: 0 })`) — HTTP streak
 * assertions are explicitly NOT sufficient for T6–T9 (docs/SPEC.md §10). The
 * client authenticates by sending the same `sessionId` cookie the demo-login
 * endpoint mints, over the WS upgrade request.
 *
 * The in-memory SQLite database is constructed fresh in `beforeAll` and reset
 * in `beforeEach` so the tests are order-independent (docs/SPEC.md §10).
 */

/** A server→client WS message (docs/SPEC.md §8 envelope). */
interface WSMessage {
  type: string;
  payload: Record<string, unknown>;
}

describe('T6–T9 — WebSocket milestone engine (real ws client)', () => {
  let db: AppDatabase;
  let app: FastifyInstance;
  /** The port the real HTTP/WS server is listening on (from `listen({port:0})`). */
  let port: number;
  const SESSION_SECRET = 'test-session-secret-0123456789-0123456789';

  /** The underlying better-sqlite3 client (used to reset the `sessions` table). */
  function rawClient(): import('better-sqlite3').Database {
    return (db as unknown as { session: { client: import('better-sqlite3').Database } }).session.client;
  }

  /** Pulls the signed `sessionId=` cookie value from a set-cookie header. */
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

  /** Logs in the first-class demo user and returns { cookie, userId }. */
  async function demoLogin(): Promise<{ cookie: string; userId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/auth/demo-login' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { userId: string };
    const cookie = sessionCookieFrom(res.headers['set-cookie'] as string[] | undefined);
    return { cookie, userId: body.userId };
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

  /** Creates a habit row directly via Drizzle and returns its id. */
  function createHabitRow(userId: string, name = 'WS Habit'): string {
    const now = Math.floor(Date.now() / 1000);
    const id = randomUUID();
    db.insert(habits)
      .values({
        id,
        userId,
        name,
        description: null,
        startDate: daysAgoISO(0),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }

  /** Seeds `count` consecutive check-ins ending today (offsets 0..count-1). */
  function seedCheckins(habitId: string, userId: string, count: number): void {
    const now = Math.floor(Date.now() / 1000);
    for (let offset = 0; offset < count; offset++) {
      db.insert(checkins)
        .values({
          id: randomUUID(),
          habitId,
          userId,
          date: daysAgoISO(offset),
          createdAt: now,
        })
        .run();
    }
  }

  interface Received {
    ws: WebSocket;
    messages: WSMessage[];
    waitFor(type: string, timeoutMs?: number): Promise<WSMessage>;
    close(): void;
  }

  /**
   * Connects a real `ws` client (with the session cookie) and resolves once
   * the socket is open, together with a `Received` that already has its
   * `message` listener attached.
   *
   * IMPORTANT: the `message` listener is attached at socket-creation time, NOT
   * after `open`. The server sends the `connected` greeting the moment the
   * upgrade completes — which is exactly what fires the client's `open` event.
   * If the listener were only attached after `open` resolved, the greeting
   * (already delivered) would be lost and every `waitFor('connected')` would
   * time out. Attaching immediately buffers the greeting so it is never dropped.
   */
  function connect(cookie: string): Promise<Received> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie },
    });

    const messages: WSMessage[] = [];
    const waiters: { type: string; resolve: (m: WSMessage) => void; timer: NodeJS.Timeout }[] = [];

    const recv: Received = {
      ws,
      messages,
      waitFor(type, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
          const existing = messages.find((m) => m.type === type);
          if (existing) {
            resolve(existing);
            return;
          }
          const timer = setTimeout(
            () => reject(new Error(`timeout waiting for WS message type '${type}'`)),
            timeoutMs,
          );
          waiters.push({ type, resolve, timer });
        });
      },
      close() {
        for (const w of waiters) clearTimeout(w.timer);
        ws.close();
      },
    };

    // Attach the buffering listener immediately (before `open`).
    ws.on('message', (data: Buffer | string) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(data.toString()) as WSMessage;
      } catch {
        return; // ignore non-JSON frames
      }
      messages.push(msg);
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        if (w && w.type === msg.type) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(msg);
          break;
        }
      }
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 4000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(recv);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Resolves when `ms` elapses; used by the "no message" assertions (T9 + the
   * unauthenticated case) to give the server a chance to push, then assert.
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Awaiting the `connected` handshake message (asserts the session was read). */
  async function assertConnected(recv: Received, expectedUserId?: string): Promise<WSMessage> {
    const conn = await recv.waitFor('connected');
    expect(conn.payload).toHaveProperty('userId');
    if (expectedUserId) expect(conn.payload.userId).toBe(expectedUserId);
    return conn;
  }

  /**
   * Waits for a `milestone` message whose `milestoneDays` equals `days`.
   *
   * A streak of N days legitimately emits *every* unacked milestone ≤ N (a
   * 7-day streak emits the 3- and 7-day milestones; a 30-day streak emits
   * 3/7/30). So asserting on the *first* `milestone` frame is wrong — the test
   * must wait for the specific milestone it cares about. Polls the buffered
   * messages (which grow as frames arrive) until a matching one appears or the
   * deadline passes.
   */
  async function waitMilestone(
    recv: Received,
    days: number,
    timeoutMs = 4000,
  ): Promise<WSMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = recv.messages.find(
        (m) => m.type === 'milestone' && m.payload.milestoneDays === days,
      );
      if (hit) return hit;
      if (Date.now() >= deadline) {
        throw new Error(`timeout waiting for milestone with milestoneDays ${days}`);
      }
      // Ensure the connection is kept alive and give in-flight frames a tick.
      await recv.waitFor('milestone', 50).catch(() => undefined);
    }
  }

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.NODE_ENV = 'test';

    db = createDb(':memory:');
    migrateDb(db);
    app = createApp(db);
    await app.ready();

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const url = new URL(address);
    port = Number(url.port);
    expect(port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Reset the in-memory DB between tests (docs/SPEC.md §10). */
  beforeEach(() => {
    db.delete(checkins).run();
    db.delete(habits).run();
    db.delete(users).run();
    rawClient().prepare('DELETE FROM sessions').run();
  });

  // ---------------------------------------------------------------------
  // T6 — 3 consecutive check-ins → a milestone with milestoneDays 3.
  // ---------------------------------------------------------------------
  it('T6 — 3 consecutive check-ins → milestone with milestoneDays 3', async () => {
    const { cookie, userId } = await demoLogin();
    const habitId = createHabitRow(userId, 'T6 Habit');
    seedCheckins(habitId, userId, 3);

    const recv = await connect(cookie);
    try {
      await assertConnected(recv, userId);
      recv.ws.send(JSON.stringify({ type: 'subscribe', payload: { milestones: true } }));
      const m = await waitMilestone(recv, 3);
      expect(m.payload.milestoneDays).toBe(3);
      expect(m.payload.habitId).toBe(habitId);
      expect(m.payload.habitName).toBe('T6 Habit');
      expect(m.payload.currentStreak).toBe(3);
    } finally {
      recv.close();
    }
  });

  // ---------------------------------------------------------------------
  // T7 — 7 consecutive check-ins → a milestone with milestoneDays 7.
  // ---------------------------------------------------------------------
  it('T7 — 7 consecutive check-ins → milestone with milestoneDays 7', async () => {
    const { cookie, userId } = await demoLogin();
    const habitId = createHabitRow(userId, 'T7 Habit');
    seedCheckins(habitId, userId, 7);

    const recv = await connect(cookie);
    try {
      await assertConnected(recv, userId);
      recv.ws.send(JSON.stringify({ type: 'subscribe', payload: { milestones: true } }));
      const m = await waitMilestone(recv, 7);
      expect(m.payload.milestoneDays).toBe(7);
      expect(m.payload.habitId).toBe(habitId);
      expect(m.payload.currentStreak).toBe(7);
    } finally {
      recv.close();
    }
  });

  // ---------------------------------------------------------------------
  // T8 — 30 consecutive check-ins → a milestone with milestoneDays 30.
  // ---------------------------------------------------------------------
  it('T8 — 30 consecutive check-ins → milestone with milestoneDays 30', async () => {
    const { cookie, userId } = await demoLogin();
    const habitId = createHabitRow(userId, 'T8 Habit');
    seedCheckins(habitId, userId, 30);

    const recv = await connect(cookie);
    try {
      await assertConnected(recv, userId);
      recv.ws.send(JSON.stringify({ type: 'subscribe', payload: { milestones: true } }));
      const m = await waitMilestone(recv, 30);
      expect(m.payload.milestoneDays).toBe(30);
      expect(m.payload.habitId).toBe(habitId);
      expect(m.payload.currentStreak).toBe(30);
    } finally {
      recv.close();
    }
  });

  // ---------------------------------------------------------------------
  // T9 — ack suppresses the milestone on the next subscribe (persist-on-ack).
  // ---------------------------------------------------------------------
  it('T9 — ack persists; the milestone is NOT re-sent on the next subscribe', async () => {
    const { cookie, userId } = await demoLogin();
    const habitId = createHabitRow(userId, 'T9 Habit');
    seedCheckins(habitId, userId, 3);

    // First connection: subscribe → receives the (habitId, 3) milestone,
    // then acks it over the SAME connection.
    const recv1 = await connect(cookie);
    try {
      await assertConnected(recv1, userId);
      recv1.ws.send(JSON.stringify({ type: 'subscribe', payload: { milestones: true } }));
      const m = await recv1.waitFor('milestone');
      expect(m.payload.milestoneDays).toBe(3);
      expect(m.payload.habitId).toBe(habitId);

      // Ack the milestone over the same connection.
      recv1.ws.send(JSON.stringify({ type: 'ack', payload: { habitId, milestoneDays: 3 } }));
      await sleep(300); // let the server process the ack before disconnecting.
    } finally {
      recv1.close();
    }

    // Reconnect (a brand-new ws) and subscribe again. The acked milestone
    // must NOT be re-sent — wait 800ms and assert no milestone arrived.
    const recv2 = await connect(cookie);
    try {
      await assertConnected(recv2, userId);
      recv2.ws.send(JSON.stringify({ type: 'subscribe', payload: { milestones: true } }));
      await sleep(800);
      const milestones = recv2.messages.filter((m) => m.type === 'milestone');
      expect(milestones).toHaveLength(0);
    } finally {
      recv2.close();
    }
  });

  // ---------------------------------------------------------------------
  // Extra (lightweight) — an unauthenticated upgrade is closed with 1008.
  // ---------------------------------------------------------------------
  it('unauthenticated upgrade (no cookie) is closed with code 1008', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), 4000);
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(closeInfo.code).toBe(1008);
  });
});
