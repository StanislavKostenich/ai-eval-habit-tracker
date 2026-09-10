import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Single source of truth for the database schema (docs/SPEC.md §4).
 * Migrations are generated from this file with `drizzle-kit generate` —
 * never hand-write DDL elsewhere (CLAUDE.md hard rule 7).
 */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(), // 'google' | 'github' | 'demo'
    providerUserId: text('provider_user_id').notNull(),
    email: text('email'),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: integer('created_at').notNull(), // Unix timestamp (seconds)
  },
  (table) => ({
    providerPairUnique: unique('users_provider_provider_user_id_unique').on(
      table.provider,
      table.providerUserId,
    ),
  }),
);

export const habits = sqliteTable(
  'habits',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    startDate: text('start_date').notNull(), // YYYY-MM-DD
    status: text('status')
      .notNull()
      .$type<'active' | 'paused' | 'archived'>()
      .default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    // NOTE: drizzle-kit 0.24 does not render table-level CHECK constraints into
    // the generated migration (documented deviation); the app enforces the
    // status enum in route handlers (PATCH/POST) regardless.
    statusCheck: check('habits_status_check', sql`${table.status} IN ('active','paused','archived')`),
  }),
);

export const checkins = sqliteTable(
  'checkins',
  {
    id: text('id').primaryKey(),
    habitId: text('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    date: text('date').notNull(), // YYYY-MM-DD
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    habitDateUnique: unique('checkins_habit_id_date_unique').on(table.habitId, table.date),
  }),
);

export const milestoneNotifications = sqliteTable(
  'milestone_notifications',
  {
    id: text('id').primaryKey(),
    habitId: text('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    milestoneDays: integer('milestone_days').notNull(), // 3 | 7 | 30
    sentAt: integer('sent_at').notNull(),
  },
  (table) => ({
    habitMilestoneUnique: unique('milestone_notifications_habit_id_milestone_days_unique').on(
      table.habitId,
      table.milestoneDays,
    ),
  }),
);

/** Inferred row type of the `users` table. */
export type UserRow = typeof users.$inferSelect;
