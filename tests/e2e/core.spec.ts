import { expect, test, installLoginPacing, type Page, type Route } from './fixtures/accounts';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { inspectGeneratedAudio } from './fixtures/generated-audio';

type Memo = {
  id: string; client_id: string; audio_version: string; position_ms: number;
  duration_ms: number; text: string; media_url: string; document: { id: string; title: string };
};
type Document = {
  id: string; title: string;
  current_version: { id: string; number: number; text: string };
  audio_versions: { id: string; media_url: string; document_version: string; kind: string }[];
  audio_generation?: { id: string; state: string; audio_version: string | null } | null;
};
const diagnostics = new WeakMap<Page, { errors: string[]; expectedNetworkFailures: Set<string> }>();

function credentials(name: 'ALICE' | 'BOB') {
  const username = process.env[`LC_E2E_${name}`];
  const password = process.env.LC_E2E_PASSWORD;
  if (!username || !password) throw new Error('Run through scripts/run-e2e.py to create temporary E2E accounts.');
  return { username, password };
}

async function login(page: Page, name: 'ALICE' | 'BOB' = 'ALICE') {
  const account = credentials(name);
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(account.username);
  await page.getByLabel('パスワード', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}

async function csrf(page: Page) {
  const response = await page.request.get('/api/session/');
  expect(response.ok()).toBeTruthy();
  return (await response.json()).csrfToken as string;
}

async function memos(page: Page): Promise<Memo[]> {
  const response = await page.request.get('/api/memos/');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function demo(page: Page): Promise<Document> {
  const response = page.waitForResponse(response => response.url().endsWith('/api/documents/demo/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  const result = await response;
  expect([200, 201]).toContain(result.status());
  const document = await result.json() as Document;
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  return document;
}

async function expectTextOnlyDocument(page: Page, title: string) {
  const panel = page.getByRole('region', { name: title, exact: true });
  await expect(panel.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(panel.getByTestId('narration-generate')).toBeVisible();
}

// This uses Chromium's real MediaRecorder encoder and fake microphone device.
// The resulting multipart file passes the actual API's ffprobe validation.
async function record(page: Page, afterStart?: () => Promise<void>): Promise<number> {
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement) => { element.currentTime = 12; });
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await expect(page.getByTestId('record-toggle')).toBeInViewport({ ratio: 1 });
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  expect(await source.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  const anchor = await source.evaluate((element: HTMLAudioElement) => Math.floor(element.currentTime * 1000));
  await expect(page.getByRole('slider', { name: '再生位置' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /声のメモ/ })).toBeDisabled();
  if (afterStart) await afterStart();
  // A real duration is necessary to produce a valid encoded audio file.
  await page.waitForTimeout(1200);
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('メモする', { timeout: 25_000 });
  return anchor;
}

async function recordedMemo(page: Page): Promise<{ memo: Memo; anchor: number }> {
  const response = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  const anchor = await record(page);
  const saved = await response;
  expect(saved.status()).toBe(201);
  return { memo: await saved.json() as Memo, anchor };
}

async function pendingMetadata(page: Page) {
  return page.evaluate(() => new Promise<{ clientId: string; userId: string; blobBytes: number }[]>((resolve, reject) => {
    const request = indexedDB.open('listen-capture-outbox-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('recordings', 'readonly');
      const items = transaction.objectStore('recordings').getAll();
      items.onerror = () => reject(items.error);
      transaction.oncomplete = () => { resolve(items.result.map(item => ({ clientId: item.clientId, userId: item.userId, blobBytes: item.blob.size }))); database.close(); };
      transaction.onabort = () => reject(transaction.error);
    };
  }));
}

async function failMemoUpload(route: Route) {
  if (route.request().method() === 'POST') await route.abort('failed');
  else await route.continue();
}

test.beforeEach(async ({ page }) => {
  const state = { errors: [] as string[], expectedNetworkFailures: new Set<string>() };
  diagnostics.set(page, state);
  page.on('pageerror', error => state.errors.push(`pageerror: ${error.message}`));
  page.on('console', event => {
    if (event.type() !== 'error') return;
    const location = event.location().url;
    if (/net::ERR_(FAILED|ABORTED)/.test(event.text()) && [...state.expectedNetworkFailures].some(path => location.endsWith(path))) return;
    state.errors.push(`console: ${event.text()}`);
  });
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) return; // about:blank during cleanup has no media API.
    const streams: MediaStream[] = [];
    Object.assign(window, { __lcTestStreams: streams });
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints); streams.push(stream); return stream;
    };
  });
  await login(page);
});

test.afterEach(async ({ page }) => {
  // Unmount the player before deleting its parent; no background progress
  // write should race test-only cleanup of an otherwise live audio element.
  await page.goto('about:blank');
  // Accounts are unique to this run, and workers=1. Remove only this account's
  // temporary documents/memos, leaving other development users untouched.
  const session = await page.request.get('/api/session/');
  if (session.ok()) {
    const account = await session.json();
    if (account.user?.username === credentials('ALICE').username) {
      const documents = await page.request.get('/api/documents/');
      if (documents.ok()) for (const document of await documents.json() as Document[]) {
        const removed = await page.request.delete(`/api/documents/${document.id}/`, { headers: { 'X-CSRFToken': account.csrfToken } });
        expect(removed.status()).toBe(204);
      }
    }
  }
  expect(diagnostics.get(page)?.errors ?? []).toEqual([]);
});

