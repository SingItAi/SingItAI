# M2 speech extension — local draft, 5 November 2026

Branch `feat/models-m2`, based on `08f53bc`. Not approved for merge. No commit, remote PR, publication, network request, or paid call was made for this work.

| Public id | Surplus id |
| --- | --- |
| elevenlabs/multilingual-v2 | venice-elevenlabs-tts-multilingual-v2 |
| elevenlabs/v3 | venice-elevenlabs-tts-v3 |
| bytedance/seed-audio-1.0 | seed-audio-1-0 |

Prices come from the live catalogue's `pricing.image` with `pricing.media_unit=job`. Only finite prices greater than zero and below $2 are offered; an unavailable or invalid price returns 503 before payment. Historical sample prices are test fixtures only.

Public speech ids accept slashes already; no id-rule change was needed. Only these three music-modality models are allowlisted as speech. Flash v2.5 was not added. Existing per-character speech and API-key transcription behavior is preserved.

Markup is 3000 bps, rounded up in micro-USDC, plus the existing 0.001 Base / 0.002 Solana settlement fee. Inputs are capped at 4096 characters. These models accept optional catalog-listed voices and return the provider's audio format; response_format and speed are rejected before payment because the offline metadata does not document those controls consistently.

SingIt submits a music-generation job using config.surplusKey, polls every second, follows at most three HTTPS artifact redirects after checking every destination's literal IP or all DNS answers for private, loopback, link-local, CGNAT and metadata addresses. The first artifact hop uses the configured Surplus origin; cross-origin requests omit authorization. It streams at most 20 MiB. Submission through download shares a 110-second deadline. Non-empty MP3/WAV/Ogg/FLAC/AAC container signatures are required before HTTP 200. Failure, no credit, timeout, missing result, malformed/empty/oversized artifact all produce 503 before settlement. No artifact URL or audio is persisted. No transcription x402 route was added.

## Offline generation

- `node singit-ask/scripts/generate-openapi.mjs` renders the actual OpenAPI handler without sockets.
- `node singit-ask/scripts/generate-speech-draft.mjs > docs/m2-speech-draft.json` produces the review-only OpenAPI, well-known resource and Bazaar input schema with mappings and live pricing requirements. The existing speech resource URL remains unchanged; no new live resource was submitted.
- `node scripts/generate-model-pages.mjs` regenerates website llms documents. `website/llms.txt` is 13,987 bytes, below 14,000.
- Runtime OpenAPI, well-known instructions, Bazaar model field documentation and service llms describe the extension.

## Verification

Passed: 11 async speech mock tests (mapping, prices, cap/controls, submit/poll/artifact flow, no credit, upstream errors, timeout, missing/invalid/empty/oversized results); 3 OpenAPI lint tests; 8 generated llms tests; llms text checks; generator freshness and diff whitespace checks.

Seven HTTP tests were added to `singit-ask/test/speech.test.mjs`, asserting settlement once only on validated audio and zero settlement on failed job, timeout, no credit, malformed/empty/oversized output. This suite's listener-based cases cannot run here: loopback listen is rejected with EPERM. Run the speech suite in a socket-enabled environment before merging; no claim is made that settlement integration passed here.

## OPEN QUESTIONS before merge

1. The offline docs document async music submission/status/artifact routes but omit the TTS request field schema. `asyncSpeechBody` deliberately isolates the provisional `{ model: upstreamId, prompt: input, voice?: voice }` shape. Verify text field and voice handling with one separately approved paid call; do not silently treat this draft adapter as verified.
2. Confirm that the provider permits the 4096-character cap at the fixed job price, and confirm the resulting audio containers, for all three models. The metadata lists no per-request limits. No live verification was authorized or performed.


## Review follow-up — SingItAI #221

Both P1 findings are addressed locally: bounded, validated artifact redirects and live catalogue job pricing. Offline async speech regressions pass. The requested combined speech test command was attempted; HTTP tests remain blocked by sandbox `listen EPERM`. Settlement assertions for unsafe redirects and invalid-price pre-payment refusal are present but require a socket-enabled rerun. No shared listener helpers were replaced, no network or paid calls were made, and no commits were created.
