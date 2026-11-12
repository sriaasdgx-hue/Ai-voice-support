# Assistant client contract

Base prefix: `/api/v1/assistant`. HTTPS is required outside localhost. Send `Authorization: Bearer <Supabase access token>` on every API request. Private test mode accepts `TEST_API_KEY` instead; do not ship that shared key in the Android app.

## Endpoints

| Method | Path after base prefix | Result |
| --- | --- | --- |
| GET | `/capabilities` | Model names/health, available languages, audio format and limits |
| POST | `/conversations` | Create conversation; body is settings object |
| GET | `/conversations` | Latest 50 conversations belonging to the authenticated user |
| GET | `/conversations/:id/messages?before=SEQ` | Latest 100 messages, oldest first; use `nextBefore` for older pages |
| POST | `/conversations/:id/messages` | Submit text and stream SSE, or return JSON |
| POST | `/conversations/:id/voice-session` | Obtain a single-use, 30-second WebSocket ticket |
| DELETE | `/conversations/:id` | Delete one owned conversation; 204 |
| DELETE | `/history` | Delete all history owned by the current user; 204 |

`GET /healthz` is public process liveness; it is not a GPU readiness probe. `/` serves the test console. `/internal/model-worker` is reserved for the separately authenticated model connector.

## Settings

```json
{
  "replyLanguage": "tamil",
  "recognitionLanguage": "ta-IN",
  "deliveryMode": "auto"
}
```

Defaults: both languages `auto`, delivery `auto`. Delivery also accepts `neutral`. Reply language uses keys such as `tamil`, `hindi` and `english`; recognition uses locales such as `ta-IN`, `hi-IN` and `en-US`. Populate controls from `/capabilities`, including experimental/generic-voice labels. Settings used by a new turn are saved to its conversation. A duplicate client message ID replays the original stored result and does not update its settings.

## Text request

```http
POST /api/v1/assistant/conversations/CONVERSATION_UUID/messages
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
```

```json
{
  "text": "நீங்கள் எப்படி இருக்கிறீர்கள்?",
  "clientMessageId": "a4eb4064-8524-4c85-9bb6-40ef0f42e731",
  "stream": true,
  "settings": {"replyLanguage":"tamil","recognitionLanguage":"ta-IN","deliveryMode":"neutral"}
}
```

Generate a UUID for each user turn. Retry the **same ID and same text** to retrieve its stored reply without duplicate generation. A changed text with an existing ID returns 409. To ask again after a failed/interrupted reply, use a new ID. The text limit is 2,000 characters. The optional settings object is a complete override with defaults for omitted fields.

`stream:true` (default) returns `text/event-stream` **on this POST request**, with JSON in each `data:` event. Use a streaming HTTP client, not an EventSource URL. Parse UTF-8 incrementally and handle event boundaries split across network chunks. Ignore comment heartbeats. Close/cancel the HTTP request to interrupt generation. `stream:false` returns `{ "message": ... }` only after completion; clients still need to tolerate a long response.

## Voice connection

1. POST `/conversations/:id/voice-session` with `{ "settings": ... }`, or `{}` to reuse settings.
2. Receive `{ "ticket": "...", "path": "/api/v1/assistant/voice", "expiresInSeconds": 30 }`.
3. Open `wss://YOUR-BACKEND/api/v1/assistant/voice?ticket=...` immediately. Do not log this URL. The ticket is consumed once, including failed capacity checks. Fetch a new ticket for each reconnect.
4. Wait for `session.started` before sending audio. Its fields confirm input/output formats and session limit.
5. Send **binary PCM16 little-endian, mono, 24,000 Hz** frames. The browser example uses 80 ms / 3,840-byte frames. Maximum frame size is 48,000 bytes. Do not send WAV headers, AAC, Opus or base64 in client binary frames.
6. Decode `response.audio.delta.audio` from base64 into mono PCM16 at the event's sample rate (22,050 Hz), and enqueue for playback.
7. On `playback.clear` or cancellation, immediately stop queued playback and drop subsequent chunks for that cancelled response ID. Keep microphone input running to support interruption.
8. Send `{ "type": "session.end" }` and stop microphone capture when leaving voice mode. A server restart or network loss closes the session; reconnect with a new ticket and reload history.

Accepted JSON controls: `response.cancel`, `session.end`, and `ping`. Recognition starts automatically after socket authentication. **There is no client `session.start` or `audio.commit` operation.** Continue sending silence frames while listening so Bodhan's VAD can finalize speech; committing the current Bodhan upstream stream would close its session.

## Events

Events include a monotonically increasing `seq` within the HTTP stream or voice session. Reply events carry a stable `responseId` where applicable.

| Event | Relevant fields / client action |
| --- | --- |
| `session.started` | `sessionId`, `conversationId`, `input`, `output`, `settings`, `maxSeconds` |
| `transcript.delta` | `delta`: interim recognition text |
| `transcript.done` | `text`, `detectedLanguage`: finalized user turn |
| `response.started` | `responseId`, `userMessage`: display the saved user message and pending reply |
| `response.language` | `language`, `detectedLanguage`, `delivery` |
| `response.text.delta` | `delta`: append to this response's text |
| `response.audio.delta` | `audio`: base64 PCM16, `sampleRate` |
| `response.done` | `message`, `finishReason`, `metrics`: reconcile display with saved final text |
| `response.replayed` | `message`: existing stored result for the idempotent text request; no audio replay |
| `playback.clear` | Flush queued audio and mark the active response cancelled |
| `response.cancelled` | `responseId`, `error`: partial text saved as interrupted |
| `response.error` | `responseId`, `error`: generation failed; partial text may be saved |
| `session.error` | `error`: show reason and end/reconnect voice session |
| `session.ended` | `reason`: stop recording and playback |
| `error` | `error`: stream-level failure |
| `pong` | Application heartbeat acknowledgement |

Each error is `{ "code": "...", "message": "..." }`. Before a stream starts, HTTP errors use `{ "error": ... }` and an appropriate 400/401/404/409/413/422/429/502/503/504 status. After headers are sent, handle event errors even when the HTTP status is 200. A missing terminal event indicates a disconnected/incomplete response; reload saved history.

Messages include `id`, `seq`, `role`, `content`, `mode`, `status`, `language`, timestamps and `conversation_id`. Status is `pending`, `completed`, `interrupted`, `failed` or `truncated`. Do not display an interrupted/failed response as successfully completed.

Metrics `firstTextMs`, `firstAudioMs` and `totalMs` start when the backend receives finalized input. They exclude speech-end detection, network transit and device playback. Measure user-perceived end-of-speech-to-playback separately in the app.

## Android integration boundaries

Use the existing signed-in Supabase session token and a new assistant base-URL setting. Implement a dedicated PCM capture/playback controller and a streaming HTTP client. Request microphone permission at the user action; stop capture on navigation/backgrounding. Keep chat and voice in the same conversation ID. Integrate `/history` deletion with account deletion. Do not reuse the legacy AAC upload/polling protocol for live voice.
