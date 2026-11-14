// The production proxy admits 10 login requests/minute per source IP. Browser
// contexts/accounts do not get separate proxy budgets. Keep one worker-wide
// queue for first sends, including popups and direct UI logins; never retry 429.
export const loginEndpoint = /\/api\/login\/(?:\?.*)?$/;

export function createLoginPacer({
  intervalMs = 6100,
  now = () => performance.now(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Positive login interval required.');
  // Also wait on a fresh/replacement worker so restart cannot create a burst.
  let nextSend = now() + intervalMs;
  let queue = Promise.resolve();
  return send => {
    const scheduled = queue.then(async () => {
      while (now() < nextSend) await wait(nextSend - now());
      nextSend = now() + intervalMs;
      return send();
    });
    queue = scheduled.catch(() => {}); // A failed send must not poison later slots.
    return scheduled; // Preserve failure for the request/test that caused it.
  };
}
