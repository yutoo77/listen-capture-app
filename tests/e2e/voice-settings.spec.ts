import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { expect, test, type Page } from './fixtures/accounts';

// These UI lifecycle tests use a demo and a mocked catalog/job. They do not
// synthesize speech, call an engine, or establish voice quality/hardware support.
async function catalog(page: Page) {
  let reads = 0;
  await page.route('**/api/narration/config/', async route => {
    reads++;
    const response = await route.fetch();
    const config = await response.json();
    config.providers = config.providers.filter((provider: { id: string }) => provider.id !== 'voicevox');
    config.providers.push({ id: 'voicevox', enabled: true, label: 'VOICEVOX 模擬設定', voice: 'VOICEVOX', billable: false,
      voices: [
        { id: 14, name: '模擬話者A', style: 'ノーマル', credit: 'VOICEVOX:模擬話者A', speaker_uuid: 'synthetic-a', speaker_version: '1.0' },
        { id: 3, name: '模擬話者B', style: 'ノーマル', credit: 'VOICEVOX:模擬話者B', speaker_uuid: 'synthetic-b', speaker_version: '1.0' },
      ], defaults: { speaker_id: 14, pitch_scale: 0 }, pitch_min: -0.15, pitch_max: 0.15, pitch_step: 0.01 });
    await route.fulfill({ response, json: config });
  });
  return () => reads;
}
async function demo(page: Page) {
  const created = page.waitForResponse(response => response.url().endsWith('/api/documents/demo/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  return response.json();
}
type DocumentRef = { id: string; current_version: { id: string; text: string } };
async function generatedFixture(page: Page, document: DocumentRef) {
  const session = await (await page.request.get('/api/session/')).json();
  const accepted = await page.request.post(`/api/documents/${document.id}/narration/`, {
    headers: { 'X-CSRFToken': session.csrfToken }, data: {
      client_id: randomUUID(), document_version: document.current_version.id, provider: 'fixture',
    },
  });
  expect(accepted.status()).toBe(202);
  const job = await accepted.json();
  await expect.poll(async () => (await (await page.request.get(`/api/narrations/${job.id}/`)).json()).state).toBe('succeeded');
  const completed = await (await page.request.get(`/api/narrations/${job.id}/`)).json();
  const fresh = await (await page.request.get(`/api/documents/${document.id}/`)).json();
  const audio = fresh.audio_versions.find((audio: { id: string }) => audio.id === completed.audio_version);
  expect(audio.kind).toBe('fixture');
  const mediaUrl = audio.delivery === 'playlist'
    ? (await (await page.request.get(audio.playlist_url)).json()).segments[0].media_url
    : audio.media_url;
  return { job, completed, audio, mediaUrl };
}
async function delayedVoiceJob(page: Page, document: DocumentRef, audioId: string) {
  const sent: Record<string, unknown>[] = [];
  let finished = false;
  let polls = 0;
  const job = { id: randomUUID(), document_version: document.current_version.id, provider: 'voicevox', state: 'queued', audio_version: null,
    error_code: null, character_count: Array.from(document.current_version.text).length, completed_segments: 0, total_segments: 1,
    retry_characters: 0, has_unknown: false, updated_at: new Date().toISOString(), voice: { speaker_id: 3, pitch_scale: 0.03 },
    synthesis_profile: { provider: 'voicevox', speaker_id: 3, pitch_scale: 0.03 } };
  await page.route(`**/api/documents/${document.id}/narration/`, async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: null });
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/narrations/${job.id}/`, async route => {
    polls++;
    return route.fulfill({ json: finished ? { ...job, state: 'succeeded', audio_version: audioId, completed_segments: 1 } : job });
  });
  return { sent, job, finish: () => { finished = true; }, polls: () => polls };
}
async function choose(panel: Locator) {
  const provider = panel.getByLabel('読み上げ音声', { exact: true });
  if (await provider.count()) await provider.selectOption('voicevox');
  await panel.getByLabel('声', { exact: true }).selectOption('3');
  const slider = panel.getByRole('slider', { name: /^高さ/ });
  await slider.press('Home');
  for (let index = 0; index < 18; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue('0.03');
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  page.on('dialog', dialog => void dialog.accept());
  await page.goto('about:blank');
  const session = await (await page.request.get('/api/session/')).json();
  if (session.user?.username !== process.env.LC_E2E_ALICE) return;
  for (const document of await (await page.request.get('/api/documents/')).json())
    expect((await page.request.delete(`/api/documents/${document.id}/`, { headers: { 'X-CSRFToken': session.csrfToken } })).status()).toBe(204);
});

test('visible voice settings retain selected controls and an uncertain UUID across closing', async ({ page }, info) => {
  info.annotations.push({ type: 'voice-settings', description: 'Mocked catalog and pre-server POST failure; no engine calls or real speech claim.' });
  await page.setViewportSize({ width: 1280, height: 720 });
  const reads = await catalog(page);
  const document = await demo(page);
  expect(reads()).toBe(0); // No setting/controller fetch until the explicit open.
  const trigger = page.getByRole('button', { name: '声・高さ', exact: true });
  const panel = page.getByRole('dialog', { name: '声・高さ', exact: true, includeHidden: true });
  await expect(trigger).toBeInViewport({ ratio: 1 });
  expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('record-toggle')).toBeInViewport({ ratio: 1 });
  await trigger.click();
  await choose(panel);
  await expect(panel.getByText('VOICEVOX:模擬話者B', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('voice-settings-blue-1280.png') });
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel.getByLabel('声', { exact: true })).toHaveValue('3');
  await expect(panel.getByRole('slider', { name: /^高さ/ })).toHaveValue('0.03');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('voice-settings-blue-390.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sent: Record<string, unknown>[] = [];
  await page.route(`**/api/documents/${document.id}/narration/`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.abort('failed'); // No upstream write and no engine request.
  });
  await panel.getByTestId('narration-generate').click();
  await expect(panel.getByRole('button', { name: '同じ依頼を確認', exact: true })).toBeEnabled();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ document_version: document.current_version.id, provider: 'voicevox', voice: { speaker_id: 3, pitch_scale: 0.03 } });
  await panel.getByRole('button', { name: '声・高さを閉じる', exact: true }).click();
  await trigger.click();
  await expect(panel.getByRole('button', { name: '同じ依頼を確認', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('声', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('slider', { name: /^高さ/ })).toHaveCount(0);
  expect(sent).toHaveLength(1); // Reopening alone never sends a new/retried request.
  await panel.getByRole('button', { name: '同じ依頼を確認', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(await (await page.request.get(`/api/documents/${document.id}/narration/`)).json()).toBeNull();
});

test('an accepted job finishing while the voice dialog is closed remains visible without reposting', async ({ page }, info) => {
  test.skip(process.env.LC_E2E_EXPECT_FIXTURE !== '1', 'Uses the deterministic synthetic provider, with no external engine.');
  info.annotations.push({ type: 'voice-settings', description: 'Mocked VOICEVOX job lifecycle over a real synthetic fixture AudioVersion; no VOICEVOX synthesis, speech quality or hardware claim.' });
  const reads = await catalog(page);
  const document = await demo(page);
  // Keep real private media and a fresh AudioVersion identity. Only the job's
  // queued/completed timing and VOICEVOX catalog/profile below are mocked.
  const { audio: generated, mediaUrl } = await generatedFixture(page, document);
  expect(generated.id).not.toBe(document.audio_versions[0].id);
  const delayed = await delayedVoiceJob(page, document, generated.id);
  expect(reads()).toBe(0);
  const trigger = page.getByRole('button', { name: '声・高さ', exact: true });
  const panel = page.getByRole('dialog', { name: '声・高さ', exact: true, includeHidden: true });
  await trigger.click();
  await choose(panel);
  await panel.getByTestId('narration-generate').click();
  await expect(panel.getByTestId('narration-progress')).toContainText('0 / 1区間');
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  delayed.finish();
  await expect.poll(delayed.polls, { timeout: 15000 }).toBeGreaterThan(0);
  // Wait for the hidden, still-mounted controller's state update, not a remount.
  await expect(panel.getByRole('status', { includeHidden: true })).toHaveText('音声を作成しました。');
  await trigger.click();
  await expect(panel.getByRole('status')).toBeVisible();
  await expect(panel.getByText('VOICEVOX:模擬話者B', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '別の声で作る', exact: true })).toBeVisible();
  expect(delayed.sent).toHaveLength(1);
  expect(delayed.sent[0]).toMatchObject({ document_version: document.current_version.id, provider: 'voicevox', voice: delayed.job.voice });
  await panel.getByRole('button', { name: '声・高さを閉じる', exact: true }).click();
  await expect(page.getByTestId('source-audio')).toHaveAttribute('src', mediaUrl);
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
});

test('reusing the same generated profile keeps the loaded audio, position and playable controls', async ({ page }, info) => {
  test.skip(process.env.LC_E2E_EXPECT_FIXTURE !== '1', 'Uses a real deterministic fixture job/profile, with no external engine.');
  info.annotations.push({ type: 'voice-settings', description: 'Real API/worker/PostgreSQL same-profile reuse with synthetic fixture audio; no VOICEVOX or paid calls.' });
  const document = await demo(page);
  const { job, completed } = await generatedFixture(page, document);
  await page.reload();
  await page.locator('.document-choice').filter({ hasText: document.title }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement) => {
    element.currentTime = 1;
    element.dispatchEvent(new Event('timeupdate'));
  });
  const before = await source.evaluate((element: HTMLAudioElement) => ({ src: element.currentSrc, time: element.currentTime, duration: element.duration }));
  expect(before.time).toBe(1);
  expect(before.duration).toBeGreaterThan(2);
  await page.getByRole('button', { name: '声・高さ', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '声・高さ', exact: true });
  const provider = panel.getByLabel('読み上げ音声', { exact: true });
  if (await provider.count()) await provider.selectOption('fixture');
  const reused = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/narration/`) && response.request().method() === 'POST');
  await panel.getByTestId('narration-generate').click();
  const response = await reused;
  expect(response.status()).toBe(200); // The server reuses the existing profile/job.
  expect(await response.json()).toMatchObject({ id: job.id, state: 'succeeded', audio_version: completed.audio_version });
  await expect(panel.getByRole('status')).toHaveText('音声を作成しました。');
  // Job acceptance precedes the asynchronous document refresh/application.
  // Do not accidentally check the still-enabled old controls before it runs.
  await expect(page.getByTestId('status')).toHaveText('テスト用無音音声を用意しました。本文の合成音声ではありません。');
  await panel.getByRole('button', { name: '声・高さを閉じる', exact: true }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  await expect(page.getByRole('slider', { name: '再生位置' })).toBeEnabled();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(before.time);
  expect(await source.evaluate((element: HTMLAudioElement) => ({ src: element.currentSrc, duration: element.duration }))).toEqual({ src: before.src, duration: before.duration });
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => source.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(before.time);
});

