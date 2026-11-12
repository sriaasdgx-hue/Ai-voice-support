# Validation — 12 November 2026

## Automated checks

**19 tests passed, zero failed, zero skipped** when run with a disposable PostgreSQL 17 database. Node.js 24.22.3 on ARM64 Linux. Tests cover:

- Test-key authentication and Supabase identity verification behavior; invalid origins and inputs.
- User isolation for history/deletion; database persistence, idempotency and saved settings.
- Tamil script selection, acknowledgement continuity and unsupported routes; wrong-script rejection.
- Split UTF-8 stream parsing and removal of hidden thinking output.
- Direct and outbound-worker text/voice flows, single-use voice tickets and capacity limits.
- Interruption, malformed PCM, HTTP cancellation, worker disconnection and graceful shutdown.
- PCM worklet clipping, resampling and frame sizes; bounded relay queues.

`npm audit --omit=dev` reported zero known dependency vulnerabilities at verification time. Both Render templates passed the JSON Schema served at https://render.com/schema/render.yaml.json. Source JavaScript passed Node syntax checks.

## Actual model integration

Exercised: test client → Node HTTP/WebSocket → outbound model worker → local Gemma 4 E4B / Bodhan Indic-Transcribe-Core / AI4Bharat Indic Parler → saved PostgreSQL history. No Gemma 3 calls were made.

| Test | Result |
| --- | --- |
| Tamil question: `நீங்கள் எப்படி இருக்கிறீர்கள்?` | Tamil reply; first text 959 ms, complete 973 ms |
| Follow-up: `ஹலோ` | Tamil reply; first text 707 ms, complete 721 ms |
| Synthetic Tamil speech fixture | Recognized `உங்களை அன்புடன் வரவேற்கிறேன்`; Tamil reply and 173,568 PCM audio bytes |
| First text after finalized voice input | 854 ms |
| First audio after finalized voice input | 1,658 ms |
| Complete voice generation | 4,260 ms |
| Automatic delivery classifier | Valid `warm`, `subtle` result for a Tamil greeting |

The voice reply was `உங்களையும் அன்புடன் வரவேற்கிறேன். உங்களுக்கு என்ன வேண்டும் என்று சொல்லுங்கள்.` The smoke script writes its full report and WAV under ignored `test-results/` when run. No user recordings or credentials are included in the distributable ZIP.

These timings come from an already loaded local pipeline with neutral delivery during the full voice test, not from Render or an Android device. They exclude speech-end detection, network transit and playback buffering. This validates the model interfaces and Tamil route, not all-language fluency or concurrent-user capacity.

## Remaining deployment/device checks

The Render deployment has not been created; the user will deploy it. Verify its public HTTPS/WSS path, database connection, worker reconnect and measured latency after deployment. No external billing resources were provisioned.

Browser automation could not attach because the available browser-control tool returned an internal `timeoutMs` error. The backend's HTTP and WebSocket flows were tested programmatically, including actual PCM generation. Interactive microphone permission, acoustic echo/interruption, audible voice quality and mobile-browser behavior still need a real device test. Android source integration and APK changes are outside this backend delivery.
