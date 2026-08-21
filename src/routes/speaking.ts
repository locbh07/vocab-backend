import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireUser } from '../middleware/userGuard';
import { ensureAiSpeakingTables, SELECTABLE_VOICES } from '../lib/speakingStore';
import { generateGeminiJson } from '../lib/gemini';
import { generateGroqJson } from '../lib/groq';
import { resolveRequestLanguage, LANGUAGE_NAMES } from '../lib/contentTranslation';
import { synthesizeSpeechWithKaraoke, type KaraokeChunk } from '../lib/googleTts';
import { speakingAudioKeyFor, putSpeakingAudio, createSpeakingAudioSignedUrl } from '../lib/speakingAudioStorage';
import { tokenizeJapaneseText } from '../lib/japaneseReading';
import { transcribeSpeech, speechLanguageCode } from '../lib/googleStt';

const MAX_HISTORY_TURNS = 12;
const DAILY_MESSAGE_LIMIT = 60;

export function createSpeakingRouter() {
  const router = Router();

  router.get('/ai/topics', async (_req: Request, res: Response) => {
    await ensureAiSpeakingTables();
    const topics = await prisma.aiSpeakingTopic.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, slug: true, title: true, level: true, description: true },
    });
    return res.json({ items: topics.map(toTopicResponse) });
  });

  router.get('/ai/sessions', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const sessions = await prisma.aiSpeakingSession.findMany({
      where: { userId: BigInt(user.id) },
      orderBy: { startedAt: 'desc' },
      take: 50,
      include: { topic: { select: { title: true, level: true, slug: true } } },
    });
    return res.json({ items: sessions.map(toSessionSummaryResponse) });
  });

  router.post('/ai/sessions', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const topicId = normalizeId(req.body?.topicId);
    if (!topicId) return res.status(400).json({ message: 'topicId không hợp lệ.' });

    const topic = await prisma.aiSpeakingTopic.findFirst({
      where: { id: BigInt(topicId), isActive: true },
    });
    if (!topic) return res.status(404).json({ message: 'Không tìm thấy chủ đề luyện nói.' });

    // Validated against a fixed whitelist rather than passed through as-is — this value flows
    // straight into the Google TTS API call as the voice name, so an unvalidated value here
    // would let a client request an arbitrary (or Chirp3-HD, which silently breaks karaoke) voice.
    const requestedVoice = req.body?.voiceName;
    const voiceName = SELECTABLE_VOICES.includes(requestedVoice) ? requestedVoice : null;

    const session = await prisma.aiSpeakingSession.create({
      data: { userId: BigInt(user.id), topicId: topic.id, voiceName },
    });

    const opening = await generateSpeakingTurn({
      systemPrompt: topic.systemPrompt,
      historyText: '',
      latestUserText: null,
      correctionLanguage: resolveRequestLanguage(req),
    });

    const [aiMessage] = await prisma.$transaction([
      prisma.aiSpeakingMessage.create({
        data: { sessionId: session.id, sender: 'AI', text: opening.reply, correction: opening.correction },
      }),
      prisma.aiSpeakingSession.update({
        where: { id: session.id },
        data: { turnCount: { increment: 1 }, provider: opening.provider, model: opening.model },
      }),
    ]);
    const { audioKey, karaoke } = await synthesizeAndStoreAudio(aiMessage.id, opening.reply, voiceName || topic.voiceName);
    if (audioKey) {
      await prisma.aiSpeakingMessage.update({
        where: { id: aiMessage.id },
        data: { audioKey, karaoke: karaoke ?? undefined },
      });
    }

    return res.status(201).json({
      session: toSessionResponse({ ...session, topic }),
      messages: [await toMessageResponse({ ...aiMessage, audioKey, karaoke })],
    });
  });

  router.get('/ai/sessions/:id', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ message: 'session id không hợp lệ.' });

    const session = await prisma.aiSpeakingSession.findFirst({
      where: { id: BigInt(id), userId: BigInt(user.id) },
      include: { topic: true },
    });
    if (!session) return res.status(404).json({ message: 'Không tìm thấy phiên luyện nói.' });

    const messages = await prisma.aiSpeakingMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({ session: toSessionResponse(session), messages: await Promise.all(messages.map(toMessageResponse)) });
  });

  router.post('/ai/sessions/:id/messages', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ message: 'session id không hợp lệ.' });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ message: 'Nội dung không được để trống.' });
    if (text.length > 500) return res.status(400).json({ message: 'Câu trả lời tối đa 500 ký tự.' });

    const session = await prisma.aiSpeakingSession.findFirst({
      where: { id: BigInt(id), userId: BigInt(user.id) },
      include: { topic: true },
    });
    if (!session) return res.status(404).json({ message: 'Không tìm thấy phiên luyện nói.' });
    if (session.endedAt) return res.status(409).json({ message: 'Phiên luyện nói này đã kết thúc.' });

    const usedToday = await countMessagesToday(user.id);
    if (usedToday >= DAILY_MESSAGE_LIMIT) {
      const error = new Error(
        'Bạn đã dùng hết lượt luyện nói AI miễn phí hôm nay. Vui lòng quay lại vào ngày mai.',
      ) as Error & { status?: number };
      error.status = 429;
      throw error;
    }

    const history = await prisma.aiSpeakingMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      take: MAX_HISTORY_TURNS * 2,
    });

    const userMessage = await prisma.aiSpeakingMessage.create({
      data: { sessionId: session.id, sender: 'USER', text },
    });

    const turn = await generateSpeakingTurn({
      systemPrompt: session.topic.systemPrompt,
      historyText: formatHistory(history),
      latestUserText: text,
      correctionLanguage: resolveRequestLanguage(req),
    });

    const [aiMessage] = await prisma.$transaction([
      prisma.aiSpeakingMessage.create({
        data: { sessionId: session.id, sender: 'AI', text: turn.reply, correction: turn.correction },
      }),
      prisma.aiSpeakingSession.update({
        where: { id: session.id },
        data: { turnCount: { increment: 1 }, provider: turn.provider, model: turn.model },
      }),
    ]);
    const { audioKey, karaoke } = await synthesizeAndStoreAudio(aiMessage.id, turn.reply, session.voiceName || session.topic.voiceName);
    if (audioKey) {
      await prisma.aiSpeakingMessage.update({
        where: { id: aiMessage.id },
        data: { audioKey, karaoke: karaoke ?? undefined },
      });
    }

    return res.status(201).json({
      messages: [
        await toMessageResponse(userMessage),
        await toMessageResponse({ ...aiMessage, audioKey, karaoke }),
      ],
    });
  });

  router.post('/ai/sessions/:id/suggest', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ message: 'session id không hợp lệ.' });

    const session = await prisma.aiSpeakingSession.findFirst({
      where: { id: BigInt(id), userId: BigInt(user.id) },
      include: { topic: true },
    });
    if (!session) return res.status(404).json({ message: 'Không tìm thấy phiên luyện nói.' });
    if (session.endedAt) return res.status(409).json({ message: 'Phiên luyện nói này đã kết thúc.' });

    const history = await prisma.aiSpeakingMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      take: MAX_HISTORY_TURNS * 2,
    });

    const result = await generateSuggestion({
      systemPrompt: session.topic.systemPrompt,
      historyText: formatHistory(history),
      correctionLanguage: resolveRequestLanguage(req),
    });

    return res.json({ suggestion: result.suggestion, meaning: result.meaning });
  });

  router.post('/ai/messages/:id/translate', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ message: 'message id không hợp lệ.' });

    const message = await prisma.aiSpeakingMessage.findFirst({
      where: { id: BigInt(id), session: { is: { userId: BigInt(user.id) } } },
    });
    if (!message || !message.text) return res.status(404).json({ message: 'Không tìm thấy tin nhắn.' });

    const language = resolveRequestLanguage(req);

    const cached = await prisma.$queryRaw<Array<{ translation: string }>>`
      SELECT translation FROM ai_speaking_message_translation
      WHERE message_id = ${BigInt(id)} AND language = ${language}
      LIMIT 1
    `;
    if (cached[0]?.translation) {
      return res.json({ translation: cached[0].translation });
    }

    const { translation, provider } = await translateSpeakingMessageText(message.text, language);

    await prisma.$executeRaw`
      INSERT INTO ai_speaking_message_translation (message_id, language, translation, provider)
      VALUES (${BigInt(id)}, ${language}, ${translation}, ${provider})
      ON CONFLICT (message_id, language) DO UPDATE SET translation = EXCLUDED.translation, provider = EXCLUDED.provider
    `;

    return res.json({ translation });
  });

  // Reverse direction of the route above: the learner doesn't know how to say something in
  // Japanese, so they speak/type it in whatever language the site is currently displayed in and
  // this turns it into Japanese *before* it becomes their conversational turn — no session/message
  // context needed, unlike the other translate route, since this text was never stored as a
  // message in the first place (only the Japanese result is).
  router.post('/ai/translate-to-japanese', async (req: Request, res: Response) => {
    await requireUser(req);
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ message: 'Nội dung không được để trống.' });
    if (text.length > 500) return res.status(400).json({ message: 'Câu quá dài.' });

    const language = resolveRequestLanguage(req);
    const japanese = await translateToJapaneseText(text, language);
    return res.json({ japanese });
  });

  // Push-to-talk recording upload: the browser records with MediaRecorder (whatever container it
  // supports — webm/opus on Chrome/Firefox/Android, mp4/aac on Safari/iOS) and posts the raw
  // bytes here (see the express.raw() middleware scoped to this exact path in app.ts, mounted
  // ahead of the app-wide express.json()). This replaces the browser-native Web Speech API
  // (webkitSpeechRecognition), which turned out too unreliable on iOS Safari — silently failing
  // to (re-)engage the mic, or ending a session having heard nothing at all with no error — to
  // ship as the only path. `?translate=1` means the learner is speaking in the site's display
  // language rather than Japanese (mirrors the /translate-to-japanese route's use case).
  router.post('/ai/transcribe', async (req: Request, res: Response) => {
    await requireUser(req);
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      return res.status(400).json({ message: 'Không có dữ liệu âm thanh.' });
    }
    // A near-instant tap (accidental, or cancelled almost immediately) produces a near-empty
    // recording — not worth an API call, and Speech-to-Text would just return nothing anyway.
    if (audio.length < 2000) {
      return res.json({ text: '' });
    }

    const translate = req.query.translate === '1' || req.query.translate === 'true';
    const languageCode = translate ? speechLanguageCode(resolveRequestLanguage(req)) : 'ja-JP';

    try {
      const text = await transcribeSpeech(audio, languageCode);
      return res.json({ text });
    } catch (cause) {
      console.error('speech transcription failed:', cause);
      const status = (cause as { status?: number })?.status;
      const friendly =
        status === 429
          ? 'Đang quá tải, vui lòng thử lại sau ít phút.'
          : 'Không nhận diện được giọng nói lúc này, vui lòng thử lại.';
      const error = new Error(friendly) as Error & { status?: number };
      error.status = status === 429 ? 429 : 502;
      throw error;
    }
  });

  router.post('/ai/sessions/:id/end', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    await ensureAiSpeakingTables();
    const id = normalizeId(req.params.id);
    if (!id) return res.status(400).json({ message: 'session id không hợp lệ.' });

    const session = await prisma.aiSpeakingSession.findFirst({
      where: { id: BigInt(id), userId: BigInt(user.id) },
    });
    if (!session) return res.status(404).json({ message: 'Không tìm thấy phiên luyện nói.' });

    const updated = await prisma.aiSpeakingSession.update({
      where: { id: session.id },
      data: { endedAt: new Date() },
    });
    return res.json({ session: toSessionResponse({ ...updated, topic: undefined as never }) });
  });

  return router;
}