test('playback position survives reload and login, deliberate rewind and stale-device conflict', async ({ page }, testInfo) => {
  const document = await demo(page);
  const audio = document.audio_versions[0];
  const endpoint = `/api/audio/${audio.id}/progress/`;
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement) => { element.currentTime = 34; });
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).position_ms).toBe(34000);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  expect(await source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(34, 1);
  // Rewind is an intentional current-revision update; it must survive login.
  await source.evaluate((element: HTMLAudioElement) => { element.currentTime = 9; });
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('ユーザー名', { exact: true })).toBeVisible();
  await login(page);
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  expect(await source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(9, 1);
  const current = await (await page.request.get(endpoint)).json();
  const saved = await page.request.put(endpoint, { headers: { 'X-CSRFToken': await csrf(page) }, data: {
    position_ms: 60000, revision: current.revision, client_id: randomUUID(),
  } });
  expect(saved.status()).toBe(200);
  // A different device updated the server; this player's older revision fails.
  // Browser console reports expected HTTP409, which is part of this scenario.
  const state = diagnostics.get(page)!;
  const mark = state.errors.length;
  await source.evaluate((element: HTMLAudioElement) => { element.currentTime = 11; });
  await expect(page.getByTestId('progress-status')).toContainText('別の画面');
  expect((await (await page.request.get(endpoint)).json()).position_ms).toBe(60000);
  state.errors.splice(mark, state.errors.length - mark, ...state.errors.slice(mark).filter(e => !e.includes('409')));
  await page.getByRole('button', { name: '保存済みの位置を開く' }).click();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(60);
  await page.screenshot({ path: testInfo.outputPath('desktop-player.png'), fullPage: true });
});

test('slow progress restore preserves a newer same-audio memo anchor', async ({ page }) => {
  const document = await demo(page);
  const { memo } = await recordedMemo(page);
  const endpoint = `/api/audio/${memo.audio_version}/progress/`;
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement) => { element.pause(); element.currentTime = 74; });
  await expect.poll(async () => (await (await page.request.get(endpoint)).json()).position_ms).toBe(74000);
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === 'GET') await held;
    await route.continue();
  });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('progress-status')).toContainText('確認中');
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0);
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await page.getByRole('button', { name: '元の位置へ戻る' }).click();
  release();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect.poll(async () => Math.abs(await source.evaluate((element: HTMLAudioElement) => element.currentTime * 1000) - memo.position_ms)).toBeLessThan(150);
});

test('failed final position after source switch remains visible and retryable', async ({ page }) => {
  const document = await demo(page);
  const endpoint = `/api/audio/${document.audio_versions[0].id}/progress/`;
  const other = await page.request.post('/api/documents/', { headers: { 'X-CSRFToken': await csrf(page) }, data: { title: '次の資料', text: '次に読む本文。' } });
  expect(other.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let first = true;
  diagnostics.get(page)!.expectedNetworkFailures.add(endpoint);
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() === 'PUT' && first) {
      first = false; await held; return route.abort('failed');
    }
    return route.continue();
  });
  await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => { element.currentTime = 28; });
  await expect(page.getByTestId('progress-status')).toContainText('保存中');
  await page.getByRole('button', { name: /次の資料/ }).click();
  await expectTextOnlyDocument(page, '次の資料');
  release();
  await expect(page.getByTestId('progress-recovery')).toContainText('保存できません');
  await page.getByRole('button', { name: '再生位置を再送' }).click();
  await expect(page.getByTestId('progress-recovery')).toHaveCount(0);
  expect((await (await page.request.get(endpoint)).json()).position_ms).toBe(28000);
});

test('playback progress lost response retries the same request without duplicate revision', async ({ page }) => {
  const document = await demo(page);
  const endpoint = `/api/audio/${document.audio_versions[0].id}/progress/`;
  const submissions: unknown[] = [];
  let drop = true;
  diagnostics.get(page)!.expectedNetworkFailures.add(endpoint);
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    submissions.push(route.request().postDataJSON());
    if (drop) {
      drop = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => { element.currentTime = 22; });
  await expect(page.getByTestId('progress-status')).toContainText('できません');
  expect((await (await page.request.get(endpoint)).json()).revision).toBe(1);
  await page.getByRole('button', { name: '再試行', exact: true }).click();
  await expect(page.getByTestId('progress-status')).toContainText('再生位置を保存済み');
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  expect((await (await page.request.get(endpoint)).json()).revision).toBe(1);
});

test('failed initial position read does not create an unsent-position recovery after switching source', async ({ page }) => {
  const document = await demo(page);
  const endpoint = `/api/audio/${document.audio_versions[0].id}/progress/`;
  const other = await page.request.post('/api/documents/', { headers: { 'X-CSRFToken': await csrf(page) }, data: { title: '読み込み失敗後の資料', text: '音声のない別の資料。' } });
  expect(other.status()).toBe(201);
  await page.reload();
  diagnostics.get(page)!.expectedNetworkFailures.add(endpoint);
  await page.route(`**${endpoint}`, route => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('progress-status')).toContainText('できません');
  await expect(page.getByTestId('play-toggle')).toBeDisabled();
  await page.getByRole('button', { name: /読み込み失敗後の資料/ }).click();
  await expectTextOnlyDocument(page, '読み込み失敗後の資料');
  await expect(page.getByTestId('progress-recovery')).toHaveCount(0);
  // No write was possible, so logout must not claim an unsaved resume point.
  const unexpectedDialogs: string[] = [];
  page.on('dialog', async dialog => { unexpectedDialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('ユーザー名', { exact: true })).toBeVisible();
  expect(unexpectedDialogs).toEqual([]);
  await login(page);
});

test('confirmed source deletion retires failed position recovery and ignores a late missing-parent write', async ({ page }) => {
  const document = await demo(page);
  const endpoint = `/api/audio/${document.audio_versions[0].id}/progress/`;
  const other = await page.request.post('/api/documents/', { headers: { 'X-CSRFToken': await csrf(page) }, data: { title: '削除確認用の次の資料', text: '削除後に開く資料。' } });
  expect(other.status()).toBe(201);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  let phase: 'fail' | 'hold' = 'fail';
  let lateStarted = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let lateCompleted!: () => void;
  const lateFinished = new Promise<void>(resolve => { lateCompleted = resolve; });
  const state = diagnostics.get(page)!;
  state.expectedNetworkFailures.add(endpoint);
  await page.route(`**${endpoint}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    if (phase === 'fail') return route.abort('failed');
    lateStarted = true;
    await held;
    const response = await route.fetch();
    expect(response.status()).toBe(404);
    await route.fulfill({ response });
    lateCompleted();
  });
  await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => { element.currentTime = 28; });
  await expect(page.getByTestId('progress-status')).toContainText('できません');
  await page.getByRole('button', { name: /削除確認用の次の資料/ }).click();
  await expect(page.getByTestId('progress-recovery')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(document.title) }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  phase = 'hold';
  await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => { element.currentTime = 38; });
  await expect.poll(() => lateStarted).toBe(true);
  await page.getByText('資料の本文', { exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  const deleted = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/`) && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: '資料と関連する録音を削除' }).click();
  expect((await deleted).status()).toBe(204);
  await expect(page.getByTestId('status')).toContainText('資料を削除しました');
  await expect(page.getByTestId('progress-recovery')).toHaveCount(0);
  const errorMark = state.errors.length;
  release();
  await lateFinished;
  await page.getByRole('button', { name: /削除確認用の次の資料/ }).click();
  await expectTextOnlyDocument(page, '削除確認用の次の資料');
  await expect(page.getByTestId('progress-recovery')).toHaveCount(0);
  // A confirmed deleted parent must not leave an impossible retry/logout warning.
  const unexpectedDialogs: string[] = [];
  page.on('dialog', async dialog => { unexpectedDialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('ユーザー名', { exact: true })).toBeVisible();
  expect(unexpectedDialogs).toEqual([]);
  state.errors.splice(errorMark, state.errors.length - errorMark, ...state.errors.slice(errorMark).filter(error => !error.includes('404')));
  await login(page);
});

