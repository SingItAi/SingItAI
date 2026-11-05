import { AUDIO_MODELS } from './audio-generation.mjs';

export const AUDIO_CREDIT_TTL_MS = 60_000;
// Only refresh() does I/O. Discovery and payment gates read ready() synchronously.
export function createAudioReadiness(config, { catalogue, fetchImpl = fetch, now = Date.now, log = console.error } = {}) {
  let snapshot = null, loading = null, timer;
  const allowed = config.audioModels === undefined ? null : new Set(config.audioModels);
  const ready = (upstream, { listAtomic } = {}) => {
    try {
      const model = AUDIO_MODELS.find(m => m.upstream === upstream);
      // The standard catalogue refreshes every five minutes. Reject missing/stale or changed metadata.
      if (catalogue && 'audioCatalogue' in catalogue) {
        const entry = catalogue.audioCatalogue?.get(upstream);
        const age = now() - catalogue.audioCatalogueAt;
        if (catalogue.audioCatalogueAt === null || age < 0 || age > 360_000
          || entry?.pricing?.media_unit !== 'job'
          || Number(entry.pricing.image) !== model?.listAtomic / 1e6
          || !entry.supported_parameters?.includes('async')
          || !(entry.supported_parameters.includes('music') || entry.supported_parameters.includes('sound-effects'))) return false;
      }
      return config.audioSold === true && !!model && model.listAtomic === listAtomic
        && (!allowed || allowed.has(model.id) || allowed.has(upstream))
        && snapshot !== null && now() - snapshot.at >= 0 && now() - snapshot.at <= AUDIO_CREDIT_TTL_MS
        && snapshot.balance >= BigInt(model.listAtomic)
        && !catalogue?.isUnservable?.(upstream) && !catalogue?.isSuspended?.(upstream);
    } catch { return false; }
  };
  const refresh = () => {
    if (loading) return loading;
    loading = (async () => {
      try {
        if (!config.surplusKey || !config.surplusUrl) throw new Error('missing credentials');
        const response = await fetchImpl(`${config.surplusUrl}/v1/payments/balance`, {
          method: 'GET', headers: { Authorization: `Bearer ${config.surplusKey}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error('balance unavailable');
        const value = (await response.json())?.credit_balance_usdc;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('invalid balance');
        snapshot = { balance: BigInt(value), at: now() };
        log('audio credit snapshot ok');
      } catch {
        snapshot = null;
        log('audio credit snapshot fail');
      } finally { loading = null; }
    })();
    return loading;
  };
  return { ready, refresh, start() {
    if (config.audioSold !== true || timer) return;
    void refresh();
    timer = setInterval(refresh, 30_000);
    timer.unref?.();
  }, stop() { clearInterval(timer); timer = undefined; } };
}
