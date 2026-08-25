export type BadgeCategory = 'streak' | 'vocab_mastery' | 'kanji_mastery' | 'volume';

export interface BadgeDef {
  key: string;
  category: BadgeCategory;
  threshold: number;
}

export const BADGE_CATALOG: BadgeDef[] = [
  { key: 'streak_3', category: 'streak', threshold: 3 },
  { key: 'streak_7', category: 'streak', threshold: 7 },
  { key: 'streak_30', category: 'streak', threshold: 30 },
  { key: 'streak_100', category: 'streak', threshold: 100 },
  { key: 'vocab_mastered_50', category: 'vocab_mastery', threshold: 50 },
  { key: 'vocab_mastered_200', category: 'vocab_mastery', threshold: 200 },
  { key: 'vocab_mastered_500', category: 'vocab_mastery', threshold: 500 },
  { key: 'kanji_mastered_50', category: 'kanji_mastery', threshold: 50 },
  { key: 'kanji_mastered_200', category: 'kanji_mastery', threshold: 200 },
  { key: 'kanji_mastered_500', category: 'kanji_mastery', threshold: 500 },
  { key: 'first_review', category: 'volume', threshold: 1 },
  { key: 'reviews_100', category: 'volume', threshold: 100 },
  { key: 'reviews_1000', category: 'volume', threshold: 1000 },
];
