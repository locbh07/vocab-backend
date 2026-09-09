// Mints a short-lived client secret so the browser can open a WebRTC session directly against
// OpenAI's Realtime API (audio streams client<->OpenAI, never through this backend) — same
// ephemeral-token shape originally scoped for Gemini Live in the speaking-practice blueprint, but
// built against OpenAI instead: this project's GEMINI_API_KEY has been out of prepayment credits
// since 2026-08-14 (still confirmed broken as of this feature), while OPENAI_API_KEY is already
// live elsewhere (exam-explanation fallback) and has Realtime model access.
// gpt-realtime-mini was the original default (cheaper, ~$0.02-0.05/min) but was confirmed live,
// across five separate prompt-engineering passes on the live-teacher persona (speakingLive.ts), to
// not reliably follow the correction script — each prompt fix just shifted which way it failed
// (looping the same repeat-drill forever, then flagging an already-correct repeat as wrong). That
// pattern points at the mini model's instruction-following/judgment capacity itself, not the
// prompt wording, so switched to the flagship model (~$0.06-0.11/min) as the next real lever.
//
// Reverted back to plain 'gpt-realtime-mini' on 2026-09-09, on an explicit cost-first call from
// the product owner after seeing real per-session cost from live testing — knowingly re-accepting
// the instruction-following risk described above rather than re-attempting another prompt fix
// (already tried five times and ruled out). 'gpt-realtime-2.1-mini' was briefly the default here
// instead (same cheapest price tier, newer reasoning, might not repeat the bug) but was rejected
// in favour of the model whose failure mode is actually KNOWN — an untested model at the same
// price buys nothing if it fails in some new unmeasured way. If the repeat-loop/false-correction
// failure resurfaces, bump this default up (or let the admin picker switch to flagship for a
// session), don't reach for another prompt-wording pass.
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini';
// Admin-only override list for the setup screen's "advanced" model picker (SpeakingLiveTeacherPage.jsx)
// — lets an admin A/B the cost/quality tradeoff live without an env var + redeploy. Confirmed real
// model ids + pricing (per million audio tokens) as of 2026-09: gpt-realtime $32/$64, gpt-realtime-mini
// $10/$20, gpt-realtime-2.1 $32/$64, gpt-realtime-2.1-mini $10/$20 (mini tier, but with GPT-5-class
// reasoning — untested here on the correction-script instruction-following bug that ruled out plain
// gpt-realtime-mini, see the comment above).
export const ALLOWED_REALTIME_MODELS = [
  'gpt-realtime',
  'gpt-realtime-mini',
  'gpt-realtime-2.1',
  'gpt-realtime-2.1-mini',
] as const;
// 'marin' is OpenAI's newer, female-leaning voice, released alongside 'cedar' (male) as their own
// recommended-for-best-quality pair — replaces the older 'alloy' default, which read Vietnamese
// with a noticeably foreign (Japanese-ish) accent since it wasn't tuned for tonal languages. Works
// with the current REALTIME_MODEL ('gpt-realtime') without needing a model upgrade. Matches the
// teacher persona (Cô Mai) being female. Not yet verified live for Vietnamese accent quality — OpenAI
// doesn't publish per-language accent comparisons, so this is the best available default, not a
// confirmed fix; listen on a real call and swap via OPENAI_REALTIME_VOICE if it's still not natural.
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin';

export type RealtimeClientSecret = {
  value: string;
  expiresAt: number;
  model: string;
};

export async function mintRealtimeClientSecret(args: {
  instructions: string;
  speed: number;
  userId: number;
  model?: string;
  voice?: string;
}): Promise<RealtimeClientSecret> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY is not configured') as Error & { status?: number };
    err.status = 500;
    throw err;
  }

  const speed = Math.min(1.5, Math.max(0.25, args.speed || 1));
  // Only an explicitly allow-listed override is honored — anything else (unset, typo, non-admin
  // tampering with the request body) silently falls back to the env-configured default rather than
  // forwarding an arbitrary string to OpenAI.
  const model =
    args.model && (ALLOWED_REALTIME_MODELS as readonly string[]).includes(args.model)
      ? args.model
      : REALTIME_MODEL;

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Lets OpenAI attribute abuse/rate-limit signals to the actual end user rather than this
      // single server-side API key — recommended for any ephemeral-token-issuing backend.
      'OpenAI-Safety-Identifier': `user-${args.userId}`,
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model,
        instructions: args.instructions,
        audio: {
          input: {
            // Server-side VAD (silence-based auto turn-taking) was tried first and confirmed live
            // to fragment a hesitant learner's sentence into several separate "turns" whenever
            // they paused mid-sentence for longer than silence_duration_ms — each fragment got its
            // own (nonsensical) AI response instead of one coherent turn. Manual mode (null) hands
            // turn-taking to the mic button instead: the client explicitly sends
            // input_audio_buffer.commit + response.create when the learner releases the mic (see
            // speakingLive.ts's frontend counterpart), so a turn ends when the learner says it
            // does, not after a fixed silence timeout.
            turn_detection: null,
            // gpt-4o-transcribe only takes a single `language` hint, forcing a real tradeoff
            // (fixed to 'ja' alone: better anchor but mis-hears genuine Vietnamese code-switching;
            // no hint: confirmed live to hallucinate fabricated sentences in random other languages
            // on unclear audio). gpt-live-transcribe — the model actually built for realtime
            // conversational use — takes a `languages` array instead, so both expected languages
            // can be hinted at once without picking one over the other. `prompt` gives free-form
            // context the transcription model can lean on for domain vocabulary; confirmed there's
            // also a `keywords` array in OpenAI's docs for literal vocabulary biasing, but it was
            // silently dropped (not even echoed back, no error) when tested live against this
            // endpoint — not actually wired up yet on their side, so left out rather than shipping
            // something confirmed non-functional.
            transcription: {
              model: 'gpt-live-transcribe',
              languages: ['ja', 'vi'],
              prompt:
                'Cuộc hội thoại luyện nói tiếng Nhật giữa giáo viên và học viên người Việt. Học viên có thể nói tiếng Nhật hoặc xen tiếng Việt.',
              // Trades a bit of latency on the DISPLAYED transcript specifically (not the AI's own
              // spoken response — confirmed live that the model's reply can already be correct
              // even when this text channel garbles what was said, since it hears the raw audio
              // directly rather than relying on this transcription) for better accuracy on that
              // text channel. Free trade: doesn't slow down the actual conversation turn-taking.
              delay: 'high',
            },
            noise_reduction: { type: 'near_field' },
          },
          output: {
            // Per-teacher now (see TEACHERS in speakingLive.ts) — the env var is only the fallback
            // for a caller that doesn't name one. All ids in that table were verified live by
            // minting a session with each on 2026-09-09.
            voice: args.voice || REALTIME_VOICE,
            speed,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    console.error('mintRealtimeClientSecret: OpenAI request failed:', response.status, bodyText);
    const err = new Error('Failed to mint OpenAI realtime client secret') as Error & { status?: number };
    err.status = response.status === 429 ? 429 : 502;
    throw err;
  }

  const data = (await response.json()) as { value?: string; expires_at?: number };
  if (!data?.value) {
    const err = new Error('OpenAI realtime client secret response missing value') as Error & { status?: number };
    err.status = 502;
    throw err;
  }

  return { value: data.value, expiresAt: data.expires_at || 0, model };
}