test('physical desktop microphone records and persists through reload', async ({ page }, testInfo) => {
  test.skip(process.env.LC_E2E_REAL_MIC !== '1', 'Explicit separate hardware test; normal E2E uses a fake microphone.');
  await demo(page);
  const { memo } = await recordedMemo(page);
  const tracks = await page.evaluate(() => (window as Window & { __lcTestStreams: MediaStream[] }).__lcTestStreams.flatMap(s => s.getAudioTracks()).map(t => ({ label: t.label, state: t.readyState })));
  expect(tracks.length).toBeGreaterThan(0);
  expect(tracks.every(t => t.label && !/fake|synthetic/i.test(t.label))).toBe(true);
  expect(tracks.every(t => t.state === 'ended')).toBe(true);
  const evidence = JSON.stringify({ tracks, memoDurationMs: memo.duration_ms, source: 'physical microphone, not fake device; intelligibility not assessed' }, null, 2);
  const evidencePath = testInfo.outputPath('microphone-device.json');
  await writeFile(evidencePath, evidence);
  await testInfo.attach('microphone-device', { path: evidencePath, contentType: 'application/json' });
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(page.getByTestId('memo-card')).toHaveCount(1);
  expect((await page.request.get(memo.media_url)).status()).toBe(200);
});

test('real recording persists, resumes, reviews, edits, returns to its anchor and deletes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const document = await demo(page);
  await expect(page.getByTestId('record-toggle')).toBeInViewport({ ratio: 1 });
  const { memo, anchor } = await recordedMemo(page);
  await page.screenshot({ path: testInfo.outputPath('desktop-after-recording.png'), fullPage: true });
  expect(memo.document.id).toBe(document.id);
  expect(Math.abs(memo.position_ms - anchor)).toBeLessThan(150);
  expect(memo.duration_ms).toBeGreaterThan(900);
  expect((await memos(page)).map(item => item.id)).toEqual([memo.id]);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as Window & { __lcTestStreams: MediaStream[] }).__lcTestStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  const recent = page.getByTestId('recent-memo');
  await expect(recent).toContainText('サーバー保存済み');
  await recent.getByLabel('直前に保存した録音を聴き直す').evaluate((audio: HTMLAudioElement) => audio.play());
  await expect.poll(() => recent.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  expect(await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await recent.getByRole('button', { name: '教材を再開', exact: true }).click();
  await expect.poll(() => recent.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await recent.getByRole('button', { name: 'メモを開く' }).click();
  const card = page.getByTestId('memo-card');
  await expect(card).toHaveCount(1);
  const memoAudio = card.locator('audio');
  await memoAudio.evaluate((audio: HTMLAudioElement) => audio.play());
  await expect.poll(() => memoAudio.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  expect(await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await card.getByLabel('メモ', { exact: true }).fill('トランザクションと接続の違いを調べる。');
  await card.getByRole('button', { name: '文章を保存' }).click();
  await expect(page.getByTestId('status')).toContainText('文章メモを保存しました');
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(page.getByTestId('memo-card').locator('textarea')).toHaveValue('トランザクションと接続の違いを調べる。');
  await page.getByRole('button', { name: '元の位置へ戻る' }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect.poll(async () => Math.abs(await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000) - memo.position_ms)).toBeLessThan(150);
  await page.getByRole('button', { name: /声のメモ/ }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByTestId('memo-card').getByRole('button', { name: '削除', exact: true }).click();
  await expect(page.getByTestId('memo-card')).toHaveCount(0);
  await page.getByRole('button', { name: '聴く', exact: true }).click();
  await expect(page.getByTestId('recent-memo')).toHaveCount(0);
  expect((await page.request.get(memo.media_url)).status()).toBe(404);
});

test('recording can be stopped with the keyboard after repeated source-media errors', async ({ page }) => {
  const document = await demo(page);
  const source = page.getByTestId('source-audio');
  const stop = page.getByTestId('record-toggle');
  await source.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 12; });
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await stop.click();
  await expect(stop).toHaveText('録音を終了');
  const anchor = await source.evaluate((audio: HTMLAudioElement) => Math.floor(audio.currentTime * 1000));
  await page.waitForTimeout(1200); // Real fake-device MediaRecorder bytes, not a hand-built upload.
  for (let index = 0; index < 3; index++) {
    await source.evaluate(audio => audio.dispatchEvent(new Event('error')));
    await expect(page.getByRole('alert').filter({ hasText: '音声の区間を読み込めません' })).toBeVisible();
    await expect(stop).toBeEnabled();
  }
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await stop.focus();
  await page.keyboard.press('Space');
  const response = await accepted;
  expect(response.status()).toBe(201);
  const memo = await response.json() as Memo;
  expect(memo.document.id).toBe(document.id);
  expect(memo.audio_version).toBe(document.audio_versions[0].id);
  // Match the existing capture check: the DOM clock is sampled just after the
  // controller freezes its position, so allow the same 150 ms sampling margin.
  expect(Math.abs(memo.position_ms - anchor)).toBeLessThan(150);
  expect((await memos(page)).map(item => item.client_id)).toEqual([memo.client_id]);
  await expect(page.getByTestId('recent-memo')).toContainText('サーバー保存済み');
  await expect(stop).toHaveText('メモする');
  await expect.poll(() => page.evaluate(() => (window as Window & { __lcTestStreams: MediaStream[] }).__lcTestStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  expect(await pendingMetadata(page)).toEqual([]);
});

test('Japanese text is stored honestly without fake TTS, with mobile and desktop layouts', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill('データベースを学ぶ');
  const text = 'データベースのトランザクションを復習する。\n<script>window.shouldNeverRun = true</script>';
  await page.getByLabel('資料のテキスト').fill(text);
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  await expectTextOnlyDocument(page, 'データベースを学ぶ');
  await expect(page.getByTestId('record-toggle')).toHaveCount(0);
  if (process.env.LC_E2E_EXPECT_FIXTURE === '1' && process.env.LC_LOCAL_WINDOWS_TTS !== '1') {
    await expect(page.locator('.narration-panel')).toContainText('本文を読み上げた結果ではありません');
    await expect(page.locator('.narration-panel')).not.toContainText('原文をそのまま読み上げます');
  }
  await page.getByText('資料の本文', { exact: true }).click();
  await expect(page.locator('.source-text p').last()).toHaveText(text);
  expect(await page.evaluate(() => (window as Window & { shouldNeverRun?: boolean }).shouldNeverRun)).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: /データベースを学ぶ/ }).click();
  await expectTextOnlyDocument(page, 'データベースを学ぶ');
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`library-${viewport.width}.png`), fullPage: true });
  }
});

