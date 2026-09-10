# Speaking: audio repair and home layout follow-up

## Audio diagnosis and repair

The backend process on port 4000 was using `.env`, which lacked the Google speech credentials present in `.env.local`. Only the missing speech credential was copied into the active development configuration; database and authentication settings were preserved. No staging or production environment files were edited.

Existing session 43 had an AI greeting without stored audio. The new authenticated `POST /speaking/ai/messages/:id/audio` endpoint recovers missing audio and returns `{ message }` using the existing message response shape. It checks session ownership and AI sender, refreshes signed URLs for existing audio, and coalesces concurrent generation requests. Invalid IDs return 400, inaccessible messages return 404, and synthesis failures return 503 and remain retryable.

The chat always offers Listen for an AI reply with text, reports autoplay/service failures, and can recover missing greeting audio. Invalid or sparse karaoke timing data falls back to plain text. Transcription distinguishes service/configuration failures from unrecognized speech. The Vietnamese translation is smaller than the Japanese reply.

## Verification

- Backend build and five audio endpoint regression tests passed.
- Frontend audio timing tests passed, including sparse arrays.
- 29 browser UI checks passed using mocked API/WebSocket responses, covering AI and Live workflows, error recovery, permissions, five responsive viewport sizes, and no browser runtime exceptions.
- Additional real-service verification used the running backend on port 4000 and real R2 storage: session 43 audio decoded and played in Chromium; MediaRecorder WebM was transcribed by Google STT into editable Japanese text; new QA session 44 played its greeting automatically and was ended afterward. Session 43 received the missing greeting audio; its conversation was not submitted or ended by the test.
- Real-service microphone input was a Japanese audio fixture through Chromium's simulated microphone. Physical microphones and Safari/iOS remain unverified. The earlier Gemini Live real-service test and its limits are recorded in `speaking-qa-2026-09-09.md`.
- The reported anonymous `reportAllChanges` stack could not be attributed to application code or reproduced in these tests.

## Home layout

The `/speaking` home now uses the same 1400px maximum container and 16px/24px horizontal gutters as Menubar. Its introduction, two practice cards, and three-step guide were refined while retaining the cream/green palette. New home copy is supplied in Vietnamese and English.

The primary practice link now appears in the first viewport at all six measured widths. The mobile introduction was reduced from approximately 516px to 411px, supporting copy is larger and darker, and the two modes explicitly identify AI. Comments use an inline footer launcher on the speaking home; opening, closing with Escape, and restoring keyboard focus were verified. Human conversation is labeled unavailable because its backend is not implemented.

Headings balance their lines and paragraphs avoid short trailing lines where supported by the browser. Chromium measurements found no single-word final lines in the sampled headings, card descriptions, and guide paragraphs at 375, 390, 768, 1024, and 1440px. The final frontend build and scoped lint checks passed after this adjustment.

Browser measurements confirmed exact left/right alignment with menu content and no horizontal overflow at widths 375, 390, 768, 1024, 1440, and 1920px. Desktop and mobile screenshots were visually reviewed. Frontend build and scoped ESLint checks passed. Screenshots and UI results are stored under the frontend's ignored `.speaking-qa/` directory.
