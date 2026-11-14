import { expect, test, type Page } from './fixtures/accounts';
import { inspectGeneratedAudio } from './fixtures/generated-audio';

type Part = { index: number; start_ms: number; end_ms: number; duration_ms: number; media_url: string; content_type: string; size_bytes: number; block_ids: string[] };
type Manifest = { audio_version: string; document_version: string; duration_ms: number; delivery: string; segments: Part[] };
type Transition = { audioId: string; index: number; gap_ms: number };
type ProbeWindow = Window & { __windowsTransitions?: Transition[] };

async function csrf(page: Page) { return (await (await page.request.get('/api/session/')).json()).csrfToken; }
async function globalPosition(page: Page, manifest: Manifest) {
  return page.getByTestId('source-audio').evaluate((element: HTMLAudioElement, value: Manifest) => {
    const part = value.segments.find(item => new URL(item.media_url, location.origin).href === element.currentSrc);
    return part ? part.start_ms + element.currentTime * 1000 : -1;
  }, manifest);
}
async function seek(page: Page, manifest: Manifest, target: number) {
  const slider = page.getByRole('slider', { name: '再生位置', exact: true });
  await expect(slider).toBeEnabled();
  await slider.evaluate((input: HTMLInputElement, value: number) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, target);
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - target)).toBeLessThan(150);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.seeking)).toBe(false);
}
async function pause(page: Page) {
  if ((await page.getByTestId('play-toggle').textContent())?.includes('一時停止')) await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
}

