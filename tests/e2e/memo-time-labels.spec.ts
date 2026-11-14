import { expect, test } from './fixtures/accounts';

// Real Chromium MediaRecorder/API/PostgreSQL, synthetic microphone only. The
// material anchor and recording length are deliberately different quantities.
test('saved memo distinguishes recording duration from seven-second material position', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();

  const created = page.waitForResponse(response => response.url().endsWith('/api/documents/demo/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  const document = await (await created).json();
  const audio = document.audio_versions[0];
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement) => { element.pause(); element.currentTime = 7; });
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(7);
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  expect(await source.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  // Allow four real seconds of encoded synthetic audio, without faking clocks
  // or rewriting the saved server metadata to make the labels pass.
  await page.waitForTimeout(4000);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.getByTestId('record-toggle').click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const memo = await response.json();
  expect(memo.position_ms).toBe(7000);
  expect(memo.duration_ms).toBeGreaterThanOrEqual(4000);
  // Click/encoder scheduling can add time. Use the actual API duration, while
  // retaining distinct displayed values so a position/duration swap must fail.
  expect(memo.duration_ms).toBeLessThan(7000);
  const recordingTime = `0:${String(Math.floor(memo.duration_ms / 1000)).padStart(2, '0')}`;
  expect(recordingTime).not.toBe('0:07');
  expect(memo.audio_version).toBe(audio.id);
  const recent = page.getByTestId('recent-memo');
  await expect(recent.getByText(`サーバー保存済み · 録音 ${recordingTime}`, { exact: true })).toBeVisible();
  await expect(recent).not.toContainText('録音 0:07');

  await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
  await source.evaluate((element: HTMLAudioElement) => { element.currentTime = 21; });
  await recent.getByRole('button', { name: 'メモを開く', exact: true }).click();
  const card = page.getByTestId('memo-card');
  await expect(card.getByLabel('教材の位置 0:07', { exact: true })).toHaveText('教材 0:07');
  await expect(card.locator('.version-label')).toContainText(`録音 ${recordingTime}`);
  await card.getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(7);
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentSrc)).toBe(new URL(audio.media_url, page.url()).href);

  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(card.getByLabel('教材の位置 0:07', { exact: true })).toHaveText('教材 0:07');
  await expect(card.locator('.version-label')).toContainText(`録音 ${recordingTime}`);
  const memos = await (await page.request.get('/api/memos/')).json();
  expect(memos).toHaveLength(1);
  expect(memos[0]).toMatchObject({ id: memo.id, client_id: memo.client_id, audio_version: audio.id, position_ms: 7000, duration_ms: memo.duration_ms });
  // Unmount the player before the run's account-only cleanup deletes fixtures.
  await page.goto('about:blank');
});
