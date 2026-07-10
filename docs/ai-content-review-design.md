# AI Content Review Design

> Trang thai trien khai (2026-07-10): Backend (schema, migration, Gemini client, routes) va migration da apply vao DB. Man admin frontend da co tai `vocab-frontend/src/components/Admin/AdminAiReviewJobs.jsx` (tao/list job) va `AdminAiReviewJobDetail.jsx` (review/accept/reject/sua tay/apply/khoi phuc), route `/admin/ai-review`. Backend co them endpoint `GET /items/:itemId/apply-logs` (khong co trong ban thiet ke goc) de UI lay lai apply log ma khoi phuc sau khi rich trang.
>
> Model mac dinh da doi tu `gemini-1.5-flash` (bi Google ngung ho tro, 404) sang `gemini-2.5-flash`.
>
> Da phat hien: voi `exam_question`, khi Gemini de xuat dien field con trong (vi du `expl` dang null) nhung tra `has_error:false`, item bi xep vao trang thai `no_change` du van co patch huu ich - admin se khong thay duoc de xuat nay tren UI mac dinh. Chua fix, can luu y khi dung target `exam_question` de "tao moi" noi dung thay vi "sua loi".
>
> **Luu y quan trong**: tinh nang "giai thich cau hoi de thi" (question-explanation/passage-explanation, dung OpenAI, cache o bang `jlpt_question_explanation`/`jlpt_passage_explanation`) la mot he thong RIENG, phong phu hon nhieu so voi field `expl`/`explanation` trong whitelist cua ai-review. Neu can sinh hang loat "giai thich" cho de thi, dung endpoint moi `POST /exam/admin/explain-batch` (xem `src/routes/exam.ts`, ham `createExamRouter`) va script `scripts/run-exam-explain-batch.cjs`, KHONG dung ai-review pipeline cho muc dich nay.

Tai lieu nay thiet ke workflow dung Gemini de kiem tra va de xuat sua noi dung theo batch cho admin. Muc tieu la review truoc, apply sau; AI khong duoc ghi truc tiep vao bang noi dung chinh.

## Hien trang du lieu

Local database hien co:

- `vocabulary`: khoang 30,371 dong.
- `grammar`: khoang 512 dong.
- `grammar_usage`: khoang 593 dong.
- `jlpt_exam`: khoang 330 exam parts, moi part luu trong `json_data`.
- `kanji_compound`: khoang 598,425 dong, bang duoc tao dong trong `src/lib/kanjiCompounds.ts`.

Bang/model chinh:

- Tu vung: `Vocabulary`
- Ngu phap: `Grammar`, `GrammarUsage`
- De thi: `JlptExam`, `JlptExamRevision`
- Kanji compounds: bang SQL `kanji_compound`
- Kanji dictionary file: `data/kanji/kanji-en.json`

Luu y: `data/kanji/kanji-en.json` co dau hieu loi encoding/mojibake, vi du key va reading dang hien thi thanh `荳`, `縺...`. Phan nay khong nen sua bang AI tung dong ngay; can thay source dictionary dung encoding truoc hoac build lai file tu nguon sach.

## Nguyen tac chung

1. Gemini API key chi nam o backend trong env, vi du `GEMINI_API_KEY`.
2. Frontend admin chi tao job, xem ket qua, sua tay, accept/reject/apply.
3. Moi ket qua AI phai luu vao bang review tam, khong ghi truc tiep vao bang chinh.
4. Apply chi chap nhan patch theo whitelist field.
5. Moi apply phai tao audit/revision de rollback.
6. Batch job phai chay theo chunk nho de tranh timeout va kiem soat chi phi.
7. Prompt phai yeu cau JSON strict, co `patch`, `suggestions`, `confidence`.
8. Neu AI khong chac, khong sua.

## Schema review chung

Them cac model Prisma:

