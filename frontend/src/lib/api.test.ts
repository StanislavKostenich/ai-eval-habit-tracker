import { describe, expect, it } from 'vitest';
import { toQueryString, type HabitsQuery } from './api';

/**
 * Query-string construction for the habits list (SPEC §9 single query key):
 * `undefined` values are dropped (so a partial `HabitsQuery` works under
 * `exactOptionalPropertyTypes`), `null` completedToday drops the filter, and
 * booleans serialize as the literal `true`/`false` the backend expects.
 */
describe('toQueryString', () => {
  it('returns an empty string when every parameter is undefined', () => {
    expect(toQueryString({ status: undefined, q: undefined, completedToday: undefined })).toBe('');
  });

  it('drops undefined entries and URL-encodes the rest', () => {
    expect(toQueryString({ q: 'read 20', status: undefined, completedToday: undefined })).toBe(
      '?q=read+20',
    );
  });

  it('serializes completedToday as the literal true/false the backend expects', () => {
    // `api.listHabits` converts the boolean to the string the server parses;
    // `toQueryString` itself only accepts strings (and drops `undefined`).
    expect(toQueryString({ completedToday: 'true' })).toBe('?completedToday=true');
    expect(toQueryString({ completedToday: 'false' })).toBe('?completedToday=false');
  });

  it('keeps all three filters when all are present', () => {
    const query: HabitsQuery = { status: 'active', q: 'gym', completedToday: true };
    const qs = toQueryString({
      status: query.status || undefined,
      q: query.q && query.q.length > 0 ? query.q : undefined,
      completedToday: query.completedToday === null ? undefined : query.completedToday ? 'true' : 'false',
    });
    expect(qs).toBe('?status=active&q=gym&completedToday=true');
  });
});
