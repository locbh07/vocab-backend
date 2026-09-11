function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// One policy for API enforcement and the comparison shown before payment.
export function getPremiumPolicy() {
  return {
    version: '2026-09-10',
    trialDays: positiveInteger(process.env.PREMIUM_TRIAL_DAYS, 30),
    freeExamLimitPerLevel: positiveInteger(process.env.FREE_EXAM_LIMIT_PER_LEVEL || process.env.CODE_EXAM_LIMIT_PER_LEVEL, 5),
    freeListeningLimitPerLevel: positiveInteger(process.env.LISTENING_FREE_VIDEO_LIMIT_PER_LEVEL, 15),
    youtubeImportRequiresPremium: String(process.env.LISTENING_YOUTUBE_IMPORT_REQUIRE_PREMIUM || 'true').toLowerCase() !== 'false',
    paymentMode: 'manual' as const,
    autoRenew: false,
  };
}
