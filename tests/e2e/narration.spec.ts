import { expect, test, type Page } from './fixtures/accounts';
import { numberedPdf } from './fixtures/pdf';
import { inspectGeneratedAudio } from './fixtures/generated-audio';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}
async function csrf(page: Page) { return (await (await page.request.get('/api/session/')).json()).csrfToken; }
async function create(page: Page, text: string) {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill('長い日本語の学習資料');
  await page.getByLabel('資料のテキスト', { exact: true }).fill(text);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201); return response.json();
}
test.beforeEach(async ({ page }) => { await login(page); });
test.afterEach(async ({ page }) => {
  await page.goto('about:blank'); const token = await csrf(page);
  for (const doc of await (await page.request.get('/api/documents/')).json()) expect((await page.request.delete(`/api/documents/${doc.id}/`, { headers: { 'X-CSRFToken': token } })).status()).toBe(204);
});

test('selected PDF pages to long Japanese audio, segment seek, speed, microphone memo and old-version context', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  test.skip(process.env.LC_LOCAL_WINDOWS_TTS === '1', 'Deterministic fixture flow; real Windows voice has a separate opt-in case.');
  const original = ('HTTPの応答を確認します。🌸データベースの変更を安全に確定します。\n').repeat(105);
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByLabel('PDFファイル').setInputFiles({ name: 'lesson.pdf', mimeType: 'application/pdf', buffer: numberedPdf(60) });
  await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
  await expect(page.getByLabel('開始ページ')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('開始ページ').fill('52');
  await page.getByLabel('終了ページ').fill('54');
  await page.getByRole('button', { name: '選んだページを抽出' }).click();
  await expect(page.getByLabel('読み上げる本文')).toHaveValue(/ONLY_PAGE_052/, { timeout: 30_000 });
  expect(await page.getByLabel('読み上げる本文').inputValue()).not.toContain('ONLY_PAGE_051');
  await page.getByLabel('読み上げる本文').fill(original);
  await page.getByLabel('読み順と本文を確認しました').check();
  const confirmed = page.waitForResponse(response => response.url().endsWith('/confirm/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '本文を確定して保存', exact: true }).click();
  const confirmation = await confirmed; expect(confirmation.status()).toBe(201); const doc = await confirmation.json();
  expect(doc.source_pdf).toMatchObject({ start_page: 52, end_page: 54, page_count: 60, selection_revision: 1 });
  const accepted = page.waitForResponse(response => response.url().endsWith(`/documents/${doc.id}/narration/`) && response.request().method() === 'POST');
  await page.getByTestId('narration-generate').click();
  const acceptance = await accepted; expect(acceptance.status()).toBe(202); const job = await acceptance.json();
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 30_000 });
  const fresh = await (await page.request.get(`/api/documents/${doc.id}/`)).json(); const audio = fresh.audio_versions[0];
  const map = await (await page.request.get(`/api/audio/${audio.id}/narration-map/`)).json();
  expect(map.precision).toBe('segment'); expect(map.segments.length).toBeGreaterThan(1);
  expect(map.segments[0].start_offset).toBe(0); expect(map.segments.at(-1).end_offset).toBe(Array.from(original).length);
  expect((await (await page.request.get(`/api/narrations/${job.id}/`)).json()).completed_segments).toBe(map.segments.length);
  await page.getByLabel('再生速度', { exact: true }).selectOption('1.5');
  await page.getByLabel('音声の区間', { exact: true }).selectOption('1');
  await page.getByText('資料の本文', { exact: true }).click();
  await expect(page.getByTestId('active-source-block').first()).toBeVisible();
  await expect(page.getByTestId('source-context')).toHaveText(original);
  const player = page.getByTestId('source-audio');
  expect(await player.evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
  await page.getByTestId('play-toggle').click();
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  expect(await player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await expect(page.getByLabel('音声の区間', { exact: true })).toBeDisabled();
  const save = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.waitForTimeout(1200); await page.getByTestId('record-toggle').click();
  const saved = await save; expect(saved.status()).toBe(201); const memo = await saved.json();
  expect(memo.audio_version).toBe(audio.id); expect(memo.position_ms).toBeGreaterThanOrEqual(map.segments[1].start_ms);
  await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  const review = page.getByTestId('recent-memo').locator('audio');
  await review.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => review.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  expect(await player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await page.getByTestId('recent-memo').getByRole('button', { name: '教材を再開', exact: true }).click();
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  expect((await page.request.patch(`/api/documents/${doc.id}/`, { headers: { 'X-CSRFToken': await csrf(page) }, data: { text: '改訂後の別の本文です。' } })).status()).toBe(200);
  await page.reload(); await page.getByRole('button', { name: /声のメモ/ }).click();
  await page.getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
  await expect(page.getByTestId('source-context')).toHaveText(original);
  await expect(page.getByTestId('active-source-block').first()).toBeVisible();
  await expect.poll(() => player.evaluate((element: HTMLAudioElement, anchor: number) => Math.abs(element.currentTime * 1000 - anchor), memo.position_ms)).toBeLessThan(150);
  await expect(page.getByLabel('再生速度', { exact: true })).toHaveValue('1.5');
  await page.screenshot({ path: testInfo.outputPath('desktop-narration-context.png'), fullPage: true });
});

test('lost narration acceptance survives reload and is recovered using the same UUID', async ({ page }) => {
  const doc = await create(page, '同じ依頼はもう一度課金する新しい依頼にしません。'.repeat(170));
  let lost = true; let originalJob = ''; const keys: string[] = [];
  await page.route(`**/api/documents/${doc.id}/narration/`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().postDataJSON().client_id);
    if (lost) { lost = false; const response = await route.fetch(); expect(response.status()).toBe(202); originalJob = (await response.json()).id; return route.abort('failed'); }
    const response = await route.fetch(); expect((await response.json()).id).toBe(originalJob); return route.fulfill({ response });
  });
  await page.getByTestId('narration-generate').click();
  await expect(page.getByRole('button', { name: '同じ依頼を確認', exact: true })).toBeEnabled();
  await page.reload(); await page.locator('.document-choice').filter({ hasText: doc.title }).click();
  // A completed current job can already offer playback. If its acknowledgement
  // is pending, resolve it without creating a fresh request or second job.
  const recover = page.getByRole('button', { name: '同じ依頼を確認', exact: true });
  await expect(recover.or(page.getByTestId('play-toggle'))).toBeVisible();
  if (await recover.count()) { await expect(recover).toBeEnabled(); await recover.click(); }
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 30_000 });
  expect((await (await page.request.get(`/api/documents/${doc.id}/narration/`)).json()).id).toBe(originalJob);
  expect([1, 2]).toContain(keys.length); if (keys.length === 2) expect(keys[1]).toBe(keys[0]);
  const request = { headers: { 'X-CSRFToken': await csrf(page) }, data: { client_id: keys[0], document_version: doc.current_version.id, provider: process.env.LC_LOCAL_WINDOWS_TTS === '1' ? 'windows' : 'fixture' } };
  const replay = await page.request.post(`/api/documents/${doc.id}/narration/`, request); expect(replay.status()).toBe(200); expect((await replay.json()).id).toBe(originalJob);
});

