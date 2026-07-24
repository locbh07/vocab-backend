type AnyRecord = Record<string, any>;

export type MaskRule<T extends AnyRecord = AnyRecord> = {
  keepFields: readonly (keyof T | string)[];
  maskFields?: readonly (keyof T | string)[];
  marker?: string;
};

const DEFAULT_MARKER = 'PREMIUM_REQUIRED';

export function isFreePreviewItem(item: AnyRecord): boolean {
  return Boolean(item?.isFreePreview ?? item?.is_free_preview);
}

export function maskPremiumItem<T extends AnyRecord>(
  item: T,
  isPremium: boolean,
  rule: MaskRule<T>,
): T & { isLocked: boolean; lockReason?: string } {
  if (isPremium || isFreePreviewItem(item)) {
    return {
      ...item,
      isLocked: false,
    };
  }

  const out: AnyRecord = {};
  for (const field of rule.keepFields) {
    const key = String(field);
    if (key in item) out[key] = item[key];
  }

  for (const field of rule.maskFields || []) {
    out[String(field)] = null;
  }

  out.isFreePreview = false;
  out.is_free_preview = false;
  out.isLocked = true;
  out.lockReason = rule.marker || DEFAULT_MARKER;
  return out as T & { isLocked: boolean; lockReason?: string };
}

export function maskPremiumList<T extends AnyRecord>(
  items: T[],
  isPremium: boolean,
  rule: MaskRule<T>,
): Array<T & { isLocked: boolean; lockReason?: string }> {
  return items.map((item) => maskPremiumItem(item, isPremium, rule));
}

export const vocabularyMaskRule: MaskRule = {
  keepFields: [
    'id',
    'word_ja',
    'word_hira_kana',
    'word_romaji',
    'topic',
    'level',
    'track',
    'source_book',
    'source_unit',
    'core_order',
    'isFreePreview',
    'is_free_preview',
  ],
  maskFields: ['word_vi', 'example_ja', 'example_vi', 'image_url', 'audio_url', 'examples'],
};

export const grammarMaskRule: MaskRule = {
  keepFields: [
    'grammar_id',
    'grammar_point',
    'grammar_point_romaji',
    'level',
    'source_book',
    'source_unit',
    'track',
    'priority',
    'topic',
    'isFreePreview',
    'is_free_preview',
  ],
  maskFields: ['meaning_vi', 'grammar_usage', 'grammar_usage_text', 'note', 'usages'],
};

export const listeningVideoMaskRule: MaskRule = {
  keepFields: [
    'id',
    'source_id',
    'videoId',
    'video_id',
    'title',
    'durationSec',
    'duration_sec',
    'thumbnail',
    'levels',
    'normalized_levels',
    'tags',
    'categoryLabel',
    'category_label',
    'createdRelative',
    'created_relative',
    'views',
    'isFreePreview',
    'is_free_preview',
    'isFavorited',
    'isMine',
  ],
  maskFields: ['videoUrl', 'video_url', 'embedUrl', 'embed_url'],
};