```prisma
model AiReviewJob {
  id           BigInt   @id @default(autoincrement())
  targetType   String   @map("target_type") @db.VarChar(40)
  status       String   @db.VarChar(30)
  provider     String   @default("gemini") @db.VarChar(40)
  model        String?  @db.VarChar(100)
  filterJson   Json?    @map("filter_json")
  promptVersion Int     @default(1) @map("prompt_version")
  total        Int      @default(0)
  processed    Int      @default(0)
  failed       Int      @default(0)
  createdBy    BigInt?  @map("created_by")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @default(now()) @map("updated_at")

  items AiReviewItem[]

  @@index([targetType, status, createdAt])
  @@map("ai_review_job")
}

model AiReviewItem {
  id             BigInt    @id @default(autoincrement())
  jobId          BigInt    @map("job_id")
  targetType     String    @map("target_type") @db.VarChar(40)
  targetKey      String    @map("target_key") @db.VarChar(200)
  status         String    @db.VarChar(30)
  originalJson   Json      @map("original_json")
  suggestedPatch Json?     @map("suggested_patch")
  suggestions    Json?
  confidence     Float?
  errorMessage   String?   @map("error_message") @db.Text
  appliedBy      BigInt?   @map("applied_by")
  appliedAt      DateTime? @map("applied_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @default(now()) @map("updated_at")

  job AiReviewJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  @@unique([jobId, targetKey])
  @@index([jobId, status])
  @@index([targetType, targetKey])
  @@map("ai_review_item")
}

model AiReviewApplyLog {
  id           BigInt   @id @default(autoincrement())
  itemId       BigInt   @map("item_id")
  targetType   String   @map("target_type") @db.VarChar(40)
  targetKey    String   @map("target_key") @db.VarChar(200)
  beforeJson   Json     @map("before_json")
  patchJson    Json     @map("patch_json")
  afterJson    Json     @map("after_json")
  appliedBy    BigInt?  @map("applied_by")
  createdAt    DateTime @default(now()) @map("created_at")

  @@index([targetType, targetKey, createdAt])
  @@map("ai_review_apply_log")
}
```

Trang thai job:

- `queued`: moi tao.
- `running`: dang goi AI.
- `completed`: xu ly xong.
- `failed`: job loi toan cuc.
- `cancelled`: admin huy.

Trang thai item:

- `pending`: chua goi AI.
- `reviewed`: co de xuat can admin xem.
- `no_change`: AI khong thay can sua.
- `failed`: item loi.
- `accepted`: admin dong y nhung chua apply.
- `rejected`: admin tu choi.
- `applied`: da ghi vao bang chinh.

## API chung

Base path:

- `/admin/ai-review/*`
- `/api/admin/ai-review/*`

Endpoint:

- `POST /jobs`: tao job.
- `GET /jobs`: danh sach job.
- `GET /jobs/:jobId`: chi tiet job va thong ke.
- `POST /jobs/:jobId/run`: chay job dong bo ngan hoac kick worker.
- `POST /jobs/:jobId/cancel`: huy job.
- `GET /jobs/:jobId/items`: danh sach item de review.
- `PUT /items/:itemId/patch`: admin sua patch bang tay.
- `POST /items/:itemId/accept`: chap nhan item.
- `POST /items/:itemId/reject`: tu choi item.
- `POST /items/:itemId/apply`: apply mot item.
- `POST /jobs/:jobId/apply`: apply nhieu item da accepted.
- `POST /apply-logs/:logId/restore`: khoi phuc tu apply log.

Request tao job:

```json
{
  "targetType": "vocabulary",
  "filter": {
    "level": "N5",
    "track": "core",
    "sourceBook": "minna1",
    "sourceUnit": "Lesson 01",
    "limit": 100
  },
  "options": {
    "fields": ["word_ja", "word_hira_kana", "word_vi", "example_ja", "example_vi"]
  }
}
```

## Prompt output chung

AI phai tra JSON duy nhat:

```json
{
  "has_error": true,
  "confidence": 0.92,
  "patch": {
    "example_ja": "..."
  },
  "suggestions": [
    {
      "field": "example_ja",
      "original": "...",
      "suggested": "...",
      "reason_vi": "Giai thich ngan bang tieng Viet.",
      "severity": "medium"
    }
  ]
}
```

Backend phai validate:

- `patch` chi duoc chua field trong whitelist cua tung target.
- Gia tri string trim va gioi han do dai theo schema hien co.
- `confidence` thap hon nguong, vi du `< 0.65`, thi luu de review nhung khong auto accept.
- Neu `has_error = false`, patch phai rong.

## 1. Vocabulary

Bang chinh: `Vocabulary`.

Du lieu mau:

- `word_ja`: `家族`
- `word_hira_kana`: `かぞく`
- `word_romaji`: `kazoku`
- `word_vi`: `gia đình`
- `example_ja`: co the co ruby HTML.
- `example_vi`: nghia tieng Viet.

Whitelist patch:

