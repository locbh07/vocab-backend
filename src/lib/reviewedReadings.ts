type Segment = { surface: string; reading_hira: string };
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function reviewedFields(value: any): any[] {
  if (value?._reading_review?.version !== 1) return [];
  return (value._reading_review.fields || []).filter((field: any) => {
    if (typeof field.path !== 'string' || !field.path.startsWith('/')) return false;
    const keys = field.path.slice(1).split('/').map((k: string) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (keys.some((k: string) => ['__proto__', 'constructor', 'prototype', '_reading_review'].includes(k))) return false;
    const current = keys.reduce((v: any, k: string) => v?.[k], value);
    return current === field.source_text && Array.isArray(field.segments) && field.segments.length > 0
      && field.segments.every((s: any) => typeof s.surface === 'string' && typeof s.reading_hira === 'string' && (!s.reading_hira || /^[ぁ-ゖー]+$/.test(s.reading_hira)))
      && field.segments.map((s: Segment) => s.surface).join('') === current;
  });
}

// Applied after tokenizer hydration. Each reading belongs to this exact field,
// never to a global dictionary entry (which would lose context).
export function applyReviewedReadings<T>(input: T): T {
  const fields = reviewedFields(input);
  if (!fields.length) return input;
  const result: any = JSON.parse(JSON.stringify(input));
  result._reading_review.fields = fields;
  for (const field of fields) {
    const keys = field.path.slice(1).split('/').map((k: string) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    const leaf = keys.pop()!;
    const parent = keys.reduce((v: any, k: string) => v[k], result);
    const html = field.segments.map((s: Segment) => s.reading_hira ? `<ruby>${escape(s.surface)}<rt>${escape(s.reading_hira)}</rt></ruby>` : escape(s.surface)).join('');
    const reading = field.segments.map((s: Segment) => s.reading_hira || s.surface).join('');
    const stem = leaf.replace(/_ja$/, '');
    if (`${stem}_ruby_html` in parent) parent[`${stem}_ruby_html`] = html;
    if (`${stem}_reading_hira` in parent) parent[`${stem}_reading_hira`] = reading;
    if (['surface', 'text_ja', 'sentence_ja'].includes(leaf) && 'reading_hira' in parent) parent.reading_hira = reading;
  }
  return result;
}
