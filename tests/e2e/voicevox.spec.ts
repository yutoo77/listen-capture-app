import { createHash } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { expect, test, type Page } from './fixtures/accounts';
import { inspectGeneratedAudio } from './fixtures/generated-audio';

const text = '音声の設定を変えても、前に残した自分の声のメモは元の音声に結び付きます。';
type Voice = { speaker_id: number; pitch_scale: number };
type Speaker = { id: number; name: string; style: string; credit: string; speaker_uuid: string; speaker_version: string };
type Config = { providers: { id: string; enabled: boolean; voices?: Speaker[]; defaults?: Voice }[] };
type Audio = { id: string; document_version: string; kind: string; duration_ms: number; media_url: string; synthesis_profile: Record<string, unknown> };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function create(page: Page) {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill('声の変更とメモの参照 — 合成テスト');
  await page.getByLabel('資料のテキスト', { exact: true }).fill(text);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  return response.json();
}
async function chooseVoice(panel: Locator, voice: Voice) {
  const provider = panel.getByLabel('読み上げ音声', { exact: true });
  if (await provider.count()) await provider.selectOption('voicevox');
  await panel.getByLabel('声', { exact: true }).selectOption(String(voice.speaker_id));
  const slider = panel.getByRole('slider', { name: /^高さ/ });
  await slider.press('Home');
  for (let index = 0; index < Math.round((voice.pitch_scale + 0.15) * 100); index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(voice.pitch_scale));
}
async function generate(page: Page, panel: Locator, documentId: string, versionId: string, voice: Voice) {
  const accepted = page.waitForResponse(response => response.url().endsWith(`/api/documents/${documentId}/narration/`) && response.request().method() === 'POST');
  await panel.getByTestId('narration-generate').click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  expect(response.request().postDataJSON()).toMatchObject({ document_version: versionId, provider: 'voicevox', voice });
  const job = await response.json();
  expect(job.voice).toEqual(voice);
  expect(job.synthesis_profile).toMatchObject({ provider: 'voicevox', speaker_id: voice.speaker_id, pitch_scale: voice.pitch_scale });
  await expect.poll(async () => (await (await page.request.get(`/api/narrations/${job.id}/`)).json()).state, { timeout: 120_000, intervals: [500, 1000] }).toBe('succeeded');
  const finished = await (await page.request.get(`/api/narrations/${job.id}/`)).json();
  const document = await (await page.request.get(`/api/documents/${documentId}/`)).json();
  const audio = document.audio_versions.find((audio: Audio) => audio.id === finished.audio_version) as Audio;
  expect(audio.kind).toBe('voicevox');
  expect(audio.document_version).toBe(versionId);
  expect(audio.synthesis_profile).toEqual(job.synthesis_profile);
  expect(audio.duration_ms).toBeGreaterThan(1000);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentSrc), { timeout: 15_000 }).toBe(new URL(audio.media_url, page.url()).href);
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  return { job: finished, audio };
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

