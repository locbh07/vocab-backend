import path from 'path';

type KuromojiToken = {
  surface_form: string;
  reading?: string;
};

type KuromojiTokenizer = {
  tokenize: (text: string) => KuromojiToken[];
};

type KuromojiModule = {
  builder: (args: { dicPath: string }) => {
    build: (cb: (err: Error | null, tokenizer: KuromojiTokenizer) => void) => void;
  };
};

type ReadingConvertOptions = {
  surfaceReadings?: Record<string, string>;
};

let tokenizerPromise: Promise<KuromojiTokenizer> | null = null;

export async function toReadingHiragana(text: string, options?: ReadingConvertOptions): Promise<string> {
  const normalized = String(text || '');
  if (!normalized.trim()) return '';
  const tokenizer = await getTokenizer();
  const surfaceReadings = normalizeSurfaceReadings(options?.surfaceReadings);
  const lines = normalized.split('\n');
  const convertedLines = lines.map((line) => tokenizeLineToHiragana(tokenizer, line, surfaceReadings));
  return convertedLines.join('\n');
}

export async function toRubyHtml(text: string, options?: ReadingConvertOptions): Promise<string> {
  const normalized = String(text || '');
  if (!normalized.trim()) return '';
  const tokenizer = await getTokenizer();
  const surfaceReadings = normalizeSurfaceReadings(options?.surfaceReadings);
  const lines = normalized.split('\n');
  const convertedLines = lines.map((line) => tokenizeLineToRubyHtml(tokenizer, line, surfaceReadings));
  return convertedLines.join('<br/>');
}

function tokenizeLineToHiragana(
  tokenizer: KuromojiTokenizer,
  line: string,
  surfaceReadings: Record<string, string>,
) {
  if (!line) return '';
  const tokens = tokenizer.tokenize(line);
  return tokens
    .map((token) => {
      const surface = String(token.surface_form || '');
      const forced = surfaceReadings[surface];
      if (forced) return katakanaToHiragana(forced);
      const reading = String(token.reading || '');
      if (reading) return katakanaToHiragana(reading);
      return katakanaToHiragana(surface);
    })
    .join('');
}

function tokenizeLineToRubyHtml(
  tokenizer: KuromojiTokenizer,
  line: string,
  surfaceReadings: Record<string, string>,
) {
  if (!line) return '';
  const tokens = tokenizer.tokenize(line);
  return tokens
    .map((token) => {
      const surface = String(token.surface_form || '');
      const escapedSurface = escapeHtml(surface);
      const forced = surfaceReadings[surface];
      const reading = katakanaToHiragana(String(forced || token.reading || ''));
      if (!reading || !containsKanji(surface)) return escapedSurface;
      return `<ruby>${escapedSurface}<rt>${escapeHtml(reading)}</rt></ruby>`;
    })
    .join('');
}

function katakanaToHiragana(input: string) {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCharCode(code - 0x60);
    } else {
      out += input[i];
    }
  }
  return out;
}

function containsKanji(input: string) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(input);
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeSurfaceReadings(value: Record<string, string> | undefined): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [surface, reading] of Object.entries(value)) {
    const s = String(surface || '').trim();
    const r = String(reading || '').trim();
    if (!s || !r) continue;
    out[s] = r;
  }
  return out;
}

async function getTokenizer(): Promise<KuromojiTokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = buildTokenizer().catch((error) => {
      tokenizerPromise = null;
      throw error;
    });
  }
  return tokenizerPromise;
}

async function buildTokenizer(): Promise<KuromojiTokenizer> {
  const kuromojiPkgPath = require.resolve('kuromoji/package.json');
  const dicPath = path.join(path.dirname(kuromojiPkgPath), 'dict');
  const kuromoji = require('kuromoji') as KuromojiModule;

  return new Promise<KuromojiTokenizer>((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((error, tokenizer) => {
      if (error || !tokenizer) {
        reject(error || new Error('Failed to initialize kuromoji tokenizer'));
        return;
      }
      resolve(tokenizer);
    });
  });
}
