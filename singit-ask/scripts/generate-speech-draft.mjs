// Offline M2 review artifact. Does not submit a Bazaar listing or publish anything.
// node singit-ask/scripts/generate-speech-draft.mjs > docs/m2-speech-draft.json
import { generateOpenapi } from './generate-openapi.mjs';
import { ASYNC_SPEECH_MODELS } from '../src/speech-models.mjs';
import { SPEECH_ROUTE, speechPrice, SPEECH_TERMS, ASYNC_SPEECH_TERMS } from '../src/speech.mjs';
import { BASE, SOLANA } from '../src/pricing.mjs';
const spec = await generateOpenapi();
console.log(JSON.stringify({ status: 'draft; not approved for merge or publication',
  resources: [{ url: `https://ask.singitai.app${SPEECH_ROUTE}`, method: 'POST',
    inputSchema: spec.paths[SPEECH_ROUTE].post.requestBody.content['application/json'].schema }],
  wellKnown: { resources: [`https://ask.singitai.app${SPEECH_ROUTE}`] },
  openapi: Object.fromEntries([SPEECH_ROUTE, '/v1/audio/models'].map(path => [path, spec.paths[path]])),
  terms: { ...SPEECH_TERMS, ...ASYNC_SPEECH_TERMS },
  models: ASYNC_SPEECH_MODELS.map(m => ({ ...m, modality: 'speech', prices: Object.fromEntries(
    [BASE, SOLANA].map(n => [n, speechPrice(Math.ceil(m.usdPerJob * 1e6), n)])) })),
  openQuestions: ['Verify music-generation TTS request fields prompt + voice with one explicitly approved paid call.',
    'Verify provider text limits and returned audio containers for all three models before merge.'],
}, null, 2));
