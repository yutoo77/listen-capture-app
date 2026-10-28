// Virtual clock only: no browser, server, credentials or real waiting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginPacer, loginEndpoint } from './e2e/fixtures/login-pacing.mjs';

function clock() {
  let now = 0;
  const sleeps = [];
  return {
    sleeps,
    get now() { return now; },
    advance(milliseconds) { now += milliseconds; },
    options: { now: () => now, wait: async milliseconds => { sleeps.push(milliseconds); now += milliseconds; } },
  };
}

test('one worker queue spaces concurrent login sends at the proxy budget', async () => {
  const time = clock();
  const pace = createLoginPacer(time.options);
  const starts = [];
  await Promise.all(Array.from({ length: 60 }, (_, index) => pace(() => { starts.push([index, time.now]); })));
  assert.equal(starts.length, 60);
  assert.equal(starts[0][1], 6100);
  starts.forEach(([index, sent], position) => { assert.equal(index, position); assert.equal(sent, (position + 1) * 6100); });
  assert.equal(starts.at(-1)[1], 366000);
});

test('failed sends retain their error without retries or a poisoned queue', async () => {
  const time = clock();
  const pace = createLoginPacer(time.options);
  let attempts = 0;
  const first = pace(() => { attempts++; throw new Error('synthetic send failed'); });
  const second = pace(() => { attempts++; return time.now; });
  await assert.rejects(first, /synthetic send failed/);
  assert.equal(await second, 12200);
  assert.equal(attempts, 2);
});

test('slow sends and new workers cannot use an immediate extra login slot', async () => {
  const time = clock();
  const pace = createLoginPacer(time.options);
  const first = pace(() => { const sent = time.now; time.advance(9000); return sent; });
  const second = pace(() => time.now);
  assert.equal(await first, 6100);
  assert.equal(await second, 15100);
  const replacement = createLoginPacer(time.options);
  assert.equal(await replacement(() => time.now), 21200);
});

test('an early timer wakeup is rechecked before sending', async () => {
  let now = 0;
  const pace = createLoginPacer({ now: () => now, wait: async remaining => { now += Math.min(remaining, 1000); } });
  assert.equal(await pace(() => now), 6100);
});

test('login matching includes query strings without intercepting unrelated API paths', () => {
  for (const url of ['http://127.0.0.1:8080/api/login/', 'https://localhost:8443/api/login/?next=listen']) assert.match(url, loginEndpoint);
  for (const url of ['http://localhost/api/session/', 'http://localhost/api/login/other', 'http://localhost/api/logout/']) assert.doesNotMatch(url, loginEndpoint);
});