test('another authenticated account cannot see or mutate document, audio or memo', async ({ page, browser }, testInfo) => {
  const document = await demo(page);
  const { memo } = await recordedMemo(page);
  const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
  await installLoginPacing(other);
  try {
    const bob = await other.newPage();
    await login(bob, 'BOB');
    await expect(bob.getByRole('button', { name: /Listen \/ Capture — 再生・録音デモ/ })).toHaveCount(0);
    for (const path of [`/api/documents/${document.id}/`, document.audio_versions[0].media_url, `/api/memos/${memo.id}/`, memo.media_url, `/api/memos/?document=${document.id}`]) {
      expect((await other.request.get(path)).status()).toBe(404);
    }
    expect(await (await other.request.get('/api/memos/')).json()).toEqual([]);
    const token = await csrf(bob);
    const mutated = await other.request.patch(`/api/memos/${memo.id}/`, { headers: { 'X-CSRFToken': token }, data: { text: '不正な編集' } });
    expect(mutated.status()).toBe(404);
    const audioBytes = await (await page.request.get(memo.media_url)).body();
    const forged = await other.request.post('/api/memos/', { headers: { 'X-CSRFToken': token }, multipart: {
      client_id: randomUUID(), audio_version: memo.audio_version, position_ms: '1', duration_ms: '1000', text: '',
      audio: { name: 'recording.webm', mimeType: 'audio/webm', buffer: audioBytes },
    } });
    expect(forged.status()).toBe(404);
    expect((await memos(page))[0].text).toBe('');
  } finally { await other.close(); }
});

test('failed upload survives reload, stays hidden from another account, then retries', async ({ page }, testInfo) => {
  await demo(page);
  diagnostics.get(page)!.expectedNetworkFailures.add('/api/memos/');
  await page.route('**/api/memos/', failMemoUpload);
  await record(page);
  await expect(page.getByTestId('pending-memo')).toContainText('端末内に一時保存済み / サーバー保存は未確認');
  await expect(page.getByTestId('recent-memo')).toHaveCount(0);
  const preview = page.getByTestId('pending-memo').locator('audio');
  await preview.evaluate((audio: HTMLAudioElement) => audio.play());
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  expect(await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-unsent-recording.png'), fullPage: true });
  const pending = await pendingMetadata(page);
  expect(pending).toHaveLength(1); expect(pending[0].blobBytes).toBeGreaterThan(100);
  expect(await memos(page)).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('pending-memo')).toHaveCount(1);
  await preview.evaluate((audio: HTMLAudioElement) => audio.play());
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
  const bob = credentials('BOB');
  await page.getByLabel('ユーザー名', { exact: true }).fill(bob.username);
  await page.getByLabel('パスワード', { exact: true }).fill(bob.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
  expect(await pendingMetadata(page)).toEqual(pending);
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
  await login(page);
  await expect(page.getByTestId('pending-memo')).toHaveCount(1);
  await expect(page.getByTestId('recent-memo')).toHaveCount(0);
  await page.unroute('**/api/memos/', failMemoUpload);
  await page.getByRole('button', { name: '保存を再試行' }).click();
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
  expect((await memos(page)).map(memo => memo.client_id)).toEqual([pending[0].clientId]);
  expect(await pendingMetadata(page)).toEqual([]);
});

test('server commit followed by a lost response is retried without duplicate memo', async ({ page }) => {
  await demo(page);
  diagnostics.get(page)!.expectedNetworkFailures.add('/api/memos/');
  let firstMemo: Memo | undefined;
  await page.route('**/api/memos/', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const committed = await route.fetch();
    expect(committed.status()).toBe(201);
    firstMemo = await committed.json() as Memo;
    await route.abort('failed');
  });
  await record(page);
  await expect(page.getByTestId('pending-memo')).toHaveCount(1);
  await expect(page.getByTestId('recent-memo')).toHaveCount(0);
  expect(firstMemo).toBeDefined();
  expect((await memos(page)).map(memo => memo.id)).toEqual([firstMemo!.id]);
  await page.unroute('**/api/memos/');
  const retry = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存を再試行' }).click();
  const replay = await retry;
  expect(replay.status()).toBe(200);
  expect((await replay.json()).id).toBe(firstMemo!.id);
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
  expect((await memos(page)).map(memo => memo.id)).toEqual([firstMemo!.id]);
});

