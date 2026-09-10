import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { checkins, habits } from '../db/schema.js';
import type { SessionLike } from '../types.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { calculateStreaks } from '../utils/streaks.js';
import { getTodayISO } from '../utils/date.js';

/**
 * Habits routes (docs/SPEC.md §6), mounted at `/api`.
 *
 * All routes sit behind the `requireAuth` guard (docs/SPEC.md §12) — see the
 * `onRequest` hook below for why it's not a route `preHandler`.
 * The unified ownership policy applies to every id-addressed operation:
 * a missing habit AND a habit belonging to another user both return
 * `404 { error: 'Not found' }` — never 403 (docs/SPEC.md §6, CLAUDE.md
 * hard rule 3).
 *
 * Every multi-condition `where` uses `and(eq(a, x), eq(b, y))` — never
 * plain-JS `&&`, which silently drops the first condition (CLAUDE.md
 * hard rule 2, docs/SPEC.md §6 correctness note).
 */

const HABIT_STATUSES = ['active', 'paused', 'archived'] as const;
type HabitStatus = (typeof HABIT_STATUSES)[number];

/** A habit row as returned by `GET /habits` and `GET /habits/:id` (docs/SPEC.md §6). */
export interface HabitWithStreaks {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  startDate: string;
  status: HabitStatus;
  createdAt: number;
  updatedAt: number;
  currentStreak: number;
  bestStreak: number;
  totalCheckins: number;
  completedToday: boolean;
}

function isHabitStatus(value: unknown): value is HabitStatus {
  return typeof value === 'string' && (HABIT_STATUSES as readonly string[]).includes(value);
}

/**
 * Loads one of the caller's habits, or `null` when it is missing OR not
 * owned by the caller (both cases collapse to `null` → 404 at the route
 * level, per the unified ownership policy).
 */
function findOwnedHabit(db: AppDatabase, userId: string, habitId: string) {
  // `and(eq(...), eq(...))` per CLAUDE.md hard rule 2 — the two conditions
  // must both be applied (a plain `&&` would drop the id filter).
  return (
    db
      .select()
      .from(habits)
      .where(and(eq(habits.id, habitId), eq(habits.userId, userId)))
      .get() ?? null
  );
}

/**
 * Enriches a habit row with its streak fields and `completedToday`.
 * `completedToday` is computed here — alongside the streaks — from the same
 * set of check-in dates, and reused by the `completedToday` filter so no
 * second query is issued (docs/SPEC.md §6).
 */
type HabitRow = typeof habits.$inferSelect;

function withStreaks(db: AppDatabase, habit: HabitRow, today: string): HabitWithStreaks {
  const rows = db.select({ date: checkins.date }).from(checkins).where(eq(checkins.habitId, habit.id)).all();
  const dates = rows.map((r) => r.date);
  const { current, best, total } = calculateStreaks(dates, today);
  const completedToday = dates.includes(today);
  return {
    id: habit.id,
    userId: habit.userId,
    name: habit.name,
    description: habit.description,
    startDate: habit.startDate,
    status: habit.status,
    createdAt: habit.createdAt,
    updatedAt: habit.updatedAt,
    currentStreak: current,
    bestStreak: best,
    totalCheckins: total,
    completedToday,
  };
}

