// Gemini's counterpart to openaiRealtime.ts's mintRealtimeClientSecret — same ephemeral-token
// pattern (a short-lived token minted server-side with the real GEMINI_API_KEY, handed to the
// browser so it can open the realtime connection directly with Google, audio never passing
// through this backend) but a different wire protocol underneath: Gemini Live is a raw WebSocket
// (BidiGenerateContent), not WebRTC/SDP like OpenAI's /v1/realtime/calls — see
// SpeakingLiveTeacherPage.jsx's provider branch (geminiLiveClient.js) for the client side.
//
// Model choice, confirmed against ai.google.dev/gemini-api/docs/pricing (2026-09):
// - 'gemini-3.1-flash-live-preview': cheaper cascaded (separate ASR/LLM/TTS) live-conversation
//   model, ~$0.005/min audio in, ~$0.018/min audio out. Default here, mirroring gpt-realtime-mini's
//   role as the cost-first default in openaiRealtime.ts.
// - 'gemini-2.5-flash-native-audio-preview-12-2025': pricier single native-audio-dialog model with
//   noticeably better prosody/naturalness — Gemini's equivalent of the flagship gpt-realtime tier.
// UNLIKE the OpenAI models, neither has been live-tested yet against this app's push-to-talk flow
// (automaticActivityDetection disabled, manual activityStart/activityEnd). Google's own developer
// forum has open reports of the model never responding after activityEnd in that exact
// configuration (session dying on a 1011 keepalive timeout) — a real risk, not a hypothetical one.
// Keep this behind the same admin-only picker as the OpenAI model knob until confirmed live.
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

export const ALLOWED_GEMINI_LIVE_MODELS = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
] as const;

// Gemini's answer to openaiRealtime.ts's REALTIME_VOICE. Without this the Live API picks its own
// default, which is not necessarily female and so does not match the Cô Mai persona. Verified
// live on 2026-09-09 that voiceName is genuinely honoured here (the same sentence comes back at
// visibly different durations per voice) — despite open forum reports claiming it is ignored on
// this exact model. Female-leaning options confirmed working: Kore, Leda, Aoede, Zephyr.
// Unlike OpenAI there is NO speaking-rate control to pair with this: the API explicitly rejects
// both generationConfig.speed and speechConfig.speakingRate with "Cannot find field", which is why
// the setup screen's speed slider is labelled as ignored while Gemini is selected.
const GEMINI_LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || 'Kore';

export type GeminiLiveClientSecret = {
  value: string;
  expiresAt: number;
  model: string;
  voice: string;
};

export async function mintGeminiLiveToken(args: { model?: string; voice?: string }): Promise<GeminiLiveClientSecret> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const model =
    args.model && (ALLOWED_GEMINI_LIVE_MODELS as readonly string[]).includes(args.model)
      ? args.model
      : GEMINI_LIVE_MODEL;

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    // `uses: 1` is the entire supported payload here. A `liveConnectConstraints` field (pinning the
    // token to one model/config) is described in Google's docs but the live v1beta endpoint rejects
    // it outright — "Unknown name \"liveConnectConstraints\" at 'auth_token': Cannot find field",
    // in both camelCase and snake_case, verified against this project's key on 2026-09-09. So the
    // token is unconstrained and the model is chosen entirely by the client's WebSocket setup
    // message; the allow-list above still decides which model string the client is handed.
    //
    // expireTime/newSessionExpireTime deliberately omitted — Google's defaults (1 minute to open
    // the WebSocket, 30-minute hard cap once open) are exactly the safety net this feature wants:
    // a forgotten/leaked-open call can't run up cost indefinitely even if the client-side teardown
    // (see SpeakingLiveTeacherPage.jsx's unmount cleanup) never fires.
    body: JSON.stringify({ uses: 1 }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('mintGeminiLiveToken: Gemini request failed:', response.status, bodyText);
    const err = new Error('Failed to mint Gemini live ephemeral token') as Error & { status?: number };
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  // The ephemeral token VALUE is the auth_tokens resource's own `name` field (confirmed against
  // ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) — not a separate "token" field.
  const data = (await response.json()) as { name?: string };
  if (!data?.name) {
    const err = new Error('Gemini live ephemeral token response missing name') as Error & { status?: number };
    err.status = 502;
    throw err;
  }

  // Per-teacher now (see TEACHERS in speakingLive.ts) — the env var is only the fallback for a
  // caller that doesn't name one.
  return {
    value: data.name,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    model,
    voice: args.voice || GEMINI_LIVE_VOICE,
  };
}
