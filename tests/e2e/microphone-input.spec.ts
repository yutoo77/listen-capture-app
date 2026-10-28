import { expect, test, type Page } from './fixtures/accounts';

// Device routing/names below are deliberately simulated. The underlying stream,
// analyser and MediaRecorder are Chromium's synthetic microphone, while upload,
// validation, Session/CSRF and persistence use the actual Django/PostgreSQL app.
// These tests do not establish that a physical AirPods microphone was selected.
type Harness = {
  allowed: string[];
  permitted: boolean;
  denied: string | null;
  rejected: string | null;
  requests: MediaStreamConstraints[];
  streams: MediaStream[];
};
type HarnessWindow = Window & { __lcMicrophones: Harness };
type Memo = { id: string; client_id: string; audio_version: string; position_ms: number; media_url: string };
const AIRPODS = 'synthetic-airpods';
const USB = 'synthetic-usb';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}
async function demo(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/documents/demo/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  expect([200, 201]).toContain((await response).status());
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  return (await (await page.request.get('/api/documents/')).json())[0];
}
async function allowNames(page: Page) {
  await page.getByRole('button', { name: 'マイクを許可', exact: true }).click();
  await expect(page.getByLabel('入力マイク')).toContainText('AirPods（一覧の表示名）');
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as HarnessWindow).__lcMicrophones.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
}
async function start(page: Page, seconds = 12) {
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement, position) => { element.currentTime = position; }, seconds);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(seconds);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  // Capture freezes its offset before pausing or requesting the microphone.
  // A later native currentTime read can be 1ms ahead of that frozen offset.
  // Use a settled, known anchor for these device-routing/removal assertions;
  // the API must still persist that exact millisecond, without a tolerance.
  await source.evaluate((element: HTMLAudioElement, position) => { element.currentTime = position; }, seconds);
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.seeking ? null : element.currentTime)).toBe(seconds);
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  expect(await source.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  return seconds * 1000;
}
function saving(page: Page) {
  return page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
}
async function listMemos(page: Page): Promise<Memo[]> {
  const response = await page.request.get('/api/memos/');
  expect(response.status()).toBe(200);
  return response.json();
}
async function requests(page: Page) {
  return page.evaluate(() => (window as HarnessWindow).__lcMicrophones.requests);
}

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: 'microphone', description: 'Simulated device identities over Chromium fake microphone; actual analyser/MediaRecorder, Django API and PostgreSQL. No real hardware or human listening.' });
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return;
    const state: Harness = { allowed: ['synthetic-usb', 'synthetic-airpods'], permitted: false, denied: null, rejected: null, requests: [], streams: [] };
    Object.assign(window, { __lcMicrophones: state });
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => state.allowed.map(deviceId => ({
      kind: 'audioinput', deviceId, groupId: deviceId,
      label: !state.permitted ? '' : deviceId === 'synthetic-airpods' ? 'AirPods（一覧の表示名）' : 'USB（一覧の表示名）',
      toJSON() { return {}; },
    } as MediaDeviceInfo));
    navigator.mediaDevices.getUserMedia = async constraints => {
      state.requests.push(structuredClone(constraints ?? {}));
      const input = typeof constraints?.audio === 'object' ? constraints.audio : {};
      const constraint = input.deviceId;
      const exact = constraint && typeof constraint === 'object' && !Array.isArray(constraint) ? constraint.exact : undefined;
      const requested = typeof exact === 'string' ? exact : 'synthetic-usb';
      if (state.denied) throw new DOMException('Synthetic rejection', state.denied);
      if (requested === state.rejected || !state.allowed.includes(requested)) throw new DOMException('Synthetic missing input', 'OverconstrainedError');
      // The adapter maps the chosen test identity onto the real synthetic stream.
      // Assertions inspect the untouched app request above, not this translation.
      const stream = await original({ ...constraints, audio: { ...input, deviceId: undefined } });
      state.permitted = true;
      for (const track of stream.getAudioTracks()) Object.defineProperty(track, 'label', {
        configurable: true, get: () => requested === 'synthetic-airpods' ? '実際の入力: synthetic AirPods' : '実際の入力: synthetic USB',
      });
      state.streams.push(stream);
      return stream;
    };
  });
  await login(page);
});

test.afterEach(async ({ page }) => {
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('about:blank');
  const response = await page.request.get('/api/session/');
  if (!response.ok()) return;
  const session = await response.json();
  if (session.user?.username !== process.env.LC_E2E_ALICE) return;
  const documents = await (await page.request.get('/api/documents/')).json();
  for (const document of documents) expect((await page.request.delete(`/api/documents/${document.id}/`, { headers: { 'X-CSRFToken': session.csrfToken } })).status()).toBe(204);
});

