import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetries, withClientHeader, clientHeader } from '../src/headers.js';
test('header is versioned and signed transport failures are never retried', async () => {
  assert.equal(clientHeader(undefined, '0.1.0'), 'singit-cc/0.1.0');
  for (const signed of [false, true]) {
    for (const throws of [false, true]) {
      let calls = 0;
      const send = withRetries(withClientHeader(async input => {
        calls++;
        assert.equal(input.headers.get('x-singit-client'), 'singit-cc/0.1.0');
        if (throws) throw new Error('network unavailable');
        return new Response('', { status: 503 });
      }, { version: '0.1.0' }));
      const result = send(new Request('http://merchant', { method: 'POST', body: '{}', headers: signed ? { 'PAYMENT-SIGNATURE': 'test' } : {} }));
      if (throws) await assert.rejects(result); else assert.equal((await result).status, 503);
      assert.equal(calls, signed ? 1 : 2);
    }
  }
});