test('narration configuration failure is visible and does not offer a new request', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route('**/api/narration/config/', route => route.abort('failed'));
  await create(page, '設定を確認できるまで新しい実行を始めません。');
  await expect(page.getByRole('alert')).toContainText('設定');
  await expect(page.getByTestId('narration-generate')).toHaveCount(0);
  await expect(page.getByTestId('tts-generate')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('generation-unavailable-1366.png'), fullPage: true });
  await page.unroute('**/api/narration/config/');
  await page.getByRole('button', { name: '設定と状況を再確認', exact: true }).click();
  await expect(page.getByTestId('narration-generate')).toBeEnabled();
});

test('real Windows Japanese voice through browser queue and authenticated compressed audio', async ({ page }, testInfo) => {
  test.skip(process.env.LC_LOCAL_WINDOWS_TTS !== '1', 'Opt in to the installed local Windows voice; no Polly or paid AWS calls.');
  test.setTimeout(120_000);
  const doc = await create(page, 'ふだんの学習を、耳と自分の声で振り返ります。');
  const provider = page.getByLabel('読み上げ音声', { exact: true });
  await expect(provider).toBeVisible();
  await provider.selectOption('windows');
  await page.getByTestId('narration-generate').click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 90_000 });
  const fresh = await (await page.request.get(`/api/documents/${doc.id}/`)).json();
  expect(fresh.audio_versions[0].kind).toBe('windows');
  await expect(page.getByText('このPCの日本語音声（開発用）', { exact: true })).toBeVisible();
  const audio = fresh.audio_versions[0];
  const file = await page.request.get(audio.media_url, { headers: { Range: 'bytes=0-255' } });
  expect(file.status()).toBe(206);
  expect(file.headers()['content-type']).toBe('audio/mpeg');
  expect((await file.body()).subarray(0, 3).toString()).toBe('ID3');
  const decoded = await inspectGeneratedAudio(page, audio.media_url);
  const manifest = await (await page.request.get(audio.playlist_url)).json();
  expect(decoded.contentType).toBe('audio/mpeg');
  expect(decoded.sampleRate).toBe(16000); expect(decoded.channels).toBe(1);
  expect(Math.ceil(decoded.decodedFrames / 16)).toBe(audio.duration_ms);
  expect(Math.abs(decoded.mediaDurationMs - decoded.decodedDurationMs)).toBeLessThan(1);
  expect(decoded.encodedBytes).toBe(manifest.segments[0].size_bytes);
  expect(decoded.encodedBytes).toBeLessThanOrEqual(audio.duration_ms * 8 + 4096);
  expect(decoded.nonzeroSamples).toBeGreaterThan(100); expect(decoded.rms).toBeGreaterThan(0.001);
  await testInfo.attach('actual-japanese-compressed-audio.json', {
    body: Buffer.from(JSON.stringify({ provider: 'Microsoft Haruka Desktop local synthesis', logical_duration_ms: audio.duration_ms, ...decoded, limitations: ['No human intelligibility assessment', 'No Polly or AWS calls'] }, null, 2)),
    contentType: 'application/json',
  });
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
});