async function countMessagesToday(userId: number): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM ai_speaking_message m
    JOIN ai_speaking_session s ON s.id = m.session_id
    WHERE s.user_id = ${BigInt(userId)} AND m.sender = 'USER' AND m.created_at >= ${startOfDay}
  `;
  return Number(rows[0]?.count ?? 0);
}

// TTS (+ per-word karaoke timing) is a nice-to-have layer on top of an already-working text
// reply, not a requirement for the turn to succeed — a failed TTS/tokenize call (quota, outage,
// bad key) must never block the chat message itself, so failures are swallowed here and just
// leave audioKey/karaoke null.
async function synthesizeAndStoreAudio(
  messageId: bigint,
  text: string,
  voiceName?: string | null,
): Promise<{ audioKey: string | null; karaoke: KaraokeChunk[] | null }> {
  try {
    const tokens = await tokenizeJapaneseText(text);
    const words = tokens.map((t) => t.surface_form).filter(Boolean);
    if (words.length === 0) throw new Error('no tokens to synthesize');

    const { audio, contentType, karaoke } = await synthesizeSpeechWithKaraoke(words, {
      voiceName: voiceName || undefined,
    });
    const key = speakingAudioKeyFor(messageId);
    await putSpeakingAudio(key, audio, contentType);
    return { audioKey: key, karaoke };
  } catch (cause) {
    console.error('synthesizeAndStoreAudio: TTS failed, message will have no audio:', cause);
    return { audioKey: null, karaoke: null };
  }
}

type SpeakingTurn = { reply: string; correction: string | null; provider: string; model: string };

function extractTurn(json: unknown): { reply: string; correction: string | null } {
  const parsed = json as { reply?: unknown; correction?: unknown };
  const reply = String(parsed?.reply || '').trim();
  if (!reply) throw new Error('AI không trả về lời thoại hợp lệ, vui lòng thử lại.');
  const correction =
    typeof parsed?.correction === 'string' && parsed.correction.trim() ? parsed.correction.trim() : null;
  return { reply, correction };
}

// Gemini is the app-wide default (same key every other AI feature shares — see
// gemini_api_key_credits_depleted memory for why that key alone is not reliable enough).
// Groq is a free, separately-billed account used only as an automatic fallback here, not a
// silent full replacement — if Gemini is healthy it always serves the reply.
// vi isn't in LANGUAGE_NAMES (see contentTranslation.ts — that map only covers translation
// *targets* away from the Vietnamese source content) but it's the correction language's
// default here, so it needs its own name rather than falling back to the raw code "vi".
function correctionLanguageName(language: string): string {
  if (language === 'vi') return 'Vietnamese';
  return LANGUAGE_NAMES[language] || 'Vietnamese';
}

// The point isn't "never Chinese" -- it's "must match whatever language the site is set
// to," and zh is itself a perfectly valid target. What's actually wrong is the model drifting
// into whichever CJK language it was NOT asked for, because the whole conversation context is
// Japanese: observed both as Chinese-drift (kanji/hanzi share a Unicode block, the model
// conflates them) and, separately, with target=ko, as Japanese-drift itself, where kana
// (hiragana/katakana, Japanese-exclusive among all 9 supported languages) leaks into the
// prose. Kana is never legitimate in the correction for ANY target, including zh (a Chinese
// explanation uses hanzi, not kana); CJK ideographs are only wrong when the target isn't zh.
const JAPANESE_KANA_RE = /[぀-ヿ]/g;
const CJK_IDEOGRAPH_RE = /[一-鿿㐀-䶿]/g;

function correctionLooksWrongLanguage(correction: string | null, targetLanguage: string): boolean {
  if (!correction || correction.length < 10) return false;

  const kanaRatio = (correction.match(JAPANESE_KANA_RE) || []).length / correction.length;
  if (targetLanguage === 'zh') return kanaRatio > 0.2;

  const cjkOrKanaCount =
    (correction.match(JAPANESE_KANA_RE) || []).length + (correction.match(CJK_IDEOGRAPH_RE) || []).length;
  return cjkOrKanaCount / correction.length > 0.35;
}

// Shared by both generateSpeakingTurn (the "correction" field) and generateSuggestion (the
// "meaning" field) — both are free-text explanations that must land in the site's language.
function buildLanguageGuard(correctionLangName: string, fieldName: string): string {
  return `