- `word_ja`
- `word_hira_kana`
- `word_romaji`
- `word_vi`
- `example_ja`
- `example_vi`
- `topic`
- `level`
- `image_url`
- `audio_url`
- `core_order`
- `track`
- `source_book`
- `source_unit`
- `isFreePreview`

Khuyen nghi phase 1 chi cho AI sua:

- `word_hira_kana`
- `word_romaji`
- `word_vi`
- `example_ja`
- `example_vi`

Khong nen de AI sua mac dinh:

- `image_url`
- `audio_url`
- `core_order`
- `track`
- `source_book`
- `source_unit`
- `isFreePreview`

Ly do: cac field nay lien quan he thong, sap xep, gating, asset path; sai se anh huong app nhieu hon loi noi dung.

Kiem tra nen lam:

- Kanji va kana co khop khong.
- Romaji co khop kana khong.
- Nghia tieng Viet co tu nhien khong.
- `example_ja` co dung tu dang hoc khong.
- Ruby HTML co hop le va reading trong `<rt>` dung theo ngu canh khong.
- `example_vi` co dung voi `example_ja` khong.

Apply:

- Cap nhat `vocabulary` bang `prisma.vocabulary.update`.
- Luu `beforeJson`, `patchJson`, `afterJson` vao `AiReviewApplyLog`.
- Sau khi sua kanji/kana, nen xoa hoac refresh cache lien quan neu co.

## 2. Grammar

Bang chinh:

- `Grammar`
- `GrammarUsage`

Grammar co 2 cap nen item review can tach:

- `grammar`: sua thong tin diem ngu phap.
- `grammar_usage`: sua formation/example.

Target keys:

- Grammar: `grammar:<grammar_id>`
- Grammar usage: `grammar_usage:<usage_id>`

Whitelist patch cho `grammar`:

- `grammar_point`
- `grammar_point_romaji`
- `level`
- `topic`
- `meaning_vi`
- `grammar_usage_text`
- `note`

Whitelist patch cho `grammar_usage`:

- `formation`
- `example_ja`
- `example_vi`

Khuyen nghi phase 1:

- Sua `meaning_vi`, `grammar_usage_text`, `note`.
- Sua `formation`, `example_ja`, `example_vi`.
- Chi flag, khong auto sua `grammar_point` va `level` tru khi admin bat tuy chon nang cao.

Kiem tra nen lam:

- `grammar_point` co dung pattern khong.
- `meaning_vi` co giai thich dung va ngan gon khong.
- `grammar_usage_text` co tu nhien cho nguoi Viet hoc JLPT khong.
- `formation` co dung cau truc khong.
- `example_ja` dung ngu phap do khong.
- `example_vi` dung voi example khong.
- Phat hien placeholder/mojibake. Route grammar hien co da co `PLACEHOLDER_PATTERNS`, nen co the dung lam pre-filter.

Apply:

- Neu target la `grammar`, update `prisma.grammar`.
- Neu target la `grammar_usage`, update `prisma.grammarUsage`.
- Luu apply log.

## 3. Kanji

Co 2 nguon khac nhau:

1. `kanji_compound`: bang SQL dung cho compound lookup.
2. `data/kanji/kanji-en.json`: dictionary file co dau hieu loi encoding.

### 3.1 Kanji compounds

Bang: `kanji_compound`.

Field:

- `kanji_char`
- `word_ja`
- `reading_kana`
- `meaning_vi`
- `meaning_en`
- `hanviet_word`
- `source`
- `source_ref`
- `priority`

Target key:

- `kanji_compound:<id>`

Whitelist patch:

- `reading_kana`
- `meaning_vi`
- `meaning_en`
- `hanviet_word`
- `priority`

Khong nen sua:

- `kanji_char`
- `word_ja`
- `source`
- `source_ref`

Kiem tra nen lam:

- `word_ja` co chua `kanji_char` khong.
- `reading_kana` co dung voi `word_ja` khong.
- `meaning_vi` co tu nhien va khong bi may moc khong.
- `hanviet_word` co dung voi tung kanji khong.
- Duplicate theo `(kanji_char, word_ja, reading_kana, source)`.

Apply:

- Update bang `kanji_compound`.
- Sau khi apply, truncate `kanji_compound_lookup_cache` de user thay du lieu moi.

### 3.2 Kanji dictionary file

File: `data/kanji/kanji-en.json`.

Khuyen nghi:

- Khong sua bang Gemini tung field trong giai doan dau.
- Tao job `kanji_dictionary_audit` chi de phat hien encoding loi va tao report.
- Sau do thay bang source dictionary sach, hoac viet script rebuild.

