import { prisma } from './prisma';
import { tokenizeJapaneseText } from './japaneseReading';

export type ListeningLevelStats = {
  totalContentTokens: number;
  matchedTokens: number;
  countsByLevel: Record<'n1' | 'n2' | 'n3' | 'n4' | 'n5', number>;
  primaryLevel: string | null;
  reason: 'ok' | 'insufficient-data';
};

export type ListeningLevelClassification = {
  levels: string[];
  stats: ListeningLevelStats;
};

// JLPT levels are cumulative (an N3 speaker also knows N4/N5 words). Almost
// any transcript contains a handful of incidental harder words (proper nouns,
// loanwords, a stray idiom), so classifying by "does the hardest level appear
// at all" pushed nearly everything to N1/N2. Instead we use a readability-style
// rule: pick the easiest level whose vocabulary covers ~90% of the words
// actually used, i.e. the level most of the content sits at, not the single
// hardest word that shows up.
const LEVEL_ORDER = ['n5', 'n4', 'n3', 'n2', 'n1'] as const;
const MIN_SAMPLE_SIZE = 12;
const COVERAGE_THRESHOLD = 0.9;
const EASIER_NEIGHBOR: Record<string, string | undefined> = { n4: 'n5', n3: 'n4', n2: 'n3', n1: 'n2', n5: undefined };

const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '感動詞']);

let vocabLevelMapPromise: Promise<Map<string, string>> | null = null;

function katakanaToHiragana(input: string) {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : input[i];
  }
  return out;
}

// Vocabulary entries use notations like "（お）弁当" (optional prefix) or
// "Uターン（する）" (optional suffix). Neither form matches tokenizer output
// directly, so we index both the "brackets removed, text kept" and the
// "bracketed segment dropped entirely" variants.
function bracketVariants(raw: string): string[] {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  const keepInner = trimmed.replace(/[（）()\[\]「」]/g, '');
  const dropBracketed = trimmed.replace(/[（(][^）)]*[）)]/g, '').replace(/[\[\]「」]/g, '');
  return Array.from(new Set([keepInner, dropBracketed].filter(Boolean)));
}

const LEVEL_RANK: Record<string, number> = { n1: 1, n2: 2, n3: 3, n4: 4, n5: 5 };

function addToMap(map: Map<string, string>, key: string, level: string) {
  if (!key) return;
  const existing = map.get(key);
  // Prefer the easier (higher-numbered) level on conflicting duplicate entries,
  // so ambiguous words don't inflate the computed difficulty.
  if (!existing || LEVEL_RANK[level] > LEVEL_RANK[existing]) {
    map.set(key, level);
  }
}

async function buildVocabLevelMap(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ word_ja: string | null; word_hira_kana: string | null; level: string | null }>>(
    `SELECT word_ja, word_hira_kana, level FROM vocabulary WHERE level IN ('N1','N2','N3','N4','N5')`,
  );

  const map = new Map<string, string>();
  for (const row of rows) {
    const level = String(row.level || '').trim().toLowerCase();
    if (!LEVEL_RANK[level]) continue;
    for (const variant of bracketVariants(String(row.word_ja || ''))) {
      addToMap(map, variant, level);
    }
    for (const variant of bracketVariants(String(row.word_hira_kana || ''))) {
      addToMap(map, variant, level);
      addToMap(map, katakanaToHiragana(variant), level);
    }
  }
  return map;
}

async function getVocabLevelMap(): Promise<Map<string, string>> {
  if (!vocabLevelMapPromise) {
    vocabLevelMapPromise = buildVocabLevelMap().catch((error) => {
      vocabLevelMapPromise = null;
      throw error;
    });
  }
  return vocabLevelMapPromise;
}

function emptyCounts(): Record<'n1' | 'n2' | 'n3' | 'n4' | 'n5', number> {
  return { n1: 0, n2: 0, n3: 0, n4: 0, n5: 0 };
}

export async function classifyListeningLevelFromTranscript(transcriptText: string): Promise<ListeningLevelClassification> {
  const levelMap = await getVocabLevelMap();
  const tokens = await tokenizeJapaneseText(transcriptText);

  const countsByLevel = emptyCounts();
  let totalContentTokens = 0;
  let matchedTokens = 0;

  for (const token of tokens) {
    const pos = String(token.pos || '');
    if (!CONTENT_POS.has(pos)) continue;
    totalContentTokens += 1;

    const surface = String(token.surface_form || '').trim();
    const basic = String(token.basic_form || '').trim();
    const reading = katakanaToHiragana(String(token.reading || ''));

    const level =
      (basic && basic !== '*' && levelMap.get(basic)) ||
      (surface && levelMap.get(surface)) ||
      (reading && levelMap.get(reading)) ||
      null;

    if (level) {
      matchedTokens += 1;
      countsByLevel[level as keyof typeof countsByLevel] += 1;
    }
  }

  if (matchedTokens < MIN_SAMPLE_SIZE) {
    return {
      levels: [],
      stats: { totalContentTokens, matchedTokens, countsByLevel, primaryLevel: null, reason: 'insufficient-data' },
    };
  }

  let primaryLevel: string = 'n1';
  let cumulative = 0;
  for (const level of LEVEL_ORDER) {
    cumulative += countsByLevel[level as keyof typeof countsByLevel];
    if (cumulative / matchedTokens >= COVERAGE_THRESHOLD) {
      primaryLevel = level;
      break;
    }
  }

  // Real speech always mixes in a stray harder word or two, so almost nothing
  // ever hits 90% purely-N5 vocabulary — even videos corodomo's own creators
  // hand-labeled "Beginner Listening" land on n4 by this measure. Mirror
  // corodomo's own section convention (their "N5" tab is literally titled
  // "N5 - N4", "N3" tab "N3 - N2", etc.) by also surfacing the video one tier
  // easier than its measured level, so the beginner tab isn't left empty.
  const easierNeighbor = EASIER_NEIGHBOR[primaryLevel];
  const levels = [primaryLevel, ...(easierNeighbor ? [easierNeighbor] : [])];

  return {
    levels,
    stats: { totalContentTokens, matchedTokens, countsByLevel, primaryLevel, reason: 'ok' },
  };
}
