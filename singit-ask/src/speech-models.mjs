// Explicit allowlist: these music-modality models produce speech, priced per job.
export const ASYNC_SPEECH_MODELS = Object.freeze([
  {
    "id": "elevenlabs/multilingual-v2",
    "upstreamId": "venice-elevenlabs-tts-multilingual-v2",
    "usdPerJob": 0.12
  },
  {
    "id": "elevenlabs/v3",
    "upstreamId": "venice-elevenlabs-tts-v3",
    "usdPerJob": 0.12
  },
  {
    "id": "bytedance/seed-audio-1.0",
    "upstreamId": "seed-audio-1-0",
    "usdPerJob": 0.002875
  }
].map(Object.freeze));
