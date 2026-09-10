import { useEffect, useMemo, useRef, useState } from 'react';
import { getTodayISO } from '../lib/getTodayISO';
import type { Habit, HabitStatus } from '../types';
import { Spinner } from './Spinner';

interface HabitModalProps {
  open: boolean;
  /** The habit being edited, or `null` for create mode. */
  habit: Habit | null;
  onClose: () => void;
  onSubmit: (values: {
    name: string;
    description: string;
    startDate: string;
    status: HabitStatus;
  }) => Promise<void>;
}

const NAME_MIN = 2;
const NAME_MAX = 100;
const DESC_MAX = 500;

const STATUS_OPTIONS: HabitStatus[] = ['active', 'paused', 'archived'];

const STATUS_LABEL: Record<HabitStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  archived: 'Archived',
};

interface FieldErrors {
  name?: string;
  description?: string;
  startDate?: string;
  status?: string;
}

/**
 * Create/edit habit form (SPEC §9). Client-side validation mirrors the
 * server exactly, including the status-transition matrix:
 *   - active / paused → any of the three (allowed)
 *   - archived → only stays archived (leaving archived is forbidden)
 * Start date is shown in create mode only.
 */
export function HabitModal({ open, habit, onClose, onSubmit }: HabitModalProps) {
  const isCreate = habit === null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState(getTodayISO());
  const [status, setStatus] = useState<HabitStatus>('active');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);

  // Reset form state each time the modal opens for a (new) habit.
  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setSubmitting(false);
    if (habit) {
      setName(habit.name);
      setDescription(habit.description ?? '');
      setStartDate(habit.startDate);
      setStatus(habit.status);
    } else {
      setName('');
      setDescription('');
      setStartDate(getTodayISO());
      setStatus('active');
    }
    nameRef.current?.focus();
  }, [open, habit]);

  // Close on Escape (only when not mid-submit).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  const trimmedName = name.trim();

  // Inline field validation, recomputed on every change.
  const errors = useMemo<FieldErrors>(() => {
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
    if (!isCreate && habit) {
      if (habit.status === 'archived' && status !== 'archived') {
        e.status = 'An archived habit cannot be moved to another status.';
      }
    }
    return e;
  }, [trimmedName, description, isCreate, startDate, status, habit]);

  const hasErrors = Object.keys(errors).length > 0;

  if (!open) return null;

  const handleStatusChange = (next: HabitStatus) => {
    setStatus(next);
    // Allow selection but surface the transition error inline + as a warning.
  };

  const showArchivedWarning =
    !isCreate && habit !== null && habit.status === 'archived' && status !== 'archived';

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (hasErrors || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        name: trimmedName,
        description: description.trim(),
        startDate,
        status,
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save the habit. Try again.');
      setSubmitting(false);
    }
  };

  const title = isCreate ? 'New habit' : 'Edit habit';

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-4 animate-fade sm:items-center"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="habit-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-lift animate-sheet sm:rounded-xl">
        <div className="flex items-center justify-between">
          <h2 id="habit-modal-title" className="font-display text-xl font-semibold text-ink">
            {title}
          </h2>
          <button
            type="button"
            className="btn-ghost -mr-2 px-2 py-1 text-ink-faint hover:text-ink"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4" noValidate>
          {/* Name */}
          <div>
            <label htmlFor="habit-name" className="label">
              Name
            </label>
            <input
              ref={nameRef}
              id="habit-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`input ${errors.name ? 'input-error' : ''}`}
              placeholder="e.g. Read 20 pages"
              maxLength={NAME_MAX + 20}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? 'habit-name-error' : undefined}
            />
            {errors.name && (
              <p id="habit-name-error" className="field-error">
                {errors.name}
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label htmlFor="habit-description" className="label">
              Description <span className="font-normal text-ink-faint">(optional)</span>
            </label>
            <textarea
              id="habit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className={`input resize-none ${errors.description ? 'input-error' : ''}`}
              placeholder="Anything that helps you remember why this matters"
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={errors.description ? 'habit-description-error' : 'habit-description-count'}
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              {errors.description ? (
                <p id="habit-description-error" className="field-error">
                  {errors.description}
                </p>
              ) : (
                <span />
              )}
              <span
                id="habit-description-count"
                className={`ml-auto text-xs tabular-nums ${
                  description.length >= DESC_MAX ? 'font-medium text-danger' : 'text-ink-faint'
                }`}
              >
                {description.length}/{DESC_MAX}
              </span>
            </div>
          </div>

          {/* Start date (create only) */}
          {isCreate && (
            <div>
              <label htmlFor="habit-start" className="label">
                Start date
              </label>
              <input
                id="habit-start"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className={`input ${errors.startDate ? 'input-error' : ''}`}
                aria-invalid={errors.startDate ? true : undefined}
                aria-describedby={errors.startDate ? 'habit-start-error' : undefined}
              />
              {errors.startDate && (
                <p id="habit-start-error" className="field-error">
                  {errors.startDate}
                </p>
              )}
            </div>
          )}

          {/* Status */}
          <div>
            <label htmlFor="habit-status" className="label">
              Status
            </label>
            <select
              id="habit-status"
              value={status}
              onChange={(event) => handleStatusChange(event.target.value as HabitStatus)}
              className="input"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {STATUS_LABEL[option]}
                </option>
              ))}
            </select>
            {errors.status ? (
              <p className="field-error">{errors.status}</p>
            ) : (
              !isCreate && status === 'archived' && (
                <p className="mt-1 text-xs text-amber">
                  Archived habits can’t receive new check-ins.
                </p>
              )
            )}
          </div>

          {/* Submit-level error banner */}
          {submitError && (
            <div
              className="rounded-lg border border-danger-ring bg-danger-soft px-3 py-2 text-sm text-danger"
              role="alert"
            >
              {submitError}
            </div>
          )}

          {showArchivedWarning && !submitError && (
            <div className="rounded-lg border border-danger-ring bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
              You can’t move an archived habit back to active or paused.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary min-w-32" disabled={submitting || hasErrors}>
              {submitting && <Spinner className="h-4 w-4" />}
              {submitting ? 'Saving…' : isCreate ? 'Create habit' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
