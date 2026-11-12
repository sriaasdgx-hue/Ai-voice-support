# Ai-voice-support

SRIAAS chat and voice backend.

An independent Node.js backend for general conversation, using **Gemma 4 E4B**, **Bodhan Indic-Transcribe-Core** and **AI4Bharat Indic Parler**. It includes a browser test page, streamed text, live voice, interruption, language selection, authentication and saved conversation history.

The Android app's existing ERP/support backend is separate. This package does not yet change the Android app or call ERP, patient records, documents, web search or business tools.

```text
Browser test page / future Android client
                    ↕ HTTPS + WebSocket
             Node backend on Render
                ↕            ↕
     PostgreSQL history     Secure outbound worker connection
     (Supabase or Render)             ↕
                              Your Spark computer
                          Gemma 4 + Bodhan + Parler
```

PostgreSQL saves messages, user ownership and language settings across restarts. It does not run the AI and does not store microphone recordings. **Your existing Supabase database can be used; Supabase is PostgreSQL.** A separate Render database is optional. Local development can also use temporary in-memory history.

## Deploy to Render and test

### 1. Upload this backend

This repository is ready to connect to Render. If deploying from `sriaas-ai-backend.zip`, put the **contents of its `sriaas-ai-backend` directory** at the root of your Git repository. Include `package.json`, `package-lock.json`, `render.yaml`, `src`, `public`, `migrations`, `scripts` and `test`. Do not upload `.env`, `.worker.env`, `node_modules` or test recordings.

### 2. Choose history storage, then deploy

- **Use existing Supabase/Postgres:** keep the default `render.yaml`. Supply `DATABASE_URL` when Render prompts. Obtain a server connection string from your database dashboard; for Supabase use a connection/pooler address reachable from Render. This template enables verified database TLS. The database account must be allowed to create and own the new `assistant_*` tables. No Supabase service-role key is required.
- **Use a separate Render Postgres database:** replace `render.yaml` with the contents of `render-with-postgres.yaml` before deploying. It creates both the Node service and its private database in Singapore.

In Render, choose **New → Blueprint**, connect your repository, review the resources and create them. The supplied web service uses the **paid Starter plan**. The separate-database template also creates a **paid `0.1c-256mb` Postgres instance with 1 GB storage**. The existing-database template creates no new database. Review Render's displayed charges before deploying. Nothing in this package deploys or charges automatically.

Render runs `npm ci --omit=dev`, then `npm start`. The backend binds `0.0.0.0:$PORT`, creates its tables on startup and exposes `/healthz`. Keep **one instance**. No disk is needed for the Node service.

### 3. Connect your local models

On the Spark computer, load this pipeline in Voice Lab:

- LLM: **Gemma 4 E4B**, thinking off
- STT: **Bodhan Indic-Transcribe-Core**
- TTS: **AI4Bharat Indic Parler**

Keep the model processes running, but **end any Voice Lab conversation** before using the new backend. The STT process currently supports one session. Do not start Gemma 3 or switch the selected TTS to Svara.

Install Node.js 24 LTS on the computer running the connector, then:

```bash
cd sriaas-ai-backend
npm ci
cp .worker.env.example .worker.env
```

Edit `.worker.env`:

```dotenv
BACKEND_URL=https://YOUR-SERVICE.onrender.com
MODEL_WORKER_TOKEN=copy-the-value-from-Render
```

Copy **MODEL_WORKER_TOKEN** from the Render service's Environment page. Keep the default local model URLs unless those model ports have changed. Then run:

```bash
npm run worker
```

Leave this process and the three model services running. It makes an outbound encrypted connection to Render and reconnects automatically. You do not need to expose GPU ports publicly, open router ports, or install a tunnel. The worker does not download or start model servers itself.

### 4. Open the test page

Open your Render service URL. Copy **TEST_API_KEY** from the Render Environment page into the page's password field and click **Connect**. This key is different from the worker token.

Wait for **Models ready**. Type a message, or allow microphone access and click **Start voice**. For a reliable Tamil test, select **Tamil** for both input and reply language. You can also test **Match my language**. Click **End session** before returning to Voice Lab.