QUAN TRỌNG — NGÔN NGỮ GIẢI THÍCH: trường "${fieldName}" PHẢI viết hoàn toàn bằng ${correctionLangName}. TUYỆT ĐỐI KHÔNG viết bằng tiếng Trung hay tiếng Nhật, kể cả khi từ đang giải thích là chữ Hán/Kanji — chỉ được trích dẫn nguyên văn từ/câu tiếng Nhật trong dấu 「」, còn mọi câu giải thích xung quanh phải là ${correctionLangName}.
IMPORTANT — EXPLANATION LANGUAGE: the "${fieldName}" field MUST be written entirely in ${correctionLangName}, never in Chinese or Japanese — even when the word being explained is a kanji. Quote the Japanese word/phrase itself if needed, but every explanatory sentence must be in ${correctionLangName}.`;
}

// Without this, models reliably confuse whose line is being fixed/suggested: the sentence they
// produce sometimes belongs to the AI's own role instead of the learner's — e.g. correcting (or
// suggesting for) a customer's line with something only a waiter would say back to a customer.
// Observed directly in production output, not theoretical. Shared by generateSpeakingTurn
// (correcting what was said) and generateSuggestion (proposing what to say next) — same failure
// mode either way.
const ROLE_GUARD = `
QUAN TRỌNG — GIỮ ĐÚNG VAI: câu tiếng Nhật ví dụ PHẢI là câu mà NGƯỜI HỌC sẽ nói trong vai của họ (vai đối diện với vai bạn đang đóng) — TUYỆT ĐỐI KHÔNG được đưa ra một câu thuộc về vai của chính bạn (AI). Ví dụ: nếu bạn đóng vai nhân viên phục vụ và người học đóng vai khách, câu đó phải là điều một người khách sẽ nói với nhân viên — không phải điều nhân viên sẽ nói với khách.
IMPORTANT — KEEP THE LEARNER'S ROLE: the example Japanese sentence MUST be something the LEARNER would say in their own role (the role opposite yours) — NEVER something that belongs to your own (the AI's) role. Example: if you play a waiter and the learner plays the customer, it must be something a customer would say to the waiter — not something the waiter would say to the customer.`;

async function generateSpeakingTurn(args: {
  systemPrompt: string;
  historyText: string;
  latestUserText: string | null;
  correctionLanguage: string;
}): Promise<SpeakingTurn> {
  const correctionLangName = correctionLanguageName(args.correctionLanguage);
  const jsonFormatSpec = (langName: string) =>
    `Luôn trả lời bằng JSON đúng định dạng sau, không thêm chữ nào khác ngoài JSON:
{"reply": "câu thoại tiếp theo trong vai diễn, chỉ tiếng Nhật", "correction": "nếu câu tiếng Nhật gần nhất của người học có lỗi ngữ pháp/từ vựng rõ ràng, giải thích ngắn gọn bằng ${langName} (không phải tiếng Nhật, không phải tiếng Trung); nếu không có lỗi đáng kể thì để null"}`;

  const languageGuard = buildLanguageGuard(correctionLangName, 'correction');
  const roleGuard = ROLE_GUARD;

  const instruction = `${args.systemPrompt}