test('server acknowledgment resumes the lesson even while memo list refresh is unavailable', async ({ page }) => {
  await demo(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  diagnostics.get(page)!.expectedNetworkFailures.add('/api/memos/');
  await page.route('**/api/memos/', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await held;
    return route.abort('failed').catch(() => {});
  });
  try {
    await page.getByTestId('play-toggle').click();
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
    await page.waitForTimeout(1200);
    const acknowledged = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
    await page.getByTestId('record-toggle').click();
    expect((await acknowledged).status()).toBe(201);
    // List availability must not extend the critical path after the save acknowledgment.
    await expect(page.getByTestId('record-toggle')).toHaveText('メモする', { timeout: 3000 });
    await expect.poll(() => page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused), { timeout: 3000 }).toBe(false);
    await page.getByTestId('recent-memo').getByRole('button', { name: 'メモを開く' }).click();
    await expect(page.getByTestId('memo-card')).toHaveCount(1);
  } finally { release(); }
});

test('media session playback resumes the lesson after an unsent preview is acknowledged and removed', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      if (action === 'play') (window as Window & { __lcPlayAction?: MediaSessionActionHandler }).__lcPlayAction = handler ?? undefined;
      original(action, handler);
    };
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
  await demo(page);
  diagnostics.get(page)!.expectedNetworkFailures.add('/api/memos/');
  await page.route('**/api/memos/', failMemoUpload);
  await record(page);
  const preview = page.getByTestId('pending-memo').locator('audio');
  await preview.evaluate((audio: HTMLAudioElement) => {
    (window as Window & { __lcRemovedPreview?: HTMLAudioElement }).__lcRemovedPreview = audio;
    audio.loop = true;
    return audio.play();
  });
  await expect.poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  await page.unroute('**/api/memos/', failMemoUpload);
  await page.getByRole('button', { name: '保存を再試行', exact: true }).click();
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const audio = (window as Window & { __lcRemovedPreview?: HTMLAudioElement }).__lcRemovedPreview!;
    return !audio.isConnected && audio.paused;
  })).toBe(true);
  await page.evaluate(() => {
    const action = (window as Window & { __lcPlayAction?: MediaSessionActionHandler }).__lcPlayAction;
    if (!action) throw new Error('The app must install the MediaSession play action');
    action({ action: 'play' });
  });
  await expect.poll(() => page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.paused), { timeout: 3000 }).toBe(false);
});

test('autoplay rejection preserves the saved recording and offers manual resume', async ({ page }) => {
  await demo(page);
  const source = page.getByTestId('source-audio');
  const response = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await record(page, () => source.evaluate((audio: HTMLAudioElement) => {
    Object.defineProperty(audio, 'play', { configurable: true, value: () => Promise.reject(new DOMException('Injected autoplay rejection', 'NotAllowedError')) });
  }));
  expect((await response).status()).toBe(201);
  expect(await memos(page)).toHaveLength(1);
  await expect(page.getByTestId('status')).toContainText('再生ボタンをタップして');
  expect(await source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await source.evaluate((audio: HTMLAudioElement) => { Reflect.deleteProperty(audio, 'play'); });
  await page.getByTestId('recent-memo').getByRole('button', { name: '教材を再開' }).click();
  await expect.poll(() => source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
});

test('microphone preparation can be cancelled and late permission does not record; keyboard retry succeeds', async ({ page }) => {
  await demo(page);
  const source = page.getByTestId('source-audio');
  await source.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 21; });
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const testing = window as Window & { __lcGrantPermission: () => void; __lcRestorePermission: () => void };
    navigator.mediaDevices.getUserMedia = constraints => new Promise((resolve, reject) => {
      testing.__lcGrantPermission = () => { void original(constraints).then(resolve, reject); };
    });
    testing.__lcRestorePermission = () => { navigator.mediaDevices.getUserMedia = original; };
  });
  const recordButton = page.getByTestId('record-toggle');
  await recordButton.focus();
  await page.keyboard.press('Space');
  await expect(recordButton).toHaveText('マイクを準備中…');
  await expect(page.getByRole('slider', { name: '再生位置' })).toBeDisabled();
  await page.getByRole('button', { name: '準備をキャンセル', exact: true }).click();
  await expect(recordButton).toHaveText('メモする');
  await page.evaluate(() => {
    const testing = window as Window & { __lcGrantPermission: () => void; __lcRestorePermission: () => void };
    testing.__lcRestorePermission(); testing.__lcGrantPermission();
  });
  await expect.poll(() => page.evaluate(() => {
    const streams = (window as Window & { __lcTestStreams: MediaStream[] }).__lcTestStreams;
    return streams.length > 0 && streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
  })).toBe(true);
  expect(await source.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(21);
  expect(await memos(page)).toEqual([]);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await recordButton.focus(); await page.keyboard.press('Space');
  await expect(recordButton).toHaveText('録音を終了');
  await page.waitForTimeout(1200);
  await recordButton.focus(); await page.keyboard.press('Space');
  expect((await saved).status()).toBe(201);
  await expect(page.getByTestId('recent-memo')).toContainText('サーバー保存済み');
  expect(await memos(page)).toHaveLength(1);
});