The page shows transcripts, streamed replies, spoken audio, interruption controls and measured timings. Microphone access requires HTTPS, or localhost for local tests. For the first release, one person can use the model pipeline at a time. A second session receives a busy message.

### 5. After the browser test

Connect the Flutter app to this service using [API.md](API.md). Set a separate assistant base URL; retain its existing ERP URL. The old `/api/v1/ai-chat` service, AAC voice-note uploads and polling are not compatible with this new live-voice protocol without an Android client change.

Before allowing real app users, set Render's:

```dotenv
AUTH_MODE=supabase
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_ANON_KEY=your-project-anon-key
```

The client sends its signed-in Supabase access token as `Authorization: Bearer ...`. The server verifies identity using Supabase and enforces ownership on each conversation. **Never put TEST_API_KEY, database credentials or MODEL_WORKER_TOKEN in an APK.** Test-key mode intentionally shares one protected test history; it is not multi-user authentication. Changing auth mode does not transfer the test user's history to real users.

## Running everything locally

```bash
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the generated value in `.env` as `TEST_API_KEY`. Start the three models, then run `npm start` and visit `http://localhost:3000`. The example uses direct localhost model access and temporary memory history. For persistent history set `STORAGE=postgres`, `DATABASE_URL` and appropriate `DATABASE_SSL`.

Verification used port 3100, a worker connector and a disposable test Postgres container. Those temporary services were stopped after testing. Their credentials and recordings are excluded from the ZIP. Use the example files for a fresh deployment.

On the current Spark workspace, Node 24 was installed locally during setup. If `node` is not on your terminal PATH, run this from `sriaas-ai-backend` before the npm commands:

```bash
export PATH="$(cat ../.tools/node-runtime/bin-path.txt):$PATH"
```

## Moving models to cloud GPUs later

Run the same Bodhan and Parler API wrappers and the same Gemma model alias on your cloud GPU host. Either run `npm run worker` there with the same private worker token, or set the backend's `MODEL_TRANSPORT=direct` with authenticated HTTPS/WSS model endpoints:

| Variable | Meaning |
| --- | --- |
| `GEMMA_CHAT_URL` | Gemma `/v1/chat/completions` endpoint |
| `GEMMA_MODEL` | Served alias, initially `voice-lab-gemma4` |
| `BODHAN_WS_URL` | Bodhan `/v1/audio/transcriptions/realtime` endpoint |
| `PARLER_SPEECH_URL` | Parler `/v1/audio/speech` endpoint |
| `GEMMA_API_KEY`, `BODHAN_API_KEY`, `PARLER_API_KEY` | Optional provider authentication, held server-side |

The GPU services must implement these interfaces. A random provider's model API is not automatically compatible. No model weights are included in this package. Render hosts the Node application; the models need their own GPU infrastructure.

## Language and model behavior

There are **23 selectable reply routes: 21 Indic languages, English and Hinglish**. Routes match the installed Bodhan tokenizer and Parler voice registry. Tamil, Hindi, Assamese, Bengali, Bodo, Dogri, Gujarati, Kannada, Konkani, Maithili, Malayalam, Manipuri, Marathi, Nepali, Odia, Punjabi, Sanskrit, Santali, Sindhi, Telugu and Urdu are enabled. Hinglish shares Hindi recognition.

The capability endpoint supplies names, locales, speakers and experimental flags. Bodo, Dogri, Konkani, Maithili, Manipuri, Sanskrit, Santali and Sindhi are experimental. Some routes use a generic Parler speaker. Bhojpuri is excluded because its existing Voice Lab route requires Svara, which was not selected for this app. A route being enabled is not a claim of equally good fluency in every language.

Auto mode uses recognition metadata, script detection, conversation continuity and Gemma's language classification. Short acknowledgements preserve the last reply language. Fixed language selection takes priority. A script check attempts one correction before rejecting a wrong-script reply. It cannot prove fluency or reliably distinguish languages sharing a script; test those with native speakers.

