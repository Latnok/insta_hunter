import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Semaphore } from '../src/lib/semaphore.js';

test('limits concurrent provider operations', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 8 }, () => semaphore.run(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(5);
    active--;
  })));
  assert.equal(maximum, 2);
});

test('removes an aborted provider operation while it waits for capacity', async () => {
  const semaphore = new Semaphore(1);
  let release;
  const active = semaphore.run(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const waiting = semaphore.run(async () => 'should not run', { signal: controller.signal });
  controller.abort(new DOMException('worker stopping', 'AbortError'));
  await assert.rejects(waiting, (error) => error.name === 'AbortError');
  release();
  await active;
  assert.equal(await semaphore.run(async () => 'next'), 'next');
});
