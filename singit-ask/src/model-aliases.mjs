// Public API ids that differ from Surplus ids. Keep marketplace reads and inference aligned.
export const MODEL_ALIASES = Object.freeze({
  "nemotron-3.5-lightning": "nvidia-nemotron-3-5-lightning-30b-a3b",
});
export const upstreamModelId = id => Object.hasOwn(MODEL_ALIASES, id) ? MODEL_ALIASES[id] : id;
export const publicModelId = id => Object.entries(MODEL_ALIASES).find(([, upstream]) => upstream === id)?.[0] ?? id;