test('opt-in actual Japanese Windows speech exceeds twenty minutes and retains a global memo across native segments', async ({ page }, testInfo) => {
  test.skip(process.platform !== 'win32' || process.env.LC_LOCAL_WINDOWS_TTS !== '1', 'Explicit installed Windows Japanese voice opt-in; never Polly or a silent fixture.');
  test.setTimeout(240_000);
  testInfo.annotations.push({ type: 'speech', description: 'Actual Microsoft Haruka Desktop local synthesis; duration is measured from PCM, not a simulated timeline.' });
  testInfo.annotations.push({ type: 'microphone', description: process.env.LC_E2E_REAL_MIC === '1' ? 'Hardware getUserMedia requested; no human intelligibility assessment' : 'Chromium fake microphone, actual MediaRecorder and authenticated ffprobe-validated upload.' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const created: string[] = [];
  const synthesis: string[] = [];
  const generationStarted = Date.now();
  try {
    await page.goto('/');
    await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
    await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
    await page.getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
    const config = await (await page.request.get('/api/narration/config/')).json();
    expect(config.providers.find((provider: { id: string }) => provider.id === 'windows').enabled).toBe(true);
    expect(config.providers.find((provider: { id: string }) => provider.id === 'polly').enabled).toBe(false);
    const sentence = '学習を始める前に、今日確かめたいことを言葉にします。資料を耳で聴き、疑問が生まれたら再生を止めて自分の声で残します。あとから元の文章と録音の位置を確かめ、理解が変わったところを振り返ります。通信が失敗したときも、保存した内容を失わずに確認できることを大切にします。';
    const original = Array.from(sentence.repeat(150)).slice(0, 12000).join('');
    expect(Array.from(original)).toHaveLength(12000);
    const title = `Windows日本語の長文 ${Date.now()}`;
    await page.getByRole('button', { name: '＋ 資料を追加' }).click();
    await page.getByLabel('タイトル', { exact: true }).fill(title);
    await page.getByLabel('資料のテキスト', { exact: true }).fill(original);
    const saving = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '資料を保存', exact: true }).click();
    const saved = await saving; expect(saved.status()).toBe(201); const document = await saved.json(); created.push(document.id);
    const provider = page.getByLabel('読み上げ音声', { exact: true });
    if (await provider.count()) await provider.selectOption('windows');
    page.on('request', request => {
      if (request.method() === 'POST' && /\/(narration|retry|audio-generation)\/$/.test(new URL(request.url()).pathname)) {
        synthesis.push(new URL(request.url()).pathname);
        expect(request.postDataJSON().provider).toBe('windows');
      }
    });
    await page.getByTestId('narration-generate').click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 180_000 });
    const fresh = await (await page.request.get(`/api/documents/${document.id}/`)).json();
    const audio = fresh.audio_versions[0];
    expect(audio.kind).toBe('windows'); expect(audio.delivery).toBe('playlist'); expect(audio.media_url).toBeNull();
    const manifest = await (await page.request.get(audio.playlist_url)).json() as Manifest;
    await testInfo.attach('windows-actual-duration.json', { body: Buffer.from(JSON.stringify({ provider: 'Microsoft Haruka Desktop', source_codepoints: 12000, duration_ms: manifest.duration_ms, generation_wall_ms: Date.now() - generationStarted, manifest }, null, 2)), contentType: 'application/json' });
    // Do not weaken these bounds to turn unexpectedly short/long output into a pass.
    expect(manifest.duration_ms).toBeGreaterThan(20 * 60 * 1000);
    expect(manifest.duration_ms).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(manifest.audio_version).toBe(audio.id); expect(manifest.document_version).toBe(document.current_version.id);
    expect(manifest.segments.length).toBeGreaterThan(4);
    expect(manifest.segments.every(part => part.duration_ms > 0 && part.duration_ms <= 300000 && ['audio/mpeg', 'audio/wav'].includes(part.content_type))).toBe(true);
    expect(manifest.segments.some(part => part.content_type === 'audio/mpeg')).toBe(true);
    const compressedBytes = manifest.segments.reduce((sum, part) => sum + part.size_bytes, 0);
    const thirtyMinuteEquivalentBytes = compressedBytes * 1_800_000 / manifest.duration_ms;
    expect(thirtyMinuteEquivalentBytes).toBeLessThanOrEqual(20 * 1024 * 1024);
    const sample = await page.request.get(manifest.segments[0].media_url, { headers: { Range: 'bytes=0-255' } });
    expect(sample.status()).toBe(206); expect(sample.headers()['content-type']).toBe('audio/mpeg');
    expect((await sample.body()).subarray(0, 3).toString()).toBe('ID3');
    const decodedParts = [];
    let cumulativeFrames = 0;
    for (const part of manifest.segments) {
      const decoded = await inspectGeneratedAudio(page, part.media_url);
      expect(decoded.contentType).toBe(part.content_type); expect(decoded.channels).toBe(1); expect(decoded.sampleRate).toBe(16000);
      expect(decoded.encodedBytes).toBe(part.size_bytes);
      if (part.content_type === 'audio/mpeg') expect(decoded.encodedBytes).toBeLessThanOrEqual(part.duration_ms * 8 + 4096);
      else {
        // Tiny final pieces stay PCM rather than publishing damaged gapless
        // metadata or adding hidden padding to an immutable global timeline.
        expect(decoded.decodedFrames).toBeLessThan(4096);
        expect(decoded.encodedBytes).toBe(decoded.decodedFrames * 2 + 44);
      }
      expect(Math.abs(decoded.mediaDurationMs - decoded.decodedDurationMs)).toBeLessThan(1);
      expect(Math.abs(decoded.decodedDurationMs - part.duration_ms)).toBeLessThanOrEqual(1);
      expect(part.start_ms).toBe(Math.ceil(cumulativeFrames / 16));
      cumulativeFrames += decoded.decodedFrames;
      expect(part.end_ms).toBe(Math.ceil(cumulativeFrames / 16));
      decodedParts.push({ index: part.index, ...decoded });
    }
    expect(Math.ceil(cumulativeFrames / 16)).toBe(manifest.duration_ms);
    // A tiny final piece can legitimately be the synthesizer's trailing
    // silence; the complete known Japanese lesson must contain actual sound.
    expect(decodedParts.reduce((sum, part) => sum + part.nonzeroSamples, 0)).toBeGreaterThan(100);
    expect(Math.max(...decodedParts.map(part => part.rms))).toBeGreaterThan(0.001);
    await expect(page.getByText('このPCの日本語音声（開発用）', { exact: true })).toBeVisible();
    await expect(page.getByRole('slider', { name: '再生位置', exact: true })).toHaveAttribute('max', String(manifest.duration_ms));
    await page.getByLabel('再生速度', { exact: true }).selectOption('1.5');
    for (const target of [0, Math.floor(manifest.duration_ms / 2), manifest.duration_ms - 2000]) await seek(page, manifest, target);
    const latePosition = Math.round(1200000 + Math.min(30000, (manifest.duration_ms - 1200000) / 2));
    await seek(page, manifest, latePosition);
    expect(await globalPosition(page, manifest)).toBeGreaterThan(1200000);
    expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeLessThanOrEqual(300);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => globalPosition(page, manifest)).toBeGreaterThan(latePosition + 100);
    expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
    const frozenAnchor = await globalPosition(page, manifest);
    expect(await page.locator('main > audio').evaluateAll(elements => elements.every(element => (element as HTMLAudioElement).paused))).toBe(true);
    const memoSaving = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
    await page.waitForTimeout(1200); await page.getByTestId('record-toggle').click();
    const memoResponse = await memoSaving; expect(memoResponse.status()).toBe(201); const memo = await memoResponse.json();
    expect(memo.audio_version).toBe(audio.id); expect(memo.position_ms).toBeGreaterThan(1200000); expect(Math.abs(memo.position_ms - frozenAnchor)).toBeLessThan(200);
    await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
    await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
    await pause(page);
    await page.evaluate(() => { (window as ProbeWindow).__windowsTransitions = []; window.addEventListener('lc-playback-transition', event => (window as ProbeWindow).__windowsTransitions!.push((event as CustomEvent).detail)); });
    const boundary = manifest.segments[manifest.segments.length - 2].end_ms;
    await seek(page, manifest, boundary - 300);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__windowsTransitions?.length ?? 0)).toBeGreaterThan(0);
    await expect.poll(() => globalPosition(page, manifest)).toBeGreaterThan(boundary + 500);
    await pause(page);
    const transitions = await page.evaluate(() => (window as ProbeWindow).__windowsTransitions!);
    expect(transitions[0].audioId).toBe(audio.id); expect(transitions[0].index).toBe(manifest.segments.length - 1); expect(Number.isFinite(transitions[0].gap_ms)).toBe(true);
    expect(transitions[0].gap_ms).toBeLessThan(1000);
    const revised = await page.request.patch(`/api/documents/${document.id}/`, { headers: { 'X-CSRFToken': await csrf(page) }, data: { text: '改訂後の本文です。音声メモは元の長い資料を参照します。' } });
    expect(revised.status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: /声のメモ/ }).click();
    await expect(page.getByTestId('memo-card')).toHaveCount(1);
    const savedMemoAudio = page.getByTestId('memo-card').locator('audio');
    await savedMemoAudio.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(() => savedMemoAudio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
    await page.getByTestId('memo-card').getByLabel('メモ', { exact: true }).fill('元の長い教材の疑問をあとで確かめます。');
    await page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true }).click();
    await expect(page.getByTestId('status')).toContainText('文章メモを保存しました');
    await page.getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
    await expect.poll(() => savedMemoAudio.count()).toBe(0);
    await expect(page.getByTestId('source-context')).toHaveText(original);
    await expect(page.getByTestId('active-source-block').first()).toBeVisible();
    await expect(page.getByText('資料 v1 · 音声に対応する本文', { exact: true })).toBeVisible();
    await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - memo.position_ms)).toBeLessThan(150);
    await expect(page.getByLabel('再生速度', { exact: true })).toHaveValue('1.5');
    expect(synthesis).toHaveLength(1); expect(errors).toEqual([]);
    await testInfo.attach('windows-playlist-evidence.json', { body: Buffer.from(JSON.stringify({ provider: 'Microsoft Haruka Desktop local Windows synthesis', source_codepoints: 12000, duration_ms: manifest.duration_ms, physical_parts: manifest.segments.length, compressed_bytes: compressedBytes, thirty_minute_equivalent_bytes: thirtyMinuteEquivalentBytes, decoded_source_frames: cumulativeFrames, decoded_parts: decodedParts, transitions, memo_global_anchor_ms: memo.position_ms, synthesis_requests: synthesis.length, microphone: process.env.LC_E2E_REAL_MIC === '1' ? 'requested hardware' : 'Chromium fake device', limitations: ['No human intelligibility assessment', 'Native handover measured, not a gapless speech claim', 'No Polly/AWS verification'] }, null, 2)), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('desktop-windows-long-context.png'), fullPage: true });
  } finally {
    await page.goto('about:blank');
    const session = await page.request.get('/api/session/');
    if (session.ok()) {
      const account = await session.json();
      if (account.user?.username === process.env.LC_E2E_ALICE) for (const id of created)
        expect((await page.request.delete(`/api/documents/${id}/`, { headers: { 'X-CSRFToken': account.csrfToken } })).status()).toBe(204);
    }
  }
});
