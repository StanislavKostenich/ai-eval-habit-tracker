import { and, eq } from 'drizzle-orm';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { checkins, habits, users } from './schema.js';
import { createDb } from './index.js';

/** UTC "today" (YYYY-MM-DD) — same rule as the rest of the app. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Seeds the demo user (provider='demo', provider_user_id='demo-user'),
 * 3 habits, and check-ins:
 *   - "Morning Run" (active): 3 consecutive check-ins ending today, so a
 *     3-day milestone is immediately reachable on the next `subscribe`.
 *   - "Read 20 pages" (paused): 2 consecutive check-ins ending yesterday.
 *   - "Old journaling habit" (archived): 1 check-in from 5 days ago.
 *
 * Idempotency: WIPES all data owned by the demo user (check-ins, habits,
 * user) before re-seeding — a documented, acceptable behavior for the demo
 * data set. Other users' rows are untouched.
 *
 * Run with: `npm run db:seed`
 */
export function seedDemoData(): void {
  const db = createDb();
  const now = nowSec();

  const demoUser = {
    id: randomUUID(),
    provider: 'demo' as const,
    providerUserId: 'demo-user',
    email: 'demo@habit-tracker.local',
    displayName: 'Demo User',
    avatarUrl: null as string | null,
    createdAt: now,
  };

  const totalCheckins = [3, 2, 1].reduce((a, b) => a + b, 0);

  db.transaction((tx) => {
    // Wipe existing demo data (child rows first for clarity; FKs are cascading).
    const existing = tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.provider, 'demo'), eq(users.providerUserId, 'demo-user')))
      .all();

    for (const row of existing) {
      tx.delete(checkins).where(eq(checkins.userId, row.id)).run();
      tx.delete(habits).where(eq(habits.userId, row.id)).run();
      tx.delete(users).where(eq(users.id, row.id)).run();
    }

    tx.insert(users).values(demoUser).run();

    const habitsToSeed = [
      {
        id: randomUUID(),
        userId: demoUser.id,
        name: 'Morning Run',
        description: 'Run 30 minutes before work',
        startDate: daysAgoISO(10),
        status: 'active' as const,
        checkinOffsets: [0, 1, 2], // today, yesterday, 2 days ago
      },
      {
        id: randomUUID(),
        userId: demoUser.id,
        name: 'Read 20 pages',
        description: 'Reading for pleasure',
        startDate: daysAgoISO(7),
        status: 'paused' as const,
        checkinOffsets: [1, 2], // yesterday, 2 days ago
      },
      {
        id: randomUUID(),
        userId: demoUser.id,
        name: 'Old journaling habit',
        description: 'Journaling (no longer active)',
        startDate: daysAgoISO(20),
        status: 'archived' as const,
        checkinOffsets: [5], // 5 days ago
      },
    ];

    for (const habit of habitsToSeed) {
      tx.insert(habits)
        .values({
          id: habit.id,
          userId: habit.userId,
          name: habit.name,
          description: habit.description,
          startDate: habit.startDate,
          status: habit.status,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      for (const offset of habit.checkinOffsets) {
        tx.insert(checkins)
          .values({
            id: randomUUID(),
            habitId: habit.id,
            userId: habit.userId,
            date: daysAgoISO(offset),
            createdAt: now,
          })
          .run();
      }
    }
  });

  console.log(
    `seeded demo user + 3 habits + ${totalCheckins} check-ins (DATABASE_PATH=${process.env.DATABASE_PATH || './data/habits.db'})`,
  );
}

// Run when invoked directly: `npm run db:seed`
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  seedDemoData();
}
