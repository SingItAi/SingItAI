// Explicit allowlist: these music-modality models produce speech, priced per job.
export const ASYNC_SPEECH_MODELS = Object.freeze([
  {
    "id": "elevenlabs/multilingual-v2",
    "upstreamId": "venice-elevenlabs-tts-multilingual-v2"
  },
  {
    "id": "elevenlabs/v3",
    "upstreamId": "venice-elevenlabs-tts-v3"
  },
  {
    "id": "bytedance/seed-audio-1.0",
    "upstreamId": "seed-audio-1-0"
  }
].map(Object.freeze));