export default async function habitRoutes(app: FastifyInstance): Promise<void> {
  const db = (app as unknown as { db: AppDatabase }).db;

  /**
   * requireAuth guard (docs/SPEC.md §12) for every habit route.
   *
   * Implemented as an `onRequest` hook rather than a route `preHandler`:
   * `@fastify/session` v10 + `app.inject()` (used by the test suite,
   * docs/SPEC.md §10) has a lifecycle incompatibility where a `preHandler`
   * on a session route hangs the injected request (the session `onSend`
   * save never completes under the mocked transport). An `onRequest` hook
   * avoids that path and behaves identically: unauthenticated requests get
   * `401 { error: 'Unauthorized' }` and are aborted.
   */
  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    requireAuth(request, reply);
    if (reply.sent) return;
    done();
  });

  /**
   * GET /api/habits
   * Query: `?status=active|paused|archived&q=text&completedToday=true|false`.
   * Returns the caller's habits enriched with `currentStreak`, `bestStreak`,
   * `totalCheckins`, `completedToday` (docs/SPEC.md §6).
   */
  app.get('/habits', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const q = (request.query as Record<string, unknown>).q;
    const status = (request.query as Record<string, unknown>).status;
    const completedToday = (request.query as Record<string, unknown>).completedToday;

    // `status` filter: when present it must be a valid enum value; reject
    // anything else with 400 rather than silently ignoring it.
    if (status !== undefined && !isHabitStatus(status)) {
      return reply.status(400).send({ error: `Invalid status filter: expected one of ${HABIT_STATUSES.join(', ')}` });
    }
    // `q` filter: case-insensitive substring on both `name` and `description`.
    if (q !== undefined && typeof q !== 'string') {
      return reply.status(400).send({ error: 'Invalid q filter: expected a string' });
    }
    // `completedToday` filter: must be a boolean string when present.
    if (completedToday !== undefined && completedToday !== 'true' && completedToday !== 'false') {
      return reply.status(400).send({ error: 'Invalid completedToday filter: expected "true" or "false"' });
    }

    // Base condition: the caller's habits. Additional filters are combined
    // with `and(...)` / `or(...)` — never plain-JS `&&` (CLAUDE.md hard
    // rule 2). Drizzle 0.33 types `and(...)` as `SQL | undefined`, so the
    // combined result is narrowed with `?? where` (the single-argument case
    // returns the argument, so `where` is the fallback).
    let where: SQL = eq(habits.userId, userId);
    if (isHabitStatus(status)) {
      where = and(where, eq(habits.status, status)) ?? where;
    }
    if (typeof q === 'string' && q.length > 0) {
      const pattern = `%${q.toLowerCase()}%`;
      // Case-insensitive substring on BOTH `name` and `description`
      // (docs/SPEC.md §6). The pattern is a driver-parameterized value, not
      // inlined SQL text.
      where =
        and(where, or(sql`lower(${habits.name}) LIKE ${pattern}`, sql`lower(${habits.description}) LIKE ${pattern}`)) ??
        where;
    }

    const rows = db.select().from(habits).where(where).all();
    const today = getTodayISO();

    // Enrich each habit once, then filter on the computed `completedToday`
    // — no second query to recompute it (docs/SPEC.md §6).
    let enriched = rows.map((row) => withStreaks(db, row, today));
    if (completedToday === 'true') enriched = enriched.filter((h) => h.completedToday);
    if (completedToday === 'false') enriched = enriched.filter((h) => !h.completedToday);

    return reply.status(200).send(enriched);
  });

  /**
   * POST /api/habits
   * Body: `{ name, description?, startDate, status? }`.
   * 400 when `name`/`startDate` are missing or `status` is an invalid enum
   * value; `status` defaults to `'active'` (docs/SPEC.md §6).
   */
  app.post('/habits', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { name, description, startDate, status } = body;

    if (typeof name !== 'string' || name.length === 0) {
      return reply.status(400).send({ error: 'name is required' });
    }
    if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return reply.status(400).send({ error: 'startDate is required and must be YYYY-MM-DD' });
    }
    let resolvedStatus: HabitStatus = 'active';
    if (status !== undefined) {
      if (!isHabitStatus(status)) {
        return reply.status(400).send({ error: `Invalid status: expected one of ${HABIT_STATUSES.join(', ')}` });
      }
      resolvedStatus = status;
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return reply.status(400).send({ error: 'description must be a string when provided' });
    }

    const now = Math.floor(Date.now() / 1000);
    const inserted = db
      .insert(habits)
      .values({
        id: randomUUID(),
        userId,
        name,
        description: description === undefined || description === null ? null : (description as string),
        startDate,
        status: resolvedStatus,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return reply.status(201).send(inserted);
  });

  /**
   * GET /api/habits/:id — 200 habit + streaks; 404 when the habit is missing
   * OR not owned by the caller (docs/SPEC.md §6).
   */
  app.get('/habits/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const { id } = request.params as { id: string };
    const habit = findOwnedHabit(db, userId, id);
    if (!habit) return reply.status(404).send({ error: 'Not found' });
    return reply.status(200).send(withStreaks(db, habit, getTodayISO()));
  });

  /**
   * PATCH /api/habits/:id
   * Body: `{ name?, description?, status? }`.
   * Enforces the status transition matrix (docs/SPEC.md §6); 404 for
   * missing/not-owned.
   */
  app.patch('/habits/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const { id } = request.params as { id: string };
    const habit = findOwnedHabit(db, userId, id);
    if (!habit) return reply.status(404).send({ error: 'Not found' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const { name, description, status } = body;

    if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
      return reply.status(400).send({ error: 'name must be a non-empty string' });
    }
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return reply.status(400).send({ error: 'description must be a string when provided' });
    }

    const updates: { name?: string; description?: string | null; status?: HabitStatus; updatedAt: number } = {
      updatedAt: Math.floor(Date.now() / 1000),
    };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description === null ? null : (description as string);

    if (status !== undefined) {
      if (!isHabitStatus(status)) {
        return reply.status(400).send({ error: `Invalid status: expected one of ${HABIT_STATUSES.join(', ')}` });
      }
      // Status transition matrix (docs/SPEC.md §6): `archived` is terminal —
      // any transition out of it (including the no-op re-set of `archived`)
      // is 422. `active` <-> `paused` and `active|paused` -> `archived` are
      // allowed.
      if (habit.status === 'archived') {
        return reply.status(422).send({ error: `Cannot transition from archived to ${status}` });
      }
      updates.status = status;
    }

    db.update(habits)
      .set(updates)
      // `and(...)` for the two-part ownership-scoped update (hard rule 2).
      .where(and(eq(habits.id, id), eq(habits.userId, userId)))
      .run();

    const updated = findOwnedHabit(db, userId, id);
    return reply.status(200).send(updated ?? habit);
  });

  /**
   * DELETE /api/habits/:id — 204; cascades to checkins + milestone
   * notifications (schema FK `ON DELETE CASCADE`, docs/SPEC.md §4); 404
   * for missing/not-owned.
   */
  app.delete('/habits/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const { id } = request.params as { id: string };
    const habit = findOwnedHabit(db, userId, id);
    if (!habit) return reply.status(404).send({ error: 'Not found' });
    // `and(...)` for the two-part ownership-scoped delete (hard rule 2).
    db.delete(habits).where(and(eq(habits.id, id), eq(habits.userId, userId))).run();
    return reply.status(204).send();
  });

  /**
   * GET /api/habits/:id/checkins?month=YYYY-MM
   * Calendar view: the caller's check-ins for the habit in the given month,
   * sorted ascending by date. 404 when the habit is missing OR not owned
   * (docs/SPEC.md §6). `month` is optional; when absent all check-ins are
   * returned (also ascending).
   */
  app.get('/habits/:id/checkins', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const { id } = request.params as { id: string };
    const habit = findOwnedHabit(db, userId, id);
    if (!habit) return reply.status(404).send({ error: 'Not found' });

    const month = (request.query as Record<string, unknown>).month;
    let where: SQL = eq(checkins.habitId, habit.id);
    if (month !== undefined) {
      if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
        return reply.status(400).send({ error: 'month must be YYYY-MM' });
      }
      // `and(...)` for the two-part filter (hard rule 2).
      where = and(eq(checkins.habitId, habit.id), sql`${checkins.date} LIKE ${`${month}-%`}`) ?? where;
    }
    const rows = db.select().from(checkins).where(where).orderBy(checkins.date).all();
    return reply.status(200).send(rows);
  });

  /**
   * POST /api/habits/:id/checkins
   * Body: `{ date: "YYYY-MM-DD" }`. Validation order (docs/SPEC.md §6) —
   * the order is part of the contract:
   *   1. date format → 400
   *   2. habit exists and is owned by the caller → 404
   *   3. habit is `active` → 422 `{ error: 'Habit is not active' }`
   *   4. date is not in the future (UTC string compare) → 422
   *   5. no existing checkin for (habitId, date) → 409
   */
  app.post('/habits/:id/checkins', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const date = body.date;

    // 1. date format first (before any DB work).
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return reply.status(400).send({ error: 'date is required and must be YYYY-MM-DD' });
    }
    // 2. ownership (404 for missing AND not-owned — unified policy).
    const habit = findOwnedHabit(db, userId, id);
    if (!habit) return reply.status(404).send({ error: 'Not found' });
    // 3. must be active.
    if (habit.status !== 'active') {
      return reply.status(422).send({ error: 'Habit is not active' });
    }
    // 4. not in the future — UTC "today" as a string, string comparison
    // only, no timezone conversion (docs/SPEC.md §7, CLAUDE.md hard rule 1).
    const today = getTodayISO();
    if (date > today) {
      return reply.status(422).send({ error: 'date must not be in the future' });
    }
    // 5. duplicate check — `and(...)` for the two-part uniqueness condition
    // (hard rule 2: a plain `&&` here would drop the habit filter and let a
    // checkin on another habit block this one).
    const existing = db
      .select({ date: checkins.date })
      .from(checkins)
      .where(and(eq(checkins.habitId, habit.id), eq(checkins.date, date)))
      .get();
    if (existing) {
      return reply.status(409).send({ error: 'Check-in already exists for this date' });
    }

    db.insert(checkins)
      .values({
        id: randomUUID(),
        habitId: habit.id,
        userId,
        date,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    // Return the stored row (not just the input) so the response shape
    // matches GET /checkins.
    const created = db
      .select()
      .from(checkins)
      .where(and(eq(checkins.habitId, habit.id), eq(checkins.date, date)))
      .get();
    return reply.status(201).send(created);
  });

  /**
   * DELETE /api/habits/:id/checkins/:date
   * Today-only undo (docs/SPEC.md §6): 422 when `date !== today` (UTC),
   * 404 when the habit is missing OR not owned. A missing check-in for the
   * (today) date is a no-op 204 (idempotent undo).
   */
  app.delete('/habits/:id/checkins/:date', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.session as unknown as SessionLike).userId as string;
    const { id, date } = request.params as { id: string; date: string };
    // 404 first: missing/not-owned habit collapses both cases (unified policy).
    const habit = findOwnedHabit(db, userId, id);
    if (!habit) return reply.status(404).send({ error: 'Not found' });
    // Today-only: UTC string compare (hard rule 1).
    if (date !== getTodayISO()) {
      return reply.status(422).send({ error: "Can only delete today's check-in" });
    }
    // `and(...)` for the two-part ownership+date scoped delete (hard rule 2).
    db.delete(checkins).where(and(eq(checkins.habitId, habit.id), eq(checkins.date, date))).run();
    return reply.status(204).send();
  });
}
