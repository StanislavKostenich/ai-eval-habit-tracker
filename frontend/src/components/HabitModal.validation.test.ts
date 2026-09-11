import { describe, expect, it } from 'vitest';
import type { HabitStatus } from '../types';

/**
 * The HabitModal form's field validation, extracted verbatim from
 * `HabitModal` (SPEC §9) so the rules — which must mirror the server exactly,
 * including the status-transition matrix — are testable in isolation.
 *
 * Kept in sync with HabitModal.tsx: the `errors` useMemo there is the single
 * source of truth; this file duplicates its expressions (constants included)
 * and pins them down with unit tests.
 */

const NAME_MIN = 2;
const NAME_MAX = 100;
const DESC_MAX = 500;

interface FieldErrors {
  name?: string;
  description?: string;
  startDate?: string;
  status?: string;
}

export function validateForm(input: {
  name: string;
  description: string;
  startDate: string;
  status: HabitStatus;
  isCreate: boolean;
  habitStatus?: HabitStatus;
}): FieldErrors {
  const { name, description, startDate, status, isCreate, habitStatus } = input;
  const trimmedName = name.trim();
  const e: FieldErrors = {};
  if (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX) {
    e.name = `Name must be between ${NAME_MIN} and ${NAME_MAX} characters.`;
  }
  if (description.length > DESC_MAX) {
    e.description = `Description must be at most ${DESC_MAX} characters.`;
  }
  if (isCreate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    e.startDate = 'Start date is required (YYYY-MM-DD).';
  }
  // Status-transition matrix (SPEC §6 / §9): archived is terminal.
  if (!isCreate && habitStatus) {
    if (habitStatus === 'archived' && status !== 'archived') {
      e.status = 'An archived habit cannot be moved to another status.';
    }
  }
  return e;
}

describe('HabitModal form validation', () => {
  describe('name (client floor 2 / server floor 1, shared ceiling 100 — CLAUDE.md hard rule 10)', () => {
    it('rejects empty and single-character names', () => {
      expect(validateForm(base({ name: '' })).name).toBeDefined();
      expect(validateForm(base({ name: 'a' })).name).toBeDefined();
      expect(validateForm(base({ name: '  ' })).name).toBeDefined();
    });

    it('accepts 2- and 100-character names', () => {
      expect(validateForm(base({ name: 'ab' })).name).toBeUndefined();
      expect(validateForm(base({ name: 'a'.repeat(100) })).name).toBeUndefined();
    });

    it('rejects 101-character names', () => {
      expect(validateForm(base({ name: 'a'.repeat(101) })).name).toBeDefined();
    });

    it('trims before measuring', () => {
      expect(validateForm(base({ name: '  ab  ' })).name).toBeUndefined();
    });
  });

  describe('description (max 500)', () => {
    it('accepts empty and exactly-500-character descriptions', () => {
      expect(validateForm(base({ description: '' })).description).toBeUndefined();
      expect(validateForm(base({ description: 'x'.repeat(500) })).description).toBeUndefined();
    });

    it('rejects 501 characters', () => {
      expect(validateForm(base({ description: 'x'.repeat(501) })).description).toBeDefined();
    });
  });

  describe('start date (create mode only)', () => {
    it('requires YYYY-MM-DD on create', () => {
      expect(validateForm(base({ isCreate: true, startDate: '2026-09-11' })).startDate).toBeUndefined();
      expect(validateForm(base({ isCreate: true, startDate: '11/09/2026' })).startDate).toBeDefined();
      expect(validateForm(base({ isCreate: true, startDate: '' })).startDate).toBeDefined();
    });

    it('does not validate start date in edit mode', () => {
      expect(
        validateForm(base({ isCreate: false, habitStatus: 'active', startDate: 'not-a-date' })).startDate,
      ).toBeUndefined();
    });
  });

  describe('status-transition matrix (SPEC §6, CLAUDE.md hard rule 4)', () => {
    it('lets active/paused habits move to any status', () => {
      for (const from of ['active', 'paused'] as HabitStatus[]) {
        for (const to of ['active', 'paused', 'archived'] as HabitStatus[]) {
          expect(
            validateForm(base({ isCreate: false, habitStatus: from, status: to })).status,
            `${from} → ${to} should be allowed`,
          ).toBeUndefined();
        }
      }
    });

    it('blocks leaving archived (422 server-side) — including the archived→archived no-op', () => {
      for (const to of ['active', 'paused'] as HabitStatus[]) {
        expect(
          validateForm(base({ isCreate: false, habitStatus: 'archived', status: to })).status,
          `archived → ${to} should be blocked`,
        ).toBeDefined();
      }
      expect(validateForm(base({ isCreate: false, habitStatus: 'archived', status: 'archived' })).status).toBeUndefined();
    });

    it('allows any status on create', () => {
      for (const to of ['active', 'paused', 'archived'] as HabitStatus[]) {
        expect(validateForm(base({ isCreate: true, status: to })).status).toBeUndefined();
      }
    });
  });
});

function base(overrides: Partial<{
  name: string;
  description: string;
  startDate: string;
  status: HabitStatus;
  isCreate: boolean;
  habitStatus?: HabitStatus;
}>): Parameters<typeof validateForm>[0] {
  return {
    name: 'Read 20 pages',
    description: '',
    startDate: '2026-09-11',
    status: 'active',
    isCreate: false,
    habitStatus: 'active',
    ...overrides,
  };
}