${languageGuard}
${roleGuard}

${jsonFormatSpec(correctionLangName)}`;

  const strictInstruction = `${args.systemPrompt}
${languageGuard}
${roleGuard}
LẦN TRƯỚC BẠN ĐÃ SAI: correction bị viết bằng tiếng Trung hoặc tiếng Nhật thay vì ${correctionLangName}. Lần này bắt buộc viết lại hoàn toàn bằng ${correctionLangName}.

${jsonFormatSpec(correctionLangName)}`;

  const prompt = args.latestUserText
    ? `Lịch sử hội thoại:\n${args.historyText}\n\nNgười học vừa nói: "${args.latestUserText}"\n\nHãy tiếp tục hội thoại theo vai diễn.`
    : 'Đây là lượt mở đầu hội thoại, người học chưa nói gì. Hãy mở lời tự nhiên theo vai diễn. Trường correction phải là null.';

  // Each attempt gets the strict (already-failed-once) instruction from the second try onward.
  // Attempts run in order and stop at the first one that passes the language check; if none do,
  // the last attempt's result is returned anyway — a wrong-language correction is still better
  // than no correction, matching the rest of this function's "degrade, don't block" approach.
  async function withLanguageGuard(
    attempts: Array<(systemInstruction: string) => Promise<{ json: unknown; model: string }>>,
  ): Promise<{ reply: string; correction: string | null; model: string }> {
    let last: { reply: string; correction: string | null; model: string } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const result = await attempts[i](i === 0 ? instruction : strictInstruction);
      const turn = extractTurn(result.json);
      last = { ...turn, model: result.model };
      if (!correctionLooksWrongLanguage(turn.correction, args.correctionLanguage)) return last;
      console.warn(
        `generateSpeakingTurn: attempt ${i + 1}/${attempts.length} looked like the wrong language (wanted ${correctionLangName}, model ${result.model})`,
      );
    }
    return last!;
  }

  try {
    const turn = await withLanguageGuard([
      (systemInstruction) => generateGeminiJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
      (systemInstruction) => generateGeminiJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
    ]);
    return { ...turn, provider: 'gemini' };
  } catch (geminiCause) {
    console.error('generateSpeakingTurn: Gemini call failed, falling back to Groq:', geminiCause);
  }

  try {
    // Groq gets a 3rd, slower escalation step: gpt-oss-120b is fast but has an observed,
    // reproducible weakness on some non-major languages (confirmed: Korean specifically comes
    // back Japanese even after a stricter-instruction retry). qwen/qwen3.6-27b is markedly
    // better at Asian-language adherence in practice but ~3-4x slower and far more tokens
    // (it's a reasoning model — response_format:json_object suppresses the <think> block from
    // the output, confirmed by direct testing, but the reasoning still costs time/tokens) — not
    // worth paying by default, only as a last resort when the fast model twice gets it wrong.
    const turn = await withLanguageGuard([
      (systemInstruction) => generateGroqJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
      (systemInstruction) => generateGroqJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
      (systemInstruction) =>
        generateGroqJson({ systemInstruction, prompt, model: 'qwen/qwen3.6-27b', temperature: 0.4, timeoutMs: 45_000 }),
    ]);
    return { ...turn, provider: 'groq' };
  } catch (groqCause) {
    // Both providers failed — this is the only case the client actually sees an error for.
    // The raw provider error bodies (quota JSON, endpoint detail) are useful in server logs
    // but must never reach the client verbatim — internal detail, not actionable for a learner.
    console.error('generateSpeakingTurn: Groq fallback also failed:', groqCause);
    const status = (groqCause as { status?: number })?.status;
    const friendly =
      status === 429
        ? 'AI luyện nói đang tạm hết lượt dùng do quá tải, vui lòng thử lại sau ít phút.'
        : 'Không thể kết nối tới AI luyện nói lúc này, vui lòng thử lại.';
    const error = new Error(friendly) as Error & { status?: number };
    error.status = status === 429 ? 429 : 502;
    throw error;
  }
}

type SuggestionResult = { suggestion: string; meaning: string; provider: string; model: string };

function extractSuggestion(json: unknown): { suggestion: string; meaning: string } {
  const parsed = json as { suggestion?: unknown; meaning?: unknown };
  const suggestion = String(parsed?.suggestion || '').trim();
  const meaning = String(parsed?.meaning || '').trim();
  if (!suggestion) throw new Error('AI không đưa ra được gợi ý, vui lòng thử lại.');
  return { suggestion, meaning };
}

// "What should I say next?" — a stateless helper, not a real conversation turn: not persisted,
// not counted into history sent to future prompts (see the /suggest route). Reuses the same
// language/role guard text as corrections because it's the exact same failure mode: the model
// producing a sentence in the wrong language, or from the AI's own role instead of the
// learner's, when asked to generate a line "for" the learner.
async function generateSuggestion(args: {
  systemPrompt: string;
  historyText: string;
  correctionLanguage: string;
}): Promise<SuggestionResult> {
  const correctionLangName = correctionLanguageName(args.correctionLanguage);
  const languageGuard = buildLanguageGuard(correctionLangName, 'meaning');

  const jsonFormatSpec = `Luôn trả lời bằng JSON đúng định dạng sau, không thêm chữ nào khác ngoài JSON:
{"suggestion": "một câu tiếng Nhật tự nhiên, đúng trình độ, mà người học có thể nói tiếp theo trong vai của họ", "meaning": "nghĩa ngắn gọn của câu đó bằng ${correctionLangName}"}`;

  const instruction = `${args.systemPrompt}
