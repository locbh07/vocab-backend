# Learning Game API Contract (MVP)

Tai lieu nay mo ta contract de frontend ket noi 3 mode game: `matrix`, `falling`, `flappy`.

Base path:
- `/learning/game/*`
- `/api/learning/game/*` (alias)

## 1) Lay mode + unlock

Endpoint:
- `GET /learning/game/modes?userId=<number>`

Response:
```json
{
  "modes": [
    {
      "mode": "matrix",
      "timeLimitSec": 90,
      "lives": 3,
      "boardSize": 16,
      "defaultQuestionType": "kanji_to_vi",
      "unlockXp": 0,
      "unlocked": true
    },
    {
      "mode": "falling",
      "timeLimitSec": 60,
      "lives": 3,
      "defaultQuestionType": "kanji_to_vi",
      "unlockXp": 120,
      "unlocked": false
    }
  ]
}
```

## 2) Lay profile game + trang thai hoc

Endpoint:
- `GET /learning/game/profile?userId=<number>`

Response:
```json
{
  "xp": 210,
  "totalGames": 14,
  "currentStreak": 5,
  "longestStreak": 9,
  "lastPlayedDate": "2026-03-31T00:00:00.000Z",
  "weekly": {
    "sessions": 7,
    "avgScore": 142.3,
    "avgAccuracy": 82.4
  },
  "vocabState": {
    "new": 0,
    "learned": 320,
    "learning": 95,
    "familiar": 170,
    "mastered": 55,
    "weak": 10
  },
  "weakWords": [
    {
      "id": 123,
      "wordJa": "食べる",
      "reading": "たべる",
      "meaningVi": "an",
      "jlptLevel": "N5",
      "topic": "1000_N5_..."
    }
  ]
}
```

## 3) Lay nhom tu yeu de on lai

Endpoint:
- `GET /learning/game/weak-words?userId=<number>&limit=20`

Response:
```json
{
  "items": [
    {
      "id": 123,
      "wordJa": "食べる",
      "reading": "たべる",
      "meaningVi": "an",
      "jlptLevel": "N5",
      "topic": "1000_N5_..."
    }
  ]
}
```

## 4) Tao deck cho tran game

Endpoint:
- `POST /learning/game/deck`

Request body:
```json
{
  "userId": 1,
  "mode": "matrix",
  "difficulty": "easy",
  "questionType": "kanji_to_vi",
  "track": "core",
  "topicPrefix": "1000_N5_",
  "sourceBook": null,
  "sourceUnit": null,
  "jlptLevels": ["N5", "N4"],
  "size": 16
}
```

Gia tri hop le:
- `mode`: `matrix | falling | flappy`
- `difficulty`: `easy | normal | hard | expert`
- `questionType`: `kanji_to_vi | vi_to_kanji | kanji_to_reading | reading_to_vi`
- `track`: `core | book`
- `size`: 8..36 (tu dong chuyen ve so chan)

### 4.1 Response cho Matrix

```json
{
  "mode": "matrix",
  "difficulty": "easy",
  "questionType": "kanji_to_vi",
  "boardSize": 16,
  "weakPriorityApplied": true,
  "items": [
    {
      "id": 123,
      "word_ja": "食べる",
      "reading": "たべる",
      "meaning_vi": "an",
      "example_ja": null,
      "example_vi": null,
      "jlpt_level": "N5",
      "topic": "1000_N5_...",
      "audio_url": null
    }
  ],
  "matrix": {
    "pairCount": 8,
    "cards": [
      {
        "cardId": "123-0-L",
        "pairId": "123-0",
        "vocabId": 123,
        "side": "left",
        "text": "食べる"
      },
      {
        "cardId": "123-0-R",
        "pairId": "123-0",
        "vocabId": 123,
        "side": "right",
        "text": "an"
      }
    ]
  }
}
```

Frontend:
- Match dung cap khi `pairId` giong nhau.
- Match xong remove/fade card.

### 4.2 Response cho Falling/Flappy

```json
{
  "mode": "falling",
  "difficulty": "normal",
  "questionType": "kanji_to_vi",
  "boardSize": 20,
  "weakPriorityApplied": false,
  "items": [],
  "gameplay": {
    "speedMultiplier": 1.15,
    "lives": 3,
    "questions": [
      {
        "qid": 1,
        "vocabId": 123,
        "prompt": "食べる",
        "correct": "an",
        "options": ["an", "uong", "mua", "lam"]
      }
    ]
  }
}
```

Frontend:
- Falling: render `prompt` roi chon trong `options`.
- Flappy: map 2 lua chon dung/sai tu `options`; cua dung la option == `correct`.

## 5) Submit ket qua tran

Endpoint:
- `POST /learning/game/session/submit`

Request body:
```json
{
  "userId": 1,
  "mode": "matrix",
  "difficulty": "easy",
  "questionType": "kanji_to_vi",
  "boardSize": 16,
  "timeLimitSec": 90,
  "durationSec": 58,
  "score": 176,
  "totalQuestions": 16,
  "correctCount": 14,
  "wrongCount": 2,
  "maxCombo": 6,
  "items": [
    { "vocabId": 123, "correct": true, "responseMs": 940, "questionType": "kanji_to_vi" },
    { "vocabId": 222, "correct": false, "responseMs": 1800, "questionType": "kanji_to_vi" }
  ]
}
```

Response:
```json
{
  "sessionId": 101,
  "gainedXp": 35,
  "streak": 6,
  "weakWords": [
    {
      "id": 222,
      "wordJa": "飲む",
      "reading": "のむ",
      "meaningVi": "uong",
      "jlptLevel": "N5",
      "topic": "1000_N5_..."
    }
  ],
  "replayPack": [222, 311, 488]
}
```

Tac dung backend khi submit:
- Luu game session.
- Cap nhat SRS vao `user_vocab_progress`.
- Ghi log `user_review_log` voi mode `game:<mode>`.
- Cong XP + cap nhat streak.
- Tra ve goi on lai tu yeu.

## 6) TypeScript interfaces goi y (frontend)

```ts
export type GameMode = "matrix" | "falling" | "flappy";
export type Difficulty = "easy" | "normal" | "hard" | "expert";
export type QuestionType =
  | "kanji_to_vi"
  | "vi_to_kanji"
  | "kanji_to_reading"
  | "reading_to_vi";

export type SubmitItem = {
  vocabId: number;
  correct: boolean;
  responseMs?: number;
  questionType?: QuestionType;
};
```

## 7) FE flow de xai ngay

1. Vao tab learning game:
- Goi `GET /modes` + `GET /profile`.

2. Chon mode + config:
- Goi `POST /deck` de lay bo cau hoi.

3. Choi xong:
- Goi `POST /session/submit`.

4. Hien result:
- Lay `gainedXp`, `streak`, `weakWords`, nut `Choi lai nhom sai` (dung `replayPack`).