test('completion while recording keeps the original memo anchor and can be applied explicitly afterward', async ({ page }, info) => {
  test.skip(process.env.LC_E2E_EXPECT_FIXTURE !== '1', 'Uses private synthetic fixture audio and a fake microphone only.');
  info.annotations.push({ type: 'voice-settings', description: 'Mocked VOICEVOX completion timing, real API/worker/PostgreSQL fixture media and fake-microphone memo; no engine, human voice or paid calls.' });
  await catalog(page);
  const document = await demo(page);
  const original = document.audio_versions[0];
  const { audio: generated, mediaUrl } = await generatedFixture(page, document);
  const delayed = await delayedVoiceJob(page, document, generated.id);
  const trigger = page.getByRole('button', { name: '声・高さ', exact: true });
  const panel = page.getByRole('dialog', { name: '声・高さ', exact: true, includeHidden: true });
  await trigger.click();
  await choose(panel);
  await panel.getByTestId('narration-generate').click();
  await expect(panel.getByTestId('narration-progress')).toBeVisible();
  await page.keyboard.press('Escape');
  const source = page.getByTestId('source-audio');
  await source.evaluate((element: HTMLAudioElement) => { element.currentTime = 7; });
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  const anchor = await source.evaluate((element: HTMLAudioElement) => Math.round(element.currentTime * 1000));
  expect(anchor).toBe(7000);
  delayed.finish();
  await expect.poll(delayed.polls, { timeout: 15000 }).toBeGreaterThan(0);
  await expect(panel.getByRole('status', { includeHidden: true })).toHaveText('音声を作成しました。');
  await expect(panel.getByRole('button', { name: 'この音声を使う', exact: true, includeHidden: true })).toBeDisabled();
  await expect(trigger).toBeDisabled();
  await expect(source).toHaveAttribute('src', original.media_url);
  expect(await source.evaluate((element: HTMLAudioElement) => ({ paused: element.paused, time: element.currentTime }))).toEqual({ paused: true, time: 7 });
  const saved = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.getByTestId('record-toggle').click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const memo = await response.json();
  expect(memo).toMatchObject({ audio_version: original.id, position_ms: anchor });
  await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
  await trigger.click();
  const apply = panel.getByRole('button', { name: 'この音声を使う', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(apply).toHaveCount(0); // The selected audio ID now matches the job.
  expect(delayed.sent).toHaveLength(1); // Applying fetches existing media, never generates again.
  await panel.getByRole('button', { name: '声・高さを閉じる', exact: true }).click();
  await expect(page.getByTestId('source-audio')).toHaveAttribute('src', mediaUrl);
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect(page.getByTestId('source-audio')).toHaveJSProperty('paused', true);
  expect(await (await page.request.get(`/api/memos/${memo.id}/`)).json()).toMatchObject({ audio_version: original.id, position_ms: anchor });
});
