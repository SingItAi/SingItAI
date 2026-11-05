// Offline M2 review artifact. Does not submit a Bazaar listing or publish anything.
// node singit-ask/scripts/generate-speech-draft.mjs > docs/m2-speech-draft.json
import { generateOpenapi } from './generate-openapi.mjs';
import { ASYNC_SPEECH_MODELS } from '../src/speech-models.mjs';
import { SPEECH_ROUTE, SPEECH_TERMS, ASYNC_SPEECH_TERMS } from '../src/speech.mjs';
const spec = await generateOpenapi();
console.log(JSON.stringify({ status: 'draft; not approved for merge or publication',
  resources: [{ url: `https://ask.singitai.app${SPEECH_ROUTE}`, method: 'POST',
    inputSchema: spec.paths[SPEECH_ROUTE].post.requestBody.content['application/json'].schema }],
  wellKnown: { resources: [`https://ask.singitai.app${SPEECH_ROUTE}`] },
  openapi: Object.fromEntries([SPEECH_ROUTE, '/v1/audio/models'].map(path => [path, spec.paths[path]])),
  terms: { ...SPEECH_TERMS, ...ASYNC_SPEECH_TERMS },
  models: ASYNC_SPEECH_MODELS.map(m => ({ ...m, modality: 'speech',
    pricingSource: 'Live catalogue pricing.image with pricing.media_unit=job; finite USD price greater than 0 and below 2 required.' })),
  openQuestions: ['Verify music-generation TTS request fields prompt + voice with one explicitly approved paid call.',
    'Verify provider text limits and returned audio containers for all three models before merge.'],
}, null, 2));
