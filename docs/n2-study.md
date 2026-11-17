# N2 study catalog

`GET /exam/study/n2` (also `/api/exam/study/n2`) requires an existing authenticated
account and inherits exam API Shield, rate limiting, private/no-store and negotiated
content encryption. Query: category=vocabulary|kanji|grammar|traps, page=1,
q (max 80 characters), supplemental=1 and basic=1. Pages contain at most 30 items.

The catalog reads all current N2 exam parts and latest saved prompt-version-24
explanations; it does not generate AI content, migrate tables or modify study data.
An in-process 15-minute cache coalesces concurrent builds. Updated AI explanations
are incorporated on the next rebuild. If the active explanation prompt version
changes in exam.ts, update the two study queries alongside it.

Frequency methodology:
- A question (including its choices) and a shared passage are distinct sources.
  Repeated occurrences within that source count once; repeated passage explanations
  cannot increase the count. Exam counts use unique exam_id.
- Vocabulary candidates come from key_vocab and passage sentence glossaries.
  Dictionary forms group inflections while examples retain the exact surface and
  its reading. Every observed form plus the dictionary form is matched as a literal
  normalized substring against the written corpus. This is approximate lexical
  matching and may include compound words, not a linguistic token-frequency proof.
- Kanji count individual characters in original written sources, with ruby readings
  and initial question numbering removed. Examples use available word glossaries;
  no single-character On/Kun reading is inferred from a compound.
- Grammar frequency counts sources whose explanations mention a normalized pattern;
  different notes remain as examples. It is not the number of directly tested items.
- Trap families use transparent keyword rules and count distinct annotated sources.
  They are automatic thematic groups, not reviewed equivalence classes.
- Untranscribed audio, missing explanations and missing glossaries limit coverage.
  Counts describe this corpus, not future exam probabilities or a canonical N2 list.

Frontend: `/exam/study/N2`, linked from exam navigation. List and flashcard modes
share server-paginated ranking, search and filters. Known/again marks are stored per
account in this browser only; they do not affect the existing FSRS schedule. The
page labels readings as awaiting editorial review while the external AI work runs.

Validation: build, `node --test tests/exam-study.test.cjs`; frontend browser QA uses
synthetic responses without production writes.