test('an unfinished recording requires explicit discard and late final events do not save it', async ({ page }, testInfo) => {
  await demo(page);
  // Keep Chromium's real encoder, but hold its final data/stop callbacks. This
  // is an artificial browser-delivery stall, not a measured Safari behavior.
  await page.evaluate(() => {
    const NativeRecorder = window.MediaRecorder;
    const delayed: (() => void)[] = [];
    class HeldFinalRecorder extends NativeRecorder {
      holdingFinal = false;
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        const listen = this.addEventListener.bind(this);
        this.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (!listener || !['dataavailable', 'stop'].includes(type)) return listen(type, listener, options);
          listen(type, event => {
            const deliver = () => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
            if (this.holdingFinal) delayed.push(deliver);
            else deliver();
          }, options);
        }) as MediaRecorder['addEventListener'];
      }
      override stop() {
        this.holdingFinal = true;
        super.stop();
      }
    }
    window.MediaRecorder = HeldFinalRecorder;
    Object.assign(window, {
      __lcHeldFinalCount: () => delayed.length,
      __lcReleaseFinal: () => delayed.splice(0).forEach(deliver => deliver()),
      __lcRestoreRecorder: () => { window.MediaRecorder = NativeRecorder; },
    });
  });
  let uploads = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/memos/')) uploads++;
  });
  const stop = page.getByTestId('record-toggle');
  const discard = page.getByTestId('record-discard');
  await stop.click();
  await expect(stop).toHaveText('録音を終了');
  await expect(discard).toHaveCount(0);
  await page.waitForTimeout(1200);
  await stop.click();
  await expect(stop).toHaveText('録音を終了しています…');
  await expect(stop).toBeDisabled();
  await expect(discard).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as Window & { __lcHeldFinalCount: () => number }).__lcHeldFinalCount())).toBeGreaterThanOrEqual(2);
  await page.setViewportSize({ width: 390, height: 844 });
  // Resizing reflows the layout: return to the control the user just pressed,
  // rather than scrolling directly to the newly offered destructive action.
  await stop.scrollIntoViewIfNeeded();
  await expect(stop).toBeInViewport({ ratio: 1 });
  await expect(discard).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('finishing-390x844.png'), fullPage: false });
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('復元できません');
    await dialog.dismiss();
  });
  await discard.click();
  await expect(stop).toHaveText('録音を終了しています…');
  expect(uploads).toBe(0);
  page.once('dialog', dialog => dialog.accept());
  await discard.click();
  await expect(stop).toHaveText('メモする');
  await expect(discard).toHaveCount(0);
  await expect(page.getByTestId('status')).toContainText('破棄しました');
  await expect.poll(() => page.evaluate(() => (window as Window & { __lcTestStreams: MediaStream[] }).__lcTestStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await page.evaluate(() => {
    const hooks = window as Window & { __lcReleaseFinal: () => void; __lcRestoreRecorder: () => void };
    hooks.__lcRestoreRecorder();
    hooks.__lcReleaseFinal();
  });
  expect(uploads).toBe(0);
  expect(await memos(page)).toEqual([]);
  expect(await pendingMetadata(page)).toEqual([]);
  await expect(page.getByTestId('recent-memo')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  let releaseUpload!: () => void;
  const heldUpload = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/memos/', async route => {
    if (route.request().method() === 'POST') await heldUpload;
    await route.continue();
  });
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  const recording = record(page);
  try {
    await expect(page.getByTestId('upload-status')).toBeVisible();
    await expect(stop).toHaveText('保存しています…');
    await expect(stop).toBeDisabled();
    await expect(discard).toHaveCount(0); // A real upload must never offer local discard.
  } finally {
    releaseUpload();
    await recording;
    await page.unroute('**/api/memos/');
  }
  const response = await accepted;
  expect(response.status()).toBe(201);
  const memo = await response.json() as Memo;
  expect(uploads).toBe(1);
  expect((await memos(page)).map(item => item.id)).toEqual([memo.id]);
});

test('microphone rejection keeps the source anchor and never claims a saved memo', async ({ page }) => {
  await demo(page);
  const source = page.getByTestId('source-audio');
  await source.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 17; });
  await page.getByTestId('play-toggle').click();
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Injected permission denial', 'NotAllowedError')); });
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('status')).toContainText('マイクを使えません');
  expect(await source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  expect(await source.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThanOrEqual(17);
  expect(await memos(page)).toEqual([]);
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
});

test('reselecting an already loaded document keeps playback and recording available', async ({ page }) => {
  const document = await demo(page);
  const source = page.getByTestId('source-audio');
  const choice = page.locator('.document-choice').filter({ hasText: document.title });
  await source.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 24; });
  await choice.click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  await expect(page.getByRole('slider', { name: '再生位置' })).toBeEnabled();
  expect(await source.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(24, 1);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  // Re-select once more during playback: no new metadata event is required to
  // keep the already loaded source usable while retaining the current position.
  await choice.click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  expect(await source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
});

async function createText(page: Page, title: string, text: string): Promise<Document> {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill(title);
  await page.getByLabel('資料のテキスト').fill(text);
  const response = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  return saved.json();
}

async function requireFixture(page: Page) {
  const response = await page.request.get('/api/session/');
  const state = await response.json();
  if (process.env.LC_E2E_EXPECT_FIXTURE === '1') {
    expect(state.tts?.enabled).toBe(true);
    expect(state.tts?.provider).toBe('fixture');
  }
  test.skip(state.tts?.provider !== 'fixture' || !state.tts.enabled, 'Requires isolated, explicitly labeled fixture environment.');
}