${languageGuard}
${ROLE_GUARD}
Người học đang không biết nói gì tiếp theo và cần một gợi ý.

${jsonFormatSpec}`;

  const strictInstruction = `${instruction}
LẦN TRƯỚC BẠN ĐÃ SAI: "meaning" bị viết bằng tiếng Trung hoặc tiếng Nhật thay vì ${correctionLangName}. Lần này bắt buộc viết lại hoàn toàn bằng ${correctionLangName}.`;

  const prompt = `Lịch sử hội thoại:\n${args.historyText}\n\nGợi ý một câu tiếng Nhật tự nhiên mà người học có thể nói tiếp theo.`;

  async function withLanguageGuard(
    attempts: Array<(systemInstruction: string) => Promise<{ json: unknown; model: string }>>,
  ): Promise<{ suggestion: string; meaning: string; model: string }> {
    let last: { suggestion: string; meaning: string; model: string } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const result = await attempts[i](i === 0 ? instruction : strictInstruction);
      const parsed = extractSuggestion(result.json);
      last = { ...parsed, model: result.model };
      if (!correctionLooksWrongLanguage(parsed.meaning, args.correctionLanguage)) return last;
      console.warn(
        `generateSuggestion: attempt ${i + 1}/${attempts.length} looked like the wrong language (wanted ${correctionLangName}, model ${result.model})`,
      );
    }
    return last!;
  }

  try {
    const result = await withLanguageGuard([
      (systemInstruction) => generateGeminiJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
      (systemInstruction) => generateGeminiJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
    ]);
    return { ...result, provider: 'gemini' };
  } catch (geminiCause) {
    console.error('generateSuggestion: Gemini call failed, falling back to Groq:', geminiCause);
  }

  try {
    const result = await withLanguageGuard([
      (systemInstruction) => generateGroqJson({ systemInstruction, prompt, temperature: 0.6, timeoutMs: 30_000 }),
      (systemInstruction) =>
        generateGroqJson({ systemInstruction, prompt, model: 'qwen/qwen3.6-27b', temperature: 0.4, timeoutMs: 45_000 }),
    ]);
    return { ...result, provider: 'groq' };
  } catch (groqCause) {
    console.error('generateSuggestion: Groq fallback also failed:', groqCause);
    const status = (groqCause as { status?: number })?.status;
    const friendly =
      status === 429
        ? 'AI đang tạm hết lượt dùng do quá tải, vui lòng thử lại sau ít phút.'
        : 'Không thể lấy gợi ý lúc này, vui lòng thử lại.';
    const error = new Error(friendly) as Error & { status?: number };
    error.status = status === 429 ? 429 : 502;
    throw error;
  }
}

// LANGUAGE_NAMES only covers translation *targets* away from Vietnamese source content (see
// correctionLanguageName above) — here the source is always Japanese and the target can
// legitimately be Vietnamese itself, so it needs its own entry.
const SPEAKING_TRANSLATION_LANGUAGE_NAMES: Record<string, string> = { vi: 'Vietnamese', ...LANGUAGE_NAMES };

function extractTranslation(json: unknown): string {
  const parsed = json as { translation?: unknown };
  const translation = String(parsed?.translation || '').trim();
  if (!translation) throw new Error('AI không dịch được câu này, vui lòng thử lại.');
  return translation;
}

// "Dịch nghĩa" button next to the listen button on an AI reply — translates that one Japanese
// line into whatever language the site is currently displayed in. Same Gemini-then-Groq
// fallback shape as the rest of this file, but simpler: no role/language-drift guard needed
// since there's no example-sentence generation involved, just a direct translation.
async function translateSpeakingMessageText(
  japaneseText: string,
  language: string,
): Promise<{ translation: string; provider: string }> {
  const languageName = SPEAKING_TRANSLATION_LANGUAGE_NAMES[language] || 'Vietnamese';
  const systemInstruction =
    `Bạn dịch một câu tiếng Nhật ngắn trong một cuộc hội thoại luyện nói sang ${languageName}. ` +
    'Dịch tự nhiên, sát nghĩa, không thêm giải thích ngữ pháp hay chú thích. ' +
    'Luôn trả lời bằng JSON đúng định dạng sau, không thêm chữ nào khác ngoài JSON: {"translation": "..."}';
  const prompt = `Dịch câu tiếng Nhật sau sang ${languageName}:\n"${japaneseText}"`;

  try {
    const result = await generateGeminiJson({ systemInstruction, prompt, temperature: 0.3, timeoutMs: 20_000 });
    return { translation: extractTranslation(result.json), provider: 'gemini' };
  } catch (geminiCause) {
    console.error('translateSpeakingMessageText: Gemini call failed, falling back to Groq:', geminiCause);
  }

  try {
    const result = await generateGroqJson({ systemInstruction, prompt, temperature: 0.3, timeoutMs: 20_000 });
    return { translation: extractTranslation(result.json), provider: 'groq' };
  } catch (groqCause) {
    console.error('translateSpeakingMessageText: Groq fallback also failed:', groqCause);
    const status = (groqCause as { status?: number })?.status;
    const friendly =
      status === 429
        ? 'AI đang tạm hết lượt dùng do quá tải, vui lòng thử lại sau ít phút.'
        : 'Không thể dịch câu này lúc này, vui lòng thử lại.';
    const error = new Error(friendly) as Error & { status?: number };
    error.status = status === 429 ? 429 : 502;
    throw error;
  }
}

function extractJapanese(json: unknown): string {
  const parsed = json as { japanese?: unknown };
  const japanese = String(parsed?.japanese || '').trim();
  if (!japanese) throw new Error('AI không dịch được câu này, vui lòng thử lại.');
  return japanese;
}

// Reverse of translateSpeakingMessageText above: the learner writes/speaks in whatever language
// the site is currently displayed in because they don't know how to say it in Japanese yet, and
// this turns that into a natural Japanese line before it's sent as their conversational turn.
// Same Gemini-then-Groq fallback shape as the rest of this file.
async function translateToJapaneseText(text: string, fromLanguage: string): Promise<string> {
  const languageName = SPEAKING_TRANSLATION_LANGUAGE_NAMES[fromLanguage] || 'Vietnamese';
  const systemInstruction =
    `Bạn dịch một câu ngắn từ ${languageName} sang tiếng Nhật tự nhiên, phù hợp với hội thoại đời ` +
    'thường (không phải văn viết trang trọng, trừ khi câu gốc rõ ràng mang tính trang trọng). ' +
    'Không thêm giải thích hay phiên âm. Luôn trả lời bằng JSON đúng định dạng sau, không thêm ' +
    'chữ nào khác ngoài JSON: {"japanese": "..."}';
  const prompt = `Dịch câu sau từ ${languageName} sang tiếng Nhật:\n"${text}"`;

  try {
    const result = await generateGeminiJson({ systemInstruction, prompt, temperature: 0.3, timeoutMs: 20_000 });
    return extractJapanese(result.json);
  } catch (geminiCause) {
    console.error('translateToJapaneseText: Gemini call failed, falling back to Groq:', geminiCause);
  }

  try {
    const result = await generateGroqJson({ systemInstruction, prompt, temperature: 0.3, timeoutMs: 20_000 });
    return extractJapanese(result.json);
  } catch (groqCause) {
    console.error('translateToJapaneseText: Groq fallback also failed:', groqCause);
    const status = (groqCause as { status?: number })?.status;
    const friendly =
      status === 429
        ? 'AI đang tạm hết lượt dùng do quá tải, vui lòng thử lại sau ít phút.'
        : 'Không thể dịch câu này lúc này, vui lòng thử lại.';
    const error = new Error(friendly) as Error & { status?: number };
    error.status = status === 429 ? 429 : 502;
    throw error;
  }
}

function formatHistory(messages: Array<{ sender: string; text: string | null }>): string {
  return messages
    .map((m) => `${m.sender === 'AI' ? 'AI' : 'Người học'}: ${m.text || ''}`)
    .join('\n');
}

function normalizeId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function toTopicResponse(t: { id: bigint; slug: string; title: string; level: string; description: string | null }) {
  return { id: Number(t.id), slug: t.slug, title: t.title, level: t.level, description: t.description };
}

function toSessionResponse(s: {
  id: bigint;
  topicId: bigint;
  startedAt: Date;
  endedAt: Date | null;
  turnCount: number;
  topic?: { title: string; level: string; slug: string } | undefined;
}) {
  return {
    id: Number(s.id),
    topicId: Number(s.topicId),
    topic: s.topic ? { title: s.topic.title, level: s.topic.level, slug: s.topic.slug } : null,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    turnCount: s.turnCount,
  };
}

function toSessionSummaryResponse(s: {
  id: bigint;
  startedAt: Date;
  endedAt: Date | null;
  turnCount: number;
  topic: { title: string; level: string; slug: string };
}) {
  return {
    id: Number(s.id),
    topic: s.topic,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    turnCount: s.turnCount,
  };
}

async function toMessageResponse(m: {
  id: bigint;
  sender: string;
  text: string | null;
  correction: string | null;
  audioKey?: string | null;
  karaoke?: unknown;
  createdAt: Date;
}) {
  return {
    id: Number(m.id),
    sender: m.sender,
    text: m.text,
    correction: m.correction,
    audioUrl: m.audioKey ? await createSpeakingAudioSignedUrl(m.audioKey).catch(() => null) : null,
    karaoke: Array.isArray(m.karaoke) ? m.karaoke : null,
    createdAt: m.createdAt,
  };
}
