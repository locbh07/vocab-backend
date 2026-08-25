import { prisma } from './prisma';
import { dateOnly } from './http';

// Deliberately has zero dependency on routes/learning.ts (or any route file) to avoid
// a circular import -- learning.ts imports computeUnifiedStreak from here, so this
// module must not import anything back from there. Callers (GET /badges,
// GET /progress-summary, GET /learning/game/profile) are each responsible for calling
// ensureKanjiLearningTables() themselves before invoking computeUnifiedStreak, exactly
// like every other kanji-touching handler in this codebase already does.

const STREAK_WINDOW_DAYS = 120; // comfortably covers the streak_100 badge plus buffer
const FREEZES_PER_MONTH = 2;

export type StreakSummary = {
  currentStreak: number;
  longestStreak: number;
  freezesAvailable: number;
  freezesUsedThisMonth: number;
};

function formatDateKey(value: Date): string {
  const d = dateOnly(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Union of vocab-active and kanji-active days -- a day counts if EITHER track has
// activity, so alternating vocab/kanji days form one continuous streak instead of two
// separate broken ones (the bug the old Math.max(vocabStreak, kanjiStreak) had).
async function fetchCombinedDayCounts(userId: number): Promise<Record<string, number>> {
  const userBigId = BigInt(userId);
  const [vocabRows, kanjiRows] = await Promise.all([
    prisma.$queryRaw<Array<{ study_date: Date }>>`
      SELECT DATE(review_time) AS study_date
      FROM user_review_log
      WHERE user_id = ${userBigId}
        AND review_time >= NOW() - INTERVAL '1 day' * ${STREAK_WINDOW_DAYS}
      GROUP BY DATE(review_time)
    `,
    prisma.$queryRaw<Array<{ study_date: Date }>>`
      SELECT DATE(review_time) AS study_date
      FROM user_kanji_review_log
      WHERE user_id = ${userBigId}
        AND review_time >= NOW() - INTERVAL '1 day' * ${STREAK_WINDOW_DAYS}
      GROUP BY DATE(review_time)
    `,
  ]);
  const merged: Record<string, number> = {};
  for (const row of vocabRows) merged[formatDateKey(row.study_date)] = 1;
  for (const row of kanjiRows) merged[formatDateKey(row.study_date)] = 1;
  return merged;
}

// Same run-length algorithm as learning.ts's calculateLongestStreakFromKeys, kept as a
// small local copy rather than imported -- importing it would re-create the exact
// circular-import problem this module exists to avoid.
function longestRunFromDayKeys(keys: string[]): number {
  if (!keys.length) return 0;
  const sorted = [...new Set(keys)].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = new Date(sorted[i - 1]).getTime();
    const current = new Date(sorted[i]).getTime();
    if (current - prev === 24 * 60 * 60 * 1000) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

// Freeze-aware version of the walk-back loop used by calculateCurrentStreakFromDayCounts
// in learning.ts. A missing day only spends freeze budget if `streak > 0` -- i.e. there
// is already a run in progress to bridge. This is what makes "never freeze today" fall
// out naturally: on the very first iteration streak is still 0, so an empty "today"
// always just breaks the loop immediately (identical to the pre-existing, intentionally
// unchanged dashboard behavior), never spends a freeze, never inserts a row for it.
//
// A missing day only spends a freeze if activity resumes on the very next day further
// back (checked via `dayCounts`, which is never mutated during this walk -- it's the
// real-activity-plus-previously-persisted-freezes snapshot from before this walk
// started). Without that look-ahead check, freezes would greedily pad emptiness past
// the true end of the user's activity history instead of bridging an actual gap
// between two real days -- e.g. a 3-day-old real streak would otherwise burn both
// monthly freezes walking off into days with no activity at all on either side.
function walkStreakWithFreezes(
  dayCounts: Record<string, number>,
  freezeBudget: number,
  today: Date,
): { currentStreak: number; consumedFreezeDates: string[] } {
  let streak = 0;
  let remainingBudget = freezeBudget;
  let cursor = dateOnly(today);
  const consumedFreezeDates: string[] = [];

  while (true) {
    const key = formatDateKey(cursor);
    const hasActivity = Boolean(dayCounts[key] && dayCounts[key] > 0);

    if (hasActivity) {
      streak += 1;
      cursor = dateOnly(new Date(cursor.getTime() - 24 * 60 * 60 * 1000));
      continue;
    }

    const peekCursor = dateOnly(new Date(cursor.getTime() - 24 * 60 * 60 * 1000));
    const peekKey = formatDateKey(peekCursor);
    const nextDayHasActivity = Boolean(dayCounts[peekKey] && dayCounts[peekKey] > 0);

    if (streak > 0 && remainingBudget > 0 && nextDayHasActivity) {
      remainingBudget -= 1;
      consumedFreezeDates.push(key);
      streak += 1;
      cursor = peekCursor;
      continue;
    }

    break;
  }

  return { currentStreak: streak, consumedFreezeDates };
}

/**
 * The single entry point every caller funnels through. Reads combined vocab+kanji
 * activity, walks the freeze-aware current streak, and persists any newly consumed
 * freeze(s). Idempotent: a freeze already recorded in a previous call is merged into
 * the day-count map as "present" activity before the walk runs, so re-computing the
 * same walk later never re-breaks the streak and never re-charges the monthly budget
 * for a date already frozen (the createMany below is a no-op for it via skipDuplicates).
 */
export async function computeUnifiedStreak(userId: number, now: Date = new Date()): Promise<StreakSummary> {
  const windowStart = new Date(dateOnly(now).getTime() - STREAK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [dayCounts, freezeRows] = await Promise.all([
    fetchCombinedDayCounts(userId),
    prisma.userStreakFreeze.findMany({
      where: { user_id: BigInt(userId), freeze_date: { gte: windowStart } },
      select: { freeze_date: true },
    }),
  ]);

  let freezesUsedThisMonth = 0;
  for (const row of freezeRows) {
    const key = formatDateKey(row.freeze_date);
    dayCounts[key] = dayCounts[key] || 1;
    if (dateOnly(row.freeze_date).getTime() >= monthStart.getTime()) freezesUsedThisMonth += 1;
  }

  const freezeBudgetBefore = Math.max(FREEZES_PER_MONTH - freezesUsedThisMonth, 0);
  const { currentStreak, consumedFreezeDates } = walkStreakWithFreezes(dayCounts, freezeBudgetBefore, now);

  if (consumedFreezeDates.length > 0) {
    await prisma.userStreakFreeze.createMany({
      data: consumedFreezeDates.map((freezeDate) => ({
        user_id: BigInt(userId),
        freeze_date: new Date(freezeDate),
      })),
      skipDuplicates: true,
    });
    for (const key of consumedFreezeDates) dayCounts[key] = dayCounts[key] || 1;
  }

  const longestStreak = Math.max(longestRunFromDayKeys(Object.keys(dayCounts)), currentStreak);
  const freezesAvailable = Math.max(freezeBudgetBefore - consumedFreezeDates.length, 0);

  return {
    currentStreak,
    longestStreak,
    freezesAvailable,
    freezesUsedThisMonth: freezesUsedThisMonth + consumedFreezeDates.length,
  };
}