test('opening a recent memo replaces another-document filter without losing its draft', async ({ page }) => {
  await requireFixture(page);
  const other = await createText(page, '別の教材 — 合成テスト', '別の教材に残した、まだ保存していない考え。');
  await page.getByTestId('narration-generate').click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 20_000 });
  const generated = await (await page.request.get(`/api/documents/${other.id}/`)).json() as Document;
  expect(generated.audio_versions[0].kind).toBe('fixture');
  // Existing deterministic outbox seed uses this account and its real audio
  // version. Its ordinary retry passes the API's owner/UUID/file validation.
  await seedPcmOutbox(page, generated);
  const savedOther = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.getByTestId('pending-memo').getByRole('button', { name: '保存を再試行' }).click();
  expect((await savedOther).status()).toBe(201);
  await page.getByRole('button', { name: /声のメモ/ }).click();
  const filter = page.getByLabel('資料で絞り込む', { exact: true });
  await filter.selectOption(other.id);
  const draft = '別の教材の補足は、一覧の移動でも消さない。';
  await page.getByTestId('memo-card').getByLabel('メモ', { exact: true }).fill(draft);
  await page.getByRole('button', { name: '聴く', exact: true }).click();
  const document = await demo(page);
  expect(document.id).not.toBe(other.id);
  const { memo } = await recordedMemo(page);
  await page.getByTestId('recent-memo').getByRole('button', { name: 'メモを開く' }).click();
  await expect(filter).toHaveValue(document.id);
  const recentCard = page.getByTestId('memo-card');
  await expect(recentCard).toHaveCount(1);
  await expect(recentCard.locator('audio')).toHaveAttribute('src', memo.media_url);
  await expect(recentCard.getByLabel('メモ', { exact: true })).toBeVisible();
  await filter.selectOption(other.id);
  await expect(page.getByTestId('memo-card')).toHaveCount(1);
  await expect(page.getByTestId('memo-card').getByLabel('メモ', { exact: true })).toHaveValue(draft);
  // Finish this test-owned draft before normal navigation-based cleanup.
  await page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true }).click();
  await expect(page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true })).toHaveCount(0);
});

