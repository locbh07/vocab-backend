import { getAccessToken, getGoogleProjectId } from './googleTts';

// Site language -> BCP-47 code Speech-to-Text expects, mirroring vocab-frontend's
// utils/language.js LOCALE_TAGS. Kept here (not imported) since frontend/backend don't share
// a module boundary — update both if a language's locale tag ever changes.
const LANGUAGE_CODES: Record<string, string> = {
  vi: 'vi-VN',
  en: 'en-US',
  zh: 'zh-CN',
  ko: 'ko-KR',
  pt: 'pt-BR',
  id: 'id-ID',
  ne: 'ne-NP',
  my: 'my-MM',
  fil: 'fil-PH',
};

export function speechLanguageCode(language: string): string {
  return LANGUAGE_CODES[language] || 'ja-JP';
}

type RecognizeResponse = {
  results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
};

// Learner's spoken-answer audio, recorded client-side via MediaRecorder (browser picks whatever
// container it supports — webm/opus on Chrome/Firefox/Android, mp4/aac on Safari/iOS) and sent
// here as raw bytes. Speech-to-Text v2's autoDecodingConfig inspects the file itself rather than
// requiring us to declare the exact codec, which is what makes a single endpoint work across
// browsers without per-browser encoding logic on either side. This exists specifically because
// the browser-native Web Speech API (webkitSpeechRecognition) turned out to be too unreliable on
// iOS Safari to ship (see the removed useSpeechRecognition hook in SpeakingAiChatPage.jsx) —
// server-side transcription of a plain audio recording sidesteps that entirely.
export async function transcribeSpeech(audioBuffer: Buffer, languageCode: string, timeoutMs = 20_000): Promise<string> {
  const projectId = getGoogleProjectId();
  const accessToken = await getAccessToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

  try {
    const response = await fetch(
      `https://speech.googleapis.com/v2/projects/${projectId}/locations/global/recognizers/_:recognize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
        body: JSON.stringify({
          config: {
            autoDecodingConfig: {},
            languageCodes: [languageCode],
            model: 'long',
          },
          content: audioBuffer.toString('base64'),
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Google Speech-to-Text request failed (${response.status}): ${detail}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const data = (await response.json()) as RecognizeResponse;
    const transcript = (data.results || [])
      .map((r) => r.alternatives?.[0]?.transcript || '')
      .join(' ')
      .trim();
    return transcript;
  } finally {
    clearTimeout(timeout);
  }
}