Voice uses 24 kHz mono PCM16 input and 22.05 kHz PCM16 output. Speech-end detection starts at 1.2 seconds of silence. Delivery can be automatic or neutral. Automatic delivery adds a small classification request. Gemma uses temperature 0.6 and a configurable 1,024-output-token cap (maximum 2,048); reaching the cap is reported as `truncated`. Keep the Gemma server's thinking mode off. Recent context is bounded while full saved history remains available.

## Reliability, limits and data

- One backend instance, one connected model worker, one active voice session or text generation at a time. This initial capacity matches the local model servers; it is not a scaled public service. Adding instances requires shared session routing, locks and model capacity management.
- Text requests support idempotent client IDs. Saved status distinguishes completed, interrupted, failed and truncated replies. Socket loss or interruption cancels generation and releases capacity.
- Voice connections use authenticated, single-use tickets with a 30-second expiry. A voice session lasts up to 10 minutes. Reconnect by requesting a new ticket; old audio is not replayed automatically.
- The browser limits queued playback and stops microphone use when its tab is hidden. Use headphones if the speaker feeds into the microphone and triggers interruptions.
- Only finalized transcripts, replies and settings are saved. No raw live audio is written by the backend or worker. The optional smoke script explicitly saves its synthetic test reply locally.
- Conversation deletion and full-history deletion are supported. Wire full-history deletion into the app's account-deletion flow before public release. There is no automatic retention expiry yet.
- `GET /healthz` checks Node liveness. Authenticated `/capabilities` reports model health. A healthy Render deploy can still show an offline worker until the Spark connector starts.
- Render restarts terminate voice sessions; history remains in PostgreSQL. Keep secrets in environment variables. The code does not log auth tokens, model request bodies or transcripts.

## Tests and measured results

```bash
npm test
# Use a disposable database to run the PostgreSQL integration check too:
TEST_DATABASE_URL=postgres://USER:PASSWORD@HOST/TEST_DB npm test
# Against an already running backend; credentials come from .env:
BACKEND_URL=http://localhost:3000 npm run smoke
# Optionally test voice with a PCM16 mono Tamil WAV fixture:
BACKEND_URL=http://localhost:3000 npm run smoke -- /path/to/tamil.wav
```

Tests cover authentication, ownership, idempotency, persistence, Tamil routing, hidden reasoning, streaming, PCM capture, single-use tickets, cancellation, worker disconnects and shutdown. The PostgreSQL test is skipped unless `TEST_DATABASE_URL` is set. Tests create isolated owner IDs in that database; use a disposable database.

On 12 November 2026, the real local worker path recognized a synthetic Tamil fixture, generated a Tamil Gemma reply and streamed Parler audio. First text in two short text tests took **0.71–0.96 seconds**; first voice audio took **1.66 seconds after finalized recognition**. These are observations, not a Render latency promise. Voice detection, network transit, device playback, automatic delivery and cold starts add time. See [VALIDATION.md](VALIDATION.md).

Browser automation was unavailable during verification. HTTP, WebSocket and audio generation were exercised programmatically; interactive microphone permission, speaker playback and Android integration still need a human/device test after deployment.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Spark worker offline | Run `npm run worker`; check the exact backend URL and matching worker token. |
| Worker connected, a model unavailable | Load the selected three models in Voice Lab and click Check models. |
| STT busy | End the Voice Lab or other backend conversation. Wait briefly before starting another. |
| Reply in the wrong language | Select the input and reply language explicitly; inspect the recognized transcript. |
| No microphone prompt | Use HTTPS/localhost and allow microphone access in browser settings. |
| Backend fails to start | Check auth variables, Node 24 and database reachability/TLS; do not use memory storage in production. |
| Database connection with Supabase fails | Use a reachable connection/pooler address and the database password, not an API key; keep TLS verification enabled. |
| Assistant busy | End the existing voice session or wait for its text generation to finish. |

Deployment settings were checked against [Render's Blueprint reference](https://render.com/docs/blueprint-spec), [Web Service documentation](https://render.com/docs/web-services), [WebSocket documentation](https://render.com/docs/websocket) and [Postgres connection guidance](https://render.com/docs/postgresql-creating-connecting).
