import jwt from 'jsonwebtoken';

export type TtsOptions = {
  text: string;
  voiceName?: string;
  timeoutMs?: number;
};

export type TtsResult = {
  audio: Buffer;
  contentType: string;
};

const DEFAULT_VOICE = 'ja-JP-Neural2-B';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

type ServiceAccountCredentials = { client_email: string; private_key: string; project_id: string };

let cachedCredentials: ServiceAccountCredentials | null = null;
let cachedToken: { accessToken: string; expiresAt: number } | null = null;

function getCredentials(): ServiceAccountCredentials {
  if (cachedCredentials) return cachedCredentials;

  // Stored as base64 rather than raw JSON — a JSON blob containing a PEM private key (which
  // itself contains \n and quote characters) inside a dotenv double-quoted value doesn't
  // round-trip through dotenv's own escape handling reliably. Base64 sidesteps that entirely.
  const rawBase64 = process.env.GOOGLE_TTS_CREDENTIALS_JSON_BASE64;
  if (!rawBase64) {
    const error = new Error('GOOGLE_TTS_CREDENTIALS_JSON_BASE64 is not configured') as Error & {
      status?: number;
    };
    error.status = 503;
    throw error;
  }

  const raw = Buffer.from(rawBase64, 'base64').toString('utf8');
  const parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error('GOOGLE_TTS_CREDENTIALS_JSON is missing client_email, private_key, or project_id');
  }

  cachedCredentials = { client_email: parsed.client_email, private_key: parsed.private_key, project_id: parsed.project_id };
  return cachedCredentials;
}

// Shared with googleStt.ts (Speech-to-Text needs the project id for its v2 REST endpoint URL).
export function getGoogleProjectId(): string {
  return getCredentials().project_id;
}

// Service-account JWT-bearer flow (RFC 7523) — signs a short-lived assertion with the service
// account's private key and exchanges it for an access token, rather than pulling in the full
// @google-cloud SDK for one endpoint. Cached in memory since tokens are valid ~1h and every
// AI speaking turn would otherwise re-authenticate from scratch. Exported for googleStt.ts to
// reuse — both APIs share the same service account and 'cloud-platform' scope.
export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const { client_email, private_key } = getCredentials();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
    private_key,
    { algorithm: 'RS256' },
  );

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Google OAuth token exchange failed (${response.status}): ${detail}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type KaraokeChunk = { text: string; startTime: number };

export type TtsKaraokeResult = TtsResult & { karaoke: KaraokeChunk[] };

// Karaoke-style highlighting needs to know when each word *starts* playing. Google TTS only
// exposes this via SSML <mark> timepoints (plain-text input has no timing info at all) — a mark
// is placed before every token, and the response's `timepoints` array reports when playback
// reached each one. Google's own docs warn marks in rapid succession can silently fail to
// produce an event (short particles like は/を especially), so this must tolerate gaps rather
// than assume every token gets a timepoint back.
export async function synthesizeSpeechWithKaraoke(
  words: string[],
  options: Omit<TtsOptions, 'text'> = {},
): Promise<TtsKaraokeResult> {
  const cleanWords = words.filter((w) => w.length > 0);
  if (cleanWords.length === 0) throw new Error('synthesizeSpeechWithKaraoke: no words to synthesize');

  const voiceName = options.voiceName || process.env.GOOGLE_TTS_VOICE || DEFAULT_VOICE;
  const ssmlBody = cleanWords.map((w, i) => `<mark name="w${i}"/>${escapeSsml(w)}`).join('');
  const ssml = `<speak>${ssmlBody}</speak>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs || 20_000));

  try {
    const accessToken = await getAccessToken();
    // Timepointing (enableTimePointing) only exists on v1beta1 — v1 rejects the field outright
    // ("Unknown name enableTimePointing", confirmed by a live 400). The plain synthesizeSpeech()
    // above stays on v1 since it doesn't need this.
    const response = await fetch('https://texttospeech.googleapis.com/v1beta1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode: 'ja-JP', name: voiceName },
        audioConfig: { audioEncoding: 'MP3' },
        enableTimePointing: ['SSML_MARK'],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Google TTS (karaoke) request failed (${response.status}): ${detail}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as SynthesizeResponse & {
      timepoints?: Array<{ markName?: string; timeSeconds?: number }>;
    };
    if (!data.audioContent) throw new Error('Google TTS returned no audioContent');

    const timeByMark = new Map<string, number>();
    for (const tp of data.timepoints || []) {
      if (tp.markName && typeof tp.timeSeconds === 'number') timeByMark.set(tp.markName, tp.timeSeconds);
    }

    // Words whose own mark didn't produce a timepoint (short particles, mostly) get merged into
    // the previous chunk rather than dropped — every word must still appear somewhere in the
    // output, just possibly grouped with a neighbor instead of highlighted individually.
    const karaoke: KaraokeChunk[] = [];
    cleanWords.forEach((word, i) => {
      const startTime = timeByMark.get(`w${i}`);
      if (startTime !== undefined) {
        karaoke.push({ text: word, startTime });
      } else if (karaoke.length > 0) {
        karaoke[karaoke.length - 1].text += word;
      } else {
        karaoke.push({ text: word, startTime: 0 });
      }
    });

    return { audio: Buffer.from(data.audioContent, 'base64'), contentType: 'audio/mpeg', karaoke };
  } finally {
    clearTimeout(timeout);
  }
}

type SynthesizeResponse = { audioContent?: string };

export async function synthesizeSpeech(options: TtsOptions): Promise<TtsResult> {
  const voiceName = options.voiceName || process.env.GOOGLE_TTS_VOICE || DEFAULT_VOICE;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, options.timeoutMs || 20_000));

  try {
    const accessToken = await getAccessToken();
    const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        input: { text: options.text },
        voice: { languageCode: 'ja-JP', name: voiceName },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Google TTS request failed (${response.status}): ${detail}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as SynthesizeResponse;
    if (!data.audioContent) throw new Error('Google TTS returned no audioContent');

    return { audio: Buffer.from(data.audioContent, 'base64'), contentType: 'audio/mpeg' };
  } finally {
    clearTimeout(timeout);
  }
}