test('explicit input wins over browser default, shows actual track name/activity, and saves a playable memo', async ({ page }) => {
  const document = await demo(page);
  await allowNames(page);
  expect((await requests(page))).toHaveLength(1);
  expect((await requests(page))[0]).toEqual({ audio: { echoCancellation: true, noiseSuppression: true } });
  expect(await listMemos(page)).toEqual([]);
  await page.getByLabel('入力マイク').selectOption(AIRPODS);
  const anchor = await start(page);
  const requested = await requests(page);
  expect(requested).toHaveLength(2);
  expect(requested[1]).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, deviceId: { exact: AIRPODS } } });
  await expect(page.getByText('録音中: 実際の入力: synthetic AirPods', { exact: true })).toBeVisible();
  await expect(page.getByLabel('入力マイク')).toBeDisabled();
  await expect.poll(() => page.getByRole('meter', { name: 'マイク入力レベル' }).evaluate((meter: HTMLMeterElement) => meter.value)).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  const saved = saving(page);
  await page.getByTestId('record-toggle').click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const memo = await response.json() as Memo;
  expect(memo.position_ms).toBe(anchor);
  expect(memo.audio_version).toBe(document.audio_versions[0].id);
  await expect(page.getByTestId('recent-memo')).toContainText('サーバー保存済み');
  await expect(page.getByRole('meter', { name: 'マイク入力レベル' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as HarnessWindow).__lcMicrophones.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  const audition = page.getByTestId('recent-memo').locator('audio');
  await audition.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => audition.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  const fetched = await page.request.get(memo.media_url, { headers: { Range: 'bytes=0-15' } });
  expect(fetched.status()).toBe(206);
  expect((await fetched.body()).length).toBe(16);
  await page.reload();
  expect((await listMemos(page)).map(memo => memo.id)).toEqual([memo.id]);
});

test('selected device removal saves the partial memo without switching, then another input requires explicit selection', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await allowNames(page);
  await page.getByLabel('入力マイク').selectOption(AIRPODS);
  const anchor = await start(page, 27);
  await page.waitForTimeout(1200);
  const saved = saving(page);
  // This does not dispatch track.ended: it specifically exercises the app's
  // devicechange/enumeration guard, rather than the existing track event path.
  await page.evaluate(() => {
    (window as HarnessWindow).__lcMicrophones.allowed = ['synthetic-usb'];
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
  const response = await saved;
  expect(response.status()).toBe(201);
  const first = await response.json() as Memo;
  expect(first.position_ms).toBe(anchor);
  await expect(page.getByLabel('入力マイク')).toHaveValue(AIRPODS);
  await expect(page.getByLabel('入力マイク')).toContainText('選択したマイク（未接続）');
  await expect(page.getByTestId('recent-memo')).toContainText('サーバー保存済み');
  await expect(page.getByTestId('record-toggle')).toBeDisabled();
  expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  expect(await requests(page)).toHaveLength(2);
  await expect.poll(() => page.evaluate(() => (window as HarnessWindow).__lcMicrophones.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  // Refreshing an unchanged list cannot reopen a microphone or resubmit audio.
  await page.getByRole('button', { name: '更新', exact: true }).click();
  expect(await requests(page)).toHaveLength(2);
  expect((await listMemos(page)).map(memo => memo.id)).toEqual([first.id]);
  await page.getByLabel('入力マイク').selectOption(USB);
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  await start(page, 36);
  await expect(page.getByText('録音中: 実際の入力: synthetic USB', { exact: true })).toBeVisible();
  expect((await requests(page))[2]).toMatchObject({ audio: { deviceId: { exact: USB } } });
  await page.waitForTimeout(1200);
  const secondSaved = saving(page);
  await page.getByTestId('record-toggle').click();
  expect((await secondSaved).status()).toBe(201);
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  expect(await listMemos(page)).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('permission denial recovers explicitly and a rejected exact input never opens a fallback or saves a memo', async ({ page }) => {
  await demo(page);
  await page.evaluate(() => { (window as HarnessWindow).__lcMicrophones.denied = 'NotAllowedError'; });
  await page.getByRole('button', { name: 'マイクを許可', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('サイト設定でマイクを許可');
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  expect(await requests(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as HarnessWindow).__lcMicrophones.streams.length)).toBe(0);
  await page.evaluate(() => { (window as HarnessWindow).__lcMicrophones.denied = null; });
  await allowNames(page);
  await page.getByLabel('入力マイク').selectOption(AIRPODS);
  await page.evaluate(() => { (window as HarnessWindow).__lcMicrophones.rejected = 'synthetic-airpods'; });
  await page.getByTestId('record-toggle').click();
  await expect(page.getByRole('status').filter({ hasText: '別のマイクには切り替えていません' })).toBeVisible();
  await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  expect(await requests(page)).toHaveLength(3);
  expect((await requests(page))[2]).toMatchObject({ audio: { deviceId: { exact: AIRPODS } } });
  expect(await listMemos(page)).toEqual([]);
  expect(await page.evaluate(() => (window as HarnessWindow).__lcMicrophones.streams.length)).toBe(1);
});
