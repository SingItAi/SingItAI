// Shared bounded asynchronous Surplus jobs; the buyer receives only validated audio.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';
import { readBoundedJson, boundResponse } from './media-response.mjs';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 88))
      || (a === 198 && b === 51) || (a === 203 && b === 0)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Only global unicast IPv6; excludes mapped IPv4, loopback, ULA, link-local and multicast.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^(?:2001:|2002:|3fff:)/i.test(address);
}
export async function artifactTarget(value, resolve = lookup) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.localhost')) throw new Error('Unsafe artifact URL');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Private artifact host');
  return { url, address: addresses[0] };
}
// Pin the checked address to the TLS connection, preventing DNS rebinding. Hostname still verifies TLS.
function pinnedFetch(url, { headers, signal }, address) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, signal, lookup: (_host, options, cb) =>
      options.all ? cb(null, [address]) : cb(null, address.address, address.family) }, (res) => {
      try {
        const nullBody = [101, 204, 205, 304].includes(res.statusCode);
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
      } catch (error) { reject(error); }
    });
    req.on('error', reject); req.end();
  });
}
export function audioContentType(b) {
  const at = (s, n = 0) => b.subarray(n, n + s.length).toString('latin1') === s;
  if (at('RIFF') && at('WAVE', 8)) return 'audio/wav';
  if (at('fLaC')) return 'audio/flac';
  if (at('OggS')) return 'audio/ogg';
  if (at('ftyp', 4) && /^(M4A |M4B )/.test(b.subarray(8, 12).toString('latin1'))) return 'audio/mp4';
  if (at('ADIF') || (b.length >= 2 && b[0] === 255 && (b[1] & 0xf6) === 0xf0)) return 'audio/aac';
  if (at('ID3') || (b.length >= 2 && b[0] === 255 && (b[1] & 0xe0) === 0xe0 && (b[1] & 6))) return 'audio/mpeg';
  throw new Error('Non-audio artifact');
}
export async function runMediaJob({ baseUrl, key, request, idempotencyKey, timeoutMs, maxBytes,
  fetchImpl = fetch, artifactFetch, resolve = lookup, now = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = now() + timeoutMs;
  const signal = controller.signal;
  const check = () => { signal.throwIfAborted(); if (now() >= deadline) throw new Error('Media timeout'); };
  // Race even mocks and stalled body readers against the same whole-job deadline.
  const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Media timeout')), { once: true }));
  async function work() {
    const auth = { Authorization: `Bearer ${key}` };
    const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/music/generations`;
    const json = async (url, init) => {
      check();
      const response = await fetchImpl(url, { ...init, signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Media upstream unavailable'); }
      return readBoundedJson(response, 256 * 1024);
    };
    let job = await json(endpoint, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(request) });
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(job.id ?? '')) throw new Error('Invalid job id');
    const id = job.id;
    const token = job.job_token ?? job.token;
    const headers = token ? { 'X-Job-Token': token } : auth;
    while (job.status !== 'succeeded') {
      check();
      if (['failed', 'canceled', 'cancelled', 'expired'].includes(job.status)) throw new Error('Media failed');
      await sleep(Math.min(1000, Math.max(1, deadline - now()))); check();
      job = await json(`${endpoint}/${id}`, { headers });
    }
    let target = new URL(`/v1/media/artifacts/${id}/0`, baseUrl);
    const ownOrigin = new URL(baseUrl).origin;
    for (let redirects = 0; redirects <= 5; redirects++) {
      check();
      const checked = await artifactTarget(target, resolve); check();
      const response = await (artifactFetch ?? pinnedFetch)(checked.url,
        { headers: checked.url.origin === ownOrigin ? headers : {}, signal, redirect: 'manual' }, checked.address);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Missing redirect');
        target = new URL(location, target); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Artifact unavailable'); }
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Artifact too large'); }
      const audio = Buffer.from(await boundResponse(response, maxBytes).arrayBuffer()); check();
      return { audio, contentType: audioContentType(audio) };
    }
    throw new Error('Too many redirects');
  }
  try { return await Promise.race([work(), aborted]); }
  finally { clearTimeout(timer); controller.abort(); }
}
