import { prisma } from './prisma';

let ensureTablePromise: Promise<void> | null = null;

export async function ensureAiSpeakingTables(): Promise<void> {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS ai_speaking_topic (
          id BIGSERIAL PRIMARY KEY,
          slug VARCHAR(80) NOT NULL UNIQUE,
          title VARCHAR(200) NOT NULL,
          level VARCHAR(10) NOT NULL,
          description TEXT NULL,
          system_prompt TEXT NOT NULL,
          voice_name VARCHAR(50) NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE ai_speaking_topic ADD COLUMN IF NOT EXISTS voice_name VARCHAR(50) NULL
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS ai_speaking_session (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES useraccount(id) ON DELETE CASCADE,
          topic_id BIGINT NOT NULL REFERENCES ai_speaking_topic(id),
          provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
          model VARCHAR(100) NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ended_at TIMESTAMPTZ NULL,
          turn_count INT NOT NULL DEFAULT 0
        )
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_ai_speaking_session_user
          ON ai_speaking_session(user_id, started_at DESC)
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS ai_speaking_message (
          id BIGSERIAL PRIMARY KEY,
          session_id BIGINT NOT NULL REFERENCES ai_speaking_session(id) ON DELETE CASCADE,
          sender VARCHAR(10) NOT NULL,
          text TEXT NULL,
          correction TEXT NULL,
          audio_key TEXT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Added after the table already existed in some environments — additive, safe to run
      // every boot (see prisma_schema_partial_db_push_danger memory: hand-write, never db push).
      await prisma.$executeRawUnsafe(`
        ALTER TABLE ai_speaking_message ADD COLUMN IF NOT EXISTS audio_key TEXT NULL
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE ai_speaking_message ADD COLUMN IF NOT EXISTS karaoke JSONB NULL
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_ai_speaking_message_session
          ON ai_speaking_message(session_id, created_at ASC)
      `);
      // Cache for the "translate this AI reply into my site language" button — keyed by
      // (message_id, language) since each AI message's Japanese text never changes once
      // created, so a translation only ever needs to be generated once per language.
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS ai_speaking_message_translation (
          message_id BIGINT NOT NULL REFERENCES ai_speaking_message(id) ON DELETE CASCADE,
          language VARCHAR(8) NOT NULL,
          translation TEXT NOT NULL,
          provider VARCHAR(20) NOT NULL DEFAULT 'gemini',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (message_id, language)
        )
      `);

      await seedDefaultTopics();
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }

  await ensureTablePromise;
}

// Topic system prompts are deliberately specific per role/scene — a generic "you are a
// helpful Japanese tutor" prompt drifts into long explanations and breaks the back-and-forth
// feel a conversation practice session needs (see gemini_prompt_design_feedback memory: the
// same lesson applied to the review prompt applies here).
// Neural2/Wavenet only — Chirp3-HD voices are newer/more natural but silently return zero SSML
// mark timepoints (confirmed live: hasAudio=true, timepoints=[]), which would quietly disable
// karaoke highlighting for that topic without any error. A different voice per topic is purely
// for variety (none of these prompts specify a character gender), not a claim about "the"
// correct voice for a role.
const DEFAULT_TOPICS: Array<{
  slug: string;
  title: string;
  level: string;
  description: string;
  systemPrompt: string;
  voiceName: string;
  sortOrder: number;
}> = [
  {
    slug: 'free-talk',
    title: 'Trò chuyện tự do',
    level: 'Tự do',
    description: 'Không theo kịch bản — nói về bất kỳ chủ đề đời sống nào, AI tự điều chỉnh theo trình độ của bạn.',
    voiceName: 'ja-JP-Neural2-B',
    sortOrder: 5,
    systemPrompt:
      'Bạn là một người bạn Nhật Bản thân thiện, đang trò chuyện tự do với người học tiếng Nhật ' +
      'qua tin nhắn — không đóng vai cụ thể nào (không phải nhân viên, không phải đồng nghiệp), ' +
      'chỉ là một người bạn thật đang tán gẫu về đời sống hàng ngày: sở thích, công việc, thời ' +
      'tiết, cuối tuần, phim ảnh, đồ ăn, du lịch... Chỉ nói tiếng Nhật. Quan sát trình độ ngữ ' +
      'pháp và từ vựng người học đang dùng qua các câu họ trả lời, rồi tự điều chỉnh độ khó câu ' +
      'của bạn cho phù hợp — nếu người học dùng câu đơn giản kiểu N5, bạn cũng dùng câu đơn giản; ' +
      'nếu người học dùng câu phức tạp hơn, bạn có thể nâng nhẹ độ khó theo. Mỗi lượt trả lời tối ' +
      'đa 2 câu, và luôn cố gắng kết thúc bằng một câu hỏi hoặc gợi mở để giữ mạch hội thoại tự ' +
      'nhiên, tránh để cuộc trò chuyện đi vào ngõ cụt. Nếu người học nói sai ngữ pháp hoặc dùng từ ' +
      'sai, đừng dừng lại giảng giải — tự nhiên tiếp tục hội thoại, phần sửa lỗi sẽ nằm trong ' +
      'trường "correction" riêng, không lẫn vào lời thoại.',
  },
  {
    slug: 'restaurant-order',
    title: 'Gọi món tại nhà hàng',
    level: 'N5',
    description: 'Luyện gọi món, hỏi giá, gọi thêm đồ uống với một nhân viên phục vụ.',
    voiceName: 'ja-JP-Wavenet-C',
    sortOrder: 10,
    systemPrompt:
      'Bạn đóng vai một nhân viên phục vụ thân thiện tại một nhà hàng Nhật Bản bình dân. ' +
      'Chỉ nói tiếng Nhật, dùng từ vựng và ngữ pháp ở trình độ N5 (câu ngắn, thì đơn giản, ' +
      'kính ngữ cơ bản dạng です/ます). Mỗi lượt trả lời tối đa 2 câu. Nếu khách nói sai ngữ ' +
      'pháp hoặc dùng từ sai, đừng dừng lại giảng giải — tự nhiên tiếp tục hội thoại, phần sửa ' +
      'lỗi sẽ nằm trong trường "correction" riêng, không lẫn vào lời thoại.',
  },
  {
    slug: 'convenience-store',
    title: 'Mua đồ ở cửa hàng tiện lợi',
    level: 'N5',
    description: 'Hỏi giá, hỏi đường tới quầy, thanh toán với nhân viên thu ngân.',
    voiceName: 'ja-JP-Wavenet-A',
    sortOrder: 20,
    systemPrompt:
      'Bạn đóng vai nhân viên thu ngân tại một cửa hàng tiện lợi (konbini) ở Nhật. Chỉ nói ' +
      'tiếng Nhật, từ vựng/ngữ pháp trình độ N5, câu ngắn gọn tự nhiên như hội thoại thật. Mỗi ' +
      'lượt trả lời tối đa 2 câu. Không giảng giải ngữ pháp trong lời thoại chính.',
  },
  {
    slug: 'new-coworker',
    title: 'Làm quen với đồng nghiệp mới',
    level: 'N4',
    description: 'Giới thiệu bản thân, hỏi thăm công việc, trò chuyện xã giao ở công ty.',
    voiceName: 'ja-JP-Neural2-D',
    sortOrder: 30,
    systemPrompt:
      'Bạn đóng vai một đồng nghiệp người Nhật cùng phòng ban, đang trò chuyện xã giao với một ' +
      'nhân viên mới. Chỉ nói tiếng Nhật, trình độ ngữ pháp N4, giọng điệu thân thiện nhưng vẫn ' +
      'giữ kính ngữ です/ます vì mới quen. Mỗi lượt trả lời tối đa 3 câu, luôn kết thúc bằng một ' +
      'câu hỏi để giữ mạch hội thoại.',
  },
  {
    slug: 'job-interview',
    title: 'Phỏng vấn xin việc',
    level: 'N2',
    description: 'Luyện trả lời phỏng vấn: giới thiệu bản thân, điểm mạnh, lý do ứng tuyển.',
    voiceName: 'ja-JP-Neural2-C',
    sortOrder: 40,
    systemPrompt:
      'Bạn đóng vai nhà tuyển dụng đang phỏng vấn ứng viên cho vị trí văn phòng tại một công ty ' +
      'Nhật Bản. Chỉ nói tiếng Nhật, dùng kính ngữ chuẩn mực (敬語) và ngữ pháp trình độ N2. Đặt ' +
      'từng câu hỏi phỏng vấn một, chờ ứng viên trả lời rồi mới hỏi tiếp câu liên quan. Mỗi lượt ' +
      'tối đa 2 câu.',
  },
];

async function seedDefaultTopics(): Promise<void> {
  for (const topic of DEFAULT_TOPICS) {
    // Updates voice_name on conflict (not the rest) so topics seeded before this field existed
    // pick up their assigned voice on the next boot, without clobbering title/description/prompt
    // if those were ever hand-edited directly in the DB.
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO ai_speaking_topic (slug, title, level, description, system_prompt, voice_name, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (slug) DO UPDATE SET voice_name = EXCLUDED.voice_name
      `,
      topic.slug,
      topic.title,
      topic.level,
      topic.description,
      topic.systemPrompt,
      topic.voiceName,
      topic.sortOrder,
    );
  }
}