Ly do:

- File hien co co dau hieu mojibake tren key/readings.
- Neu AI "doan" lai toan bo kanji/readings se rat rui ro.

## 4. JLPT Exam

Bang:

- `JlptExam`: `level`, `exam_id`, `part`, `json_data`.
- `JlptExamRevision`: da co co che luu revision khi admin update part.

`json_data` co dang lon:

- `level`
- `exam_id`
- `passages`
- `sections`
- `sections[].questions[]`

Vi de thi la JSON long nhau, khong nen cho AI sua ca `json_data` mot lan. Can review theo don vi nho:

- `exam_question`: mot cau hoi.
- `exam_passage`: mot passage/doc doan van.
- `exam_section`: section title/instruction.
- `exam_listening_script`: script nghe neu nam trong `expl`/passage.

Target keys:

- Question: `exam_question:<level>:<exam_id>:<part>:<sectionIndex>:<questionIndex>`
- Passage: `exam_passage:<level>:<exam_id>:<part>:<passageId>`
- Section: `exam_section:<level>:<exam_id>:<part>:<sectionIndex>`

Patch format cho exam khong nen la field phang. Nen la JSON path patch:

```json
{
  "ops": [
    {
      "path": ["sections", 0, "questions", 2, "expl"],
      "value": "..."
    }
  ]
}
```

Whitelist path cho `exam_question`:

- `sections.*.questions.*.ques`
- `sections.*.questions.*.question_html`
- `sections.*.questions.*.options.*`
- `sections.*.questions.*.expl`
- `sections.*.questions.*.explanation`
- `sections.*.questions.*.reading_overrides`

Rang buoc quan trong:

- Khong cho AI sua `correct_answer` mac dinh.
- Khong cho AI sua `qid`, `pid`, `passage_id` mac dinh.
- Neu AI nghi dap an dung sai, chi tao suggestion severity `high`, admin phai sua tay.
- Sau khi apply exam, phai tao `JlptExamRevision` nhu route `adminExam.put` dang lam.
- Sau khi apply, phai chay lai metadata/readings cho part do:
  - `upsertExamQuestionMetaForPart`
  - `precomputeExamReadings` hoac cache invalidation cho cau lien quan.

Kiem tra nen lam:

- Cau hoi tieng Nhat co loi typo/encoding/HTML khong.
- Options co bi lap, sai numbering, sai HTML khong.
- `expl` co giai thich tieng Viet tu nhien khong.
- Passage co placeholder/mojibake khong.
- Cloze marker `(41)`, `(42)` co khop cau hoi khong.
- Listening script co that su la script, khong phai instruction.

Apply:

- Load `JlptExam`.
- Tao revision voi `json_data` cu.
- Apply JSON path patch vao clone.
- Update `jlpt_exam.json_data`.
- Recompute metadata/cache can thiet.
- Luu `AiReviewApplyLog`.

## Gemini client

Them file:

- `src/lib/gemini.ts`

Env:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`, mac dinh `gemini-2.5-flash` (gemini-1.5-flash da bi Google ngung ho tro, tra ve 404).

Client can co:

- timeout.
- retry nho cho loi 429/5xx.
- parse JSON robust.
- log provider/model/promptVersion.
- khong log API key.

## Man admin

Can 3 view:

1. Job list
   - target type, filter, status, progress, failed count, created time.

2. Create job
   - chon target: vocabulary, grammar, grammar usage, kanji compound, exam.
   - filter theo level/topic/source/limit.
   - chon field can review.

3. Review items
   - cot original.
   - cot suggested patch.
   - diff tung field/path.
   - reason tieng Viet.
   - confidence/severity.
   - nut: accept, reject, edit patch, apply, restore.

## Thu tu trien khai de giam rui ro

Phase 1:

- Them schema `AiReviewJob`, `AiReviewItem`, `AiReviewApplyLog`.
- Them Gemini client.
- Lam vocabulary review truoc vi da co admin route va patch field ro.
- UI review/apply cho vocabulary.

Phase 2:

- Them grammar + grammar usage.
- Dung placeholder patterns hien co lam pre-filter.

Phase 3:

- Them kanji compound review.
- Clear lookup cache sau apply.

Phase 4:

- Them exam question/passage review voi JSON path patch.
- Bat buoc tao revision truoc apply.

Phase 5:

- Kanji dictionary audit/rebuild, khong cho AI sua truc tiep file loi encoding.