test('Japanese TTS request completes through the worker with an honest silent-fixture label and no autoplay', async ({ page }) => {
  await requireFixture(page);
  const original = 'トランザクションは、複数の処理をひとまとまりとして扱います。';
  const document = await createText(page, '日本語の読み上げ準備', original);
  const response = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/narration/`) && response.request().method() === 'POST');
  await page.getByTestId('narration-generate').click();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  const job = await accepted.json();
  expect(job.document_version).toBe(document.current_version.id);
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByText('テスト用無音音声（本文の合成ではありません）', { exact: false })).toBeVisible();
  const fresh = await (await page.request.get(`/api/documents/${document.id}/`)).json() as Document;
  expect(fresh.current_version.text).toBe(original);
  expect((await (await page.request.get(`/api/narrations/${job.id}/`)).json()).state).toBe('succeeded');
  expect(fresh.audio_versions).toHaveLength(1);
  expect(fresh.audio_versions[0].kind).toBe('fixture');
  const audio = page.getByTestId('source-audio');
  expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  const bytes = await page.request.get(fresh.audio_versions[0].media_url, { headers: { Range: 'bytes=0-43' } });
  expect(bytes.status()).toBe(206);
  expect(bytes.headers()['content-type'].split(';')[0]).toBe('audio/mpeg');
  const header = await bytes.body();
  expect(header.subarray(0, 3).toString() === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)).toBe(true);
  const decoded = await inspectGeneratedAudio(page, fresh.audio_versions[0].media_url);
  expect(decoded.contentType).toBe('audio/mpeg');
  expect(decoded.sampleRate).toBe(16000);
  expect(decoded.channels).toBe(1);
  expect(decoded.decodedFrames).toBe(48000);
  expect(decoded.decodedDurationMs).toBe(3000);
  expect(Math.abs(decoded.mediaDurationMs - decoded.decodedDurationMs)).toBeLessThan(1);
  expect(decoded.rms).toBe(0); // An intentionally silent fixture, never Japanese speech.
  expect(decoded.encodedBytes).toBeLessThan(48000 * 2 + 44);
});

test('TTS request keys reuse the same job, foreign users are denied, and old audio keeps its version', async ({ page, browser }, testInfo) => {
  await requireFixture(page);
  const document = await createText(page, '版を保つ音声', '保存した思考と元の資料を結び付けます。');
  const token = await csrf(page);
  const clientId = randomUUID();
  const endpoint = `/api/documents/${document.id}/audio-generation/`;
  const request = { headers: { 'X-CSRFToken': token }, data: { document_version: document.current_version.id, client_id: clientId } };
  const first = await page.request.post(endpoint, request);
  expect(first.status()).toBe(202);
  const job = await first.json();
  const replay = await page.request.post(endpoint, request);
  expect(replay.status()).toBe(200);
  expect((await replay.json()).id).toBe(job.id);
  await expect.poll(async () => (await (await page.request.get(`/api/audio-generations/${job.id}/`)).json()).state).toBe('succeeded');
  const original = await (await page.request.get(`/api/documents/${document.id}/`)).json() as Document;
  expect(original.audio_versions).toHaveLength(1);
  const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
  await installLoginPacing(other);
  try {
    const bob = await other.newPage();
    await login(bob, 'BOB');
    expect((await other.request.get(`/api/audio-generations/${job.id}/`)).status()).toBe(404);
    const forged = await other.request.post(endpoint, { headers: { 'X-CSRFToken': await csrf(bob) }, data: request.data });
    expect(forged.status()).toBe(404);
  } finally { await other.close(); }
  const edited = await page.request.patch(`/api/documents/${document.id}/`, { headers: { 'X-CSRFToken': token }, data: { text: '本文を編集しても、過去の音声を別の資料へ付け替えません。' } });
  expect(edited.status()).toBe(200);
  const newer = await edited.json() as Document;
  expect(newer.current_version.id).not.toBe(document.current_version.id);
  expect(newer.audio_generation).toBeNull();
  expect(newer.audio_versions[0].document_version).toBe(document.current_version.id);
  expect((await page.request.get(original.audio_versions[0].media_url)).status()).toBe(200);
  await page.reload();
  await page.locator('.document-choice').filter({ hasText: document.title }).click();
  await expect(page.getByTestId('narration-generate')).toBeEnabled();
  await expect(page.getByTestId('play-toggle')).toHaveCount(0);
});

test('a memo returns to its original audio and text after revision, with context failure recovery', async ({ page }) => {
  const document = await demo(page);
  const { memo } = await recordedMemo(page);
  const updatedText = 'これは改訂後の本文です。保存したメモの元の文脈ではありません。';
  const edited = await page.request.patch(`/api/documents/${document.id}/`, {
    headers: { 'X-CSRFToken': await csrf(page) }, data: { text: updatedText },
  });
  expect(edited.status()).toBe(200);
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  const contextPath = `/api/documents/${document.id}/versions/${document.current_version.id}/`;
  diagnostics.get(page)!.expectedNetworkFailures.add(contextPath);
  await page.route(`**${contextPath}`, route => route.abort('failed'));
  await page.getByRole('button', { name: '元の位置へ戻る' }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect.poll(async () => Math.abs(await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000) - memo.position_ms)).toBeLessThan(150);
  await expect(page.getByRole('alert')).toContainText('音声に対応する本文を読み込めません');
  await expect(page.getByText(updatedText, { exact: true })).toHaveCount(0);
  await page.unroute(`**${contextPath}`);
  await page.getByRole('button', { name: '本文の読み込みを再試行' }).click();
  await expect(page.getByTestId('source-context')).toHaveText(document.current_version.text);
  await expect(page.getByText('資料 v1 · 音声に対応する本文', { exact: true })).toBeVisible();
  await expect(page.getByText(updatedText, { exact: true })).toHaveCount(0);
});

test('legacy TTS still rejects its over-limit document while the segmented UI accepts long text', async ({ page }) => {
  await requireFixture(page);
  const document = await createText(page, '長い資料', 'あ'.repeat(3001));
  await expect(page.getByTestId('narration-generate')).toBeEnabled();
  const response = await page.request.post(`/api/documents/${document.id}/audio-generation/`, {
    headers: { 'X-CSRFToken': await csrf(page) }, data: { document_version: document.current_version.id, client_id: randomUUID() },
  });
  expect(response.status()).toBe(400);
  const saved = await (await page.request.get(`/api/documents/${document.id}/`)).json();
  expect(saved.audio_generation).toBeNull();
  expect(saved.audio_versions).toEqual([]);
});

async function seedPcmOutbox(page: Page, document: Document) {
  const account = await (await page.request.get('/api/session/')).json();
  const clientId = randomUUID();
  // Deterministic, valid one-second PCM WAV. This is a synthetic transfer fixture,
  // distinct from the real MediaRecorder encoder used by the original eight tests.
  await page.evaluate(({ userId, clientId, document }) => new Promise<void>((resolve, reject) => {
    const bytes = new ArrayBuffer(44 + 48000 * 2);
    const view = new DataView(bytes);
    const ascii = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
    ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, 96000, true);
    const blob = new Blob([bytes], { type: 'audio/wav' });
    const request = indexedDB.open('listen-capture-outbox-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('recordings', 'readwrite');
      tx.objectStore('recordings').put({ clientId, userId, documentId: document.id, documentTitle: document.title,
        audioVersion: document.audio_versions[0].id, positionMs: 1234, durationMs: 1000, blob, text: '', createdAt: new Date().toISOString() });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
    };
  }), { userId: account.user.id, clientId, document });
  await page.reload();
  await expect(page.getByTestId('pending-memo')).toHaveCount(1);
  return clientId;
}

test('a real throttled upload lasting longer than 20 seconds succeeds with the same outbox UUID', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const document = await demo(page);
  const clientId = await seedPcmOutbox(page, document);
  const network = await context.newCDPSession(page);
  await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 4096 });
  const started = Date.now();
  try {
    await page.getByRole('button', { name: '保存を再試行' }).click();
    await expect(page.getByTestId('upload-cancel')).toBeVisible();
    await expect(page.getByTestId('pending-memo')).toHaveCount(0, { timeout: 65_000 });
    const elapsedMs = Date.now() - started;
    expect(elapsedMs).toBeGreaterThan(20_000);
    const saved = await memos(page);
    expect(saved.map(item => item.client_id)).toEqual([clientId]);
    expect(saved[0].position_ms).toBe(1234);
    expect(await pendingMetadata(page)).toEqual([]);
    await testInfo.attach('throttled-transfer.json', { body: JSON.stringify({ fixture: 'PCM WAV 96044 bytes', uploadBytesPerSecond: 4096, elapsedMs }), contentType: 'application/json' });
  } finally {
    await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await network.detach();
  }
});

test('cancelling a committed-but-unconfirmed upload keeps the blob and retry does not duplicate it', async ({ page }) => {
  const document = await demo(page);
  const clientId = await seedPcmOutbox(page, document);
  diagnostics.get(page)!.expectedNetworkFailures.add('/api/memos/');
  let original: Memo | undefined;
  let releaseResponse!: () => void;
  const held = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route('**/api/memos/', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    original = await response.json() as Memo;
    await held;
    await route.abort('failed').catch(() => {});
  });
  try {
    await page.getByRole('button', { name: '保存を再試行' }).click();
    await expect.poll(() => original?.id).toBeTruthy();
    await page.getByTestId('upload-cancel').click();
    await expect(page.getByRole('button', { name: '保存を再試行' })).toBeEnabled();
    expect((await pendingMetadata(page))[0].clientId).toBe(clientId);
  } finally { releaseResponse(); }
  await page.unroute('**/api/memos/');
  const retry = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存を再試行' }).click();
  const response = await retry;
  expect(response.status()).toBe(200);
  expect((await response.json()).id).toBe(original!.id);
  await expect(page.getByTestId('pending-memo')).toHaveCount(0);
  expect((await memos(page)).map(item => item.id)).toEqual([original!.id]);
});
