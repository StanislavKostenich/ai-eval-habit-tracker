import { useMemo } from 'react';

interface CalendarProps {
  /** `YYYY-MM` — the month to display. */
  month: string;
  /** Set of `YYYY-MM-DD` dates that have a check-in. */
  checkedDates: Set<string>;
  /** The single shared "today" (from `getTodayISO()`) for the highlight. */
  today: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse `YYYY-MM` → { year, month } (month is 1-based). */
function parseMonth(month: string): { year: number; month: number } {
  const [year, m] = month.split('-');
  return { year: Number(year), month: Number(m) };
}

function iso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * A month grid for one habit (SPEC §9 HabitDetailPage). Highlights checked-in
 * dates (fire) and "today" (the shared `getTodayISO()` value). Pure date math —
 * no independent "today" computation.
 */
export function Calendar({ month, checkedDates, today }: CalendarProps) {
  const { year, month: m } = parseMonth(month);

  const cells = useMemo(() => {
    const firstDay = new Date(Date.UTC(year, m - 1, 1));
    const startOffset = firstDay.getUTCDay(); // 0 (Sun) .. 6 (Sat)
    const daysInMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    const result: (string | null)[] = [];
    for (let i = 0; i < totalCells; i++) {
      const dayNumber = i - startOffset + 1;
      if (dayNumber < 1 || dayNumber > daysInMonth) {
        result.push(null);
      } else {
        result.push(iso(year, m, dayNumber));
      }
    }
    return result;
  }, [year, m]);

  const monthLabel = `${MONTHS[m - 1]} ${year}`;
  const checkedCount = useMemo(() => {
    let count = 0;
    for (const date of cells) {
      if (date && checkedDates.has(date)) count++;
    }
    return count;
  }, [cells, checkedDates]);

  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-display text-lg font-semibold text-ink">{monthLabel}</h3>
        <span className="text-sm text-ink-soft">
          {checkedCount} check-in{checkedCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((day) => (
          <div key={day} className="pb-1 text-xs font-medium text-ink-faint">
            {day}
          </div>
        ))}

        {cells.map((date, index) => {
          if (date === null) {
            return <div key={`empty-${index}`} aria-hidden="true" />;
          }
          const isChecked = checkedDates.has(date);
          const isToday = date === today;
          return (
            <div
              key={date}
              className={`relative mx-auto flex aspect-square w-full max-w-11 items-center justify-center rounded-full text-sm transition-colors ${
                isChecked
                  ? 'font-semibold text-ink ring-2 ring-fire'
                  : isToday
                    ? 'font-semibold text-fire ring-2 ring-fire/50'
                    : 'text-ink-soft'
              }`}
            >
              {Number(date.slice(8))}
              {isChecked && (
                <span
                  className="absolute bottom-0.5 h-1.5 w-1.5 rounded-full bg-fire"
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span className="flex h-3 w-3 items-center justify-center rounded-full ring-2 ring-fire" aria-hidden="true">
            <span className="h-1 w-1 rounded-full bg-fire" />
          </span>
          Checked in
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full ring-2 ring-fire/50" aria-hidden="true" /> Today
        </span>
      </div>
    </div>
  );
}
