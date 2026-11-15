function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// One policy for API enforcement and the comparison shown before payment.
export function getPremiumPolicy() {
  return {
    version: '2026-11-15',
    learningAccess: 'free' as const,
    trialDays: 0,
    freeExamLimitPerLevel: positiveInteger(process.env.FREE_EXAM_LIMIT_PER_LEVEL || process.env.CODE_EXAM_LIMIT_PER_LEVEL, 5),
    freeListeningLimitPerLevel: positiveInteger(process.env.LISTENING_FREE_VIDEO_LIMIT_PER_LEVEL, 15),
    youtubeImportRequiresPremium: false,
    paymentMode: 'manual' as const,
    autoRenew: false,
  };
}