test('voice and pitch are frozen with the same UUID after a lost browser acceptance, without an engine', async ({ page }, info) => {
  info.annotations.push({ type: 'voicevox', description: 'Mocked catalog and pre-server network failure only; no synthesis or real-engine claim.' });
  const speakers: Speaker[] = [
    { id: 14, name: '模擬話者A', style: 'ノーマル', credit: 'VOICEVOX:模擬話者A', speaker_uuid: 'synthetic-a', speaker_version: '1.0' },
    { id: 3, name: '模擬話者B', style: 'ノーマル', credit: 'VOICEVOX:模擬話者B', speaker_uuid: 'synthetic-b', speaker_version: '1.0' },
  ];
  await page.route('**/api/narration/config/', async route => {
    const response = await route.fetch();
    const config = await response.json();
    config.providers = config.providers.filter((provider: { id: string }) => provider.id !== 'voicevox');
    config.providers.push({ id: 'voicevox', enabled: true, label: 'VOICEVOX 模擬設定', voice: 'VOICEVOX', billable: false, voices: speakers, defaults: { speaker_id: 14, pitch_scale: 0 }, pitch_min: -0.15, pitch_max: 0.15, pitch_step: 0.01 });
    await route.fulfill({ response, json: config });
  });
  const document = await create(page);
  const sent: Record<string, unknown>[] = [];
  await page.route(`**/api/documents/${document.id}/narration/`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.abort('failed'); // Deliberately no upstream POST, no engine call.
  });
  const panel = page.locator('.no-audio .narration-panel');
  const voice = { speaker_id: 3, pitch_scale: 0.03 };
  await chooseVoice(panel, voice);
  await expect(panel.getByText('VOICEVOX:模擬話者B', { exact: true })).toBeVisible();
  await panel.getByTestId('narration-generate').click();
  await expect(panel.getByRole('button', { name: '同じ依頼を確認', exact: true })).toBeEnabled();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ document_version: document.current_version.id, provider: 'voicevox', voice });
  await page.reload();
  await page.locator('.document-choice').filter({ hasText: document.title }).click();
  await expect(panel.getByRole('button', { name: '同じ依頼を確認', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('声', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('slider', { name: /^高さ/ })).toHaveCount(0);
  await panel.getByRole('button', { name: '同じ依頼を確認', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(await (await page.request.get(`/api/documents/${document.id}/narration/`)).json()).toBeNull();
});

test('real local VOICEVOX changes voice/pitch while keeping the first audio and memo immutable across reload', async ({ page }, info) => {
  test.skip(process.env.LC_E2E_REAL_VOICEVOX !== '1', 'Opt in to the installed loopback VOICEVOX engine. Ordinary CI exercises the mocked UI contract above.');
  test.setTimeout(300_000);
  info.annotations.push({ type: 'voicevox', description: 'Actual local VOICEVOX + API/worker/PostgreSQL + browser decode; synthetic microphone. No human listening, real microphone, Polly or AWS.' });
  const configResponse = await page.request.get('/api/narration/config/');
  expect(configResponse.status()).toBe(200);
  const provider = (await configResponse.json() as Config).providers.find(provider => provider.id === 'voicevox');
  expect(provider?.enabled).toBe(true);
  expect(provider?.voices?.length).toBeGreaterThan(1);
  const firstSpeaker = provider!.voices!.find(speaker => speaker.id === provider!.defaults!.speaker_id)!;
  const secondSpeaker = provider!.voices!.find(speaker => speaker.name !== firstSpeaker.name)!;
  expect(secondSpeaker).toBeTruthy();
  const firstVoice: Voice = { speaker_id: firstSpeaker.id, pitch_scale: 0.03 };
  const secondVoice: Voice = { speaker_id: secondSpeaker.id, pitch_scale: -0.02 };
  const document = await create(page);
  const version = document.current_version.id;
  await chooseVoice(page.locator('.no-audio .narration-panel'), firstVoice);
  const first = await generate(page, page.locator('.no-audio .narration-panel'), document.id, version, firstVoice);
  expect(first.audio.synthesis_profile).toMatchObject({ name: firstSpeaker.name, credit: firstSpeaker.credit, engine_version: '0.25.2', speaker_uuid: firstSpeaker.speaker_uuid, speaker_version: firstSpeaker.speaker_version });
  const firstBytes = await (await page.request.get(first.audio.media_url)).body();
  const firstHash = sha(firstBytes);
  const firstDecoded = await inspectGeneratedAudio(page, first.audio.media_url);
  expect(['audio/mpeg', 'audio/wav']).toContain(firstDecoded.contentType);
  expect(firstDecoded.sampleRate).toBe(16000);
  expect(firstDecoded.channels).toBe(1);
  expect(firstDecoded.nonzeroSamples).toBeGreaterThan(100);
  expect(firstDecoded.rms).toBeGreaterThan(0.001);
  expect(await page.evaluate(async url => (await fetch(url, { credentials: 'omit' })).status, first.audio.media_url)).toBe(403);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  // Capture freezes the anchor before pausing a running media clock. Comparing
  // it with a later paused sample races that clock by a millisecond. Keep the
  // playback proof above, then use an explicit paused, completed 1s seek.
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('source-audio')).toHaveJSProperty('paused', true);
  await expect(page.getByTestId('play-toggle')).toHaveText('再生');
  const seek = page.getByRole('slider', { name: '再生位置', exact: true });
  await seek.press('Home');
  for (let index = 0; index < 10; index++) await seek.press('ArrowRight');
  await expect(seek).toHaveValue('1000');
  await expect(page.getByTestId('source-audio')).toHaveJSProperty('seeking', false);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(1);
  const anchor = 1000;
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  await page.waitForTimeout(1200);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  await page.getByTestId('record-toggle').click();
  const memoResponse = await saved;
  expect(memoResponse.status()).toBe(201);
  const memo = await memoResponse.json();
  expect(memo.audio_version).toBe(first.audio.id);
  expect(memo.position_ms).toBe(anchor);
  const memoHash = sha(await (await page.request.get(memo.media_url)).body());
  await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
  await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.pause());
  await page.getByRole('button', { name: '声・高さ', exact: true }).click();
  const voiceOptions = page.getByRole('dialog', { name: '声・高さ', exact: true });
  await chooseVoice(voiceOptions, secondVoice);
  const second = await generate(page, voiceOptions, document.id, version, secondVoice);
  expect(second.audio.id).not.toBe(first.audio.id);
  expect(second.job.id).not.toBe(first.job.id);
  expect(second.audio.synthesis_profile).toMatchObject({ name: secondSpeaker.name, credit: secondSpeaker.credit, speaker_uuid: secondSpeaker.speaker_uuid, speaker_version: secondSpeaker.speaker_version });
  expect(sha(await (await page.request.get(second.audio.media_url)).body())).not.toBe(firstHash);
  expect(sha(await (await page.request.get(first.audio.media_url)).body())).toBe(firstHash);
  const secondDecoded = await inspectGeneratedAudio(page, second.audio.media_url);
  expect(secondDecoded.nonzeroSamples).toBeGreaterThan(100);
  expect(secondDecoded.rms).toBeGreaterThan(0.001);
  await voiceOptions.getByRole('button', { name: '声・高さを閉じる', exact: true }).click();
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  expect((await (await page.request.get(`/api/documents/${document.id}/`)).json()).audio_versions).toHaveLength(2);
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await page.getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentSrc)).toBe(new URL(first.audio.media_url, page.url()).href);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement, position: number) => Math.abs(element.currentTime * 1000 - position), anchor)).toBeLessThan(150);
  await expect(page.getByTestId('source-context')).toHaveText(text);
  const memos = await (await page.request.get('/api/memos/')).json();
  expect(memos).toHaveLength(1);
  expect(memos[0]).toMatchObject({ id: memo.id, client_id: memo.client_id, audio_version: first.audio.id, position_ms: anchor });
  expect(sha(await (await page.request.get(memo.media_url)).body())).toBe(memoHash);
  await info.attach('actual-local-voicevox.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    provider: 'voicevox', document_version: version,
    first: { voice: firstVoice, job_id: first.job.id, audio_id: first.audio.id, sha256: firstHash, profile: first.audio.synthesis_profile, decoded: firstDecoded },
    second: { voice: secondVoice, job_id: second.job.id, audio_id: second.audio.id, profile: second.audio.synthesis_profile, decoded: secondDecoded },
    memo: { id: memo.id, audio_version: first.audio.id, position_ms: anchor, sha256: memoHash },
    limitations: ['Synthetic microphone', 'No human listening or speech quality assessment', 'No Polly or AWS calls'],
  }, null, 2)) });
});
