import { fsrs, generatorParameters, createEmptyCard, State } from 'ts-fsrs';
import type { Card as FsrsCard, Grade } from 'ts-fsrs';

// Keep the target explicit so library upgrades cannot silently change the product's
// learning policy. A single 10-minute learning/relearning step avoids unnecessary
// same-session repetition; FSRS chooses every later interval from card history.
const params = generatorParameters({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: ['10m'],
  relearning_steps: ['10m'],
});
const scheduler = fsrs(params);

export type SrsRating = 1 | 2 | 3 | 4; // Rating.Again..Easy; Rating.Manual(0) is unused here

export type StoredFsrsFields = {
  stability?: number | null;
  difficulty?: number | null;
  reps?: number | null;
  lapses?: number | null;
  state?: number | null;
  learningSteps?: number | null;
  dueAt?: Date | null;
  lastReviewedAt?: Date | null;
};

// Reconstructs a ts-fsrs Card from persisted columns. `stability == null` covers both
// "row never existed" and "legacy row never graded by FSRS" -- either way we hand back
// a fresh card. elapsed_days/scheduled_days aren't persisted: ts-fsrs recomputes
// elapsed_days internally from (now - last_review) and never trusts the input's value;
// scheduled_days is a log/output field, never consumed as scheduling input.
export function toFsrsCard(stored: StoredFsrsFields, now: Date = new Date()): FsrsCard {
  if (stored.stability == null || stored.state == null) {
    return createEmptyCard(now);
  }
  return {
    due: stored.dueAt ?? now,
    stability: stored.stability,
    difficulty: stored.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: stored.learningSteps ?? 0,
    reps: stored.reps ?? 0,
    lapses: stored.lapses ?? 0,
    state: stored.state as State,
    last_review: stored.lastReviewedAt ?? undefined,
  };
}

export type GradeResult = {
  fsrs: {
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: number;
    learningSteps: number;
    dueAt: Date;
    lastReviewedAt: Date;
  };
  // Backward-compat fields, derived with the SAME ±1/clamp[0,5] formula the app has
  // always used ("correct" = rating > 1, i.e. Hard/Good/Easy all count as correct).
  // Existing dashboards / admin stats / learningGame.ts weak-word queries key off
  // stage/is_mastered/last_result and must keep seeing exactly this shape.
  legacyStage: number;
  legacyIsMastered: boolean;
  legacyResult: 0 | 1;
  lastRating: SrsRating;
};

export function gradeReview(args: {
  card: FsrsCard;
  rating: SrsRating;
  now?: Date;
  previousStage?: number; // existing?.stage ?? 0 -- feeds ONLY the legacy formula
}): GradeResult {
  const now = args.now ?? new Date();
  const { card: nextCard } = scheduler.next(args.card, now, args.rating as Grade);
  const correct = args.rating > 1;
  const legacyStage = correct
    ? Math.min((args.previousStage ?? 0) + 1, 5)
    : Math.max((args.previousStage ?? 0) - 1, 0);

  return {
    fsrs: {
      stability: nextCard.stability,
      difficulty: nextCard.difficulty,
      reps: nextCard.reps,
      lapses: nextCard.lapses, // ts-fsrs auto-increments this on Again from Review state
      state: nextCard.state,
      learningSteps: nextCard.learning_steps,
      dueAt: nextCard.due,
      lastReviewedAt: nextCard.last_review ?? now,
    },
    legacyStage,
    legacyIsMastered: legacyStage >= 5,
    legacyResult: correct ? 1 : 0,
    lastRating: args.rating,
  };
}

export type IntervalBucket = { unit: 'minute' | 'hour' | 'day' | 'month' | 'year'; value: number };

function bucketIntervalMinutes(totalMinutes: number): IntervalBucket {
  const minutes = Math.max(0, totalMinutes);
  if (minutes < 60) return { unit: 'minute', value: Math.max(1, Math.round(minutes)) };
  if (minutes < 1440) return { unit: 'hour', value: Math.round(minutes / 60) };
  const days = minutes / 1440;
  if (days < 30) return { unit: 'day', value: Math.round(days) };
  if (days < 365) return { unit: 'month', value: Math.round(days / 30) };
  return { unit: 'year', value: Math.round(days / 365) };
}

export type ReviewPreview = {
  again: IntervalBucket & { dueAt: Date };
  hard: IntervalBucket & { dueAt: Date };
  good: IntervalBucket & { dueAt: Date };
  easy: IntervalBucket & { dueAt: Date };
};

// Non-mutating "what would each of the 4 ratings do" preview, for the rating-buttons UI.
export function buildPreviewResponse(card: FsrsCard, now: Date = new Date()): ReviewPreview {
  const preview = scheduler.repeat(card, now);
  const at = (rating: SrsRating) => {
    const due = preview[rating as Grade].card.due;
    const intervalMinutes = (due.getTime() - now.getTime()) / 60000;
    return { ...bucketIntervalMinutes(intervalMinutes), dueAt: due };
  };
  return { again: at(1), hard: at(2), good: at(3), easy: at(4) };
}
