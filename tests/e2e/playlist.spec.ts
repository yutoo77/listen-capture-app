import { expect, test, type Page } from './fixtures/accounts';
import { writeFile } from 'node:fs/promises';

type Part = {
  index: number; start_ms: number; end_ms: number; duration_ms: number;
  media_url: string; size_bytes: number; start_offset: number; end_offset: number;
  block_ids: string[];
};
type Playlist = {
  audio_version: string; document_version: string; delivery: 'playlist';
  duration_ms: number; segments: Part[];
};
type Memo = { id: string; audio_version: string; position_ms: number; duration_ms: number };
type ProbeSample = { at: number; rms: number };
type Transition = { at: number; audioId: string; index: number; gap_ms: number };
type BrowserProbe = {
  transitions: Transition[]; samples: ProbeSample[]; timer?: number;
  context?: AudioContext; destination?: MediaStreamAudioDestinationNode;
};
type ProbeWindow = Window & { __lcPlaylistProbe?: BrowserProbe };

const created = new WeakMap<Page, string[]>();
const diagnostics = new WeakMap<Page, { errors: string[]; expected503: Set<string> }>();

async function login(page: Page) {
  if (!process.env.LC_E2E_ALICE || !process.env.LC_E2E_PASSWORD)
    throw new Error('Run through scripts/run-e2e.py with temporary accounts.');
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}

async function csrf(page: Page) {
  const session = await page.request.get('/api/session/');
  expect(session.status()).toBe(200);
  return (await session.json()).csrfToken as string;
}

async function setSeek(page: Page, position: number) {
  const slider = page.getByRole('slider', { name: '再生位置', exact: true });
  await expect(slider).toBeEnabled();
  // Use the native prototype setter so React sees a genuine value change.
  // Setting the active physical audio.currentTime would bypass the logical UI.
  await slider.evaluate((input: HTMLInputElement, value: number) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, position);
}

async function globalPosition(page: Page, manifest: Playlist) {
  return page.getByTestId('source-audio').evaluate((element: HTMLAudioElement, data: Playlist) => {
    const part = data.segments.find(item => new URL(item.media_url, location.origin).href === element.currentSrc);
    return part ? part.start_ms + element.currentTime * 1000 : -1;
  }, manifest);
}

async function seek(page: Page, manifest: Playlist, position: number) {
  await setSeek(page, position);
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - position)).toBeLessThan(150);
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.seeking)).toBe(false);
}

async function pause(page: Page) {
  const button = page.getByTestId('play-toggle');
  if ((await button.textContent())?.includes('一時停止')) await button.click();
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
}

async function recordAt(page: Page, manifest: Playlist, position: number, startPlaying = true) {
  await pause(page);
  await seek(page, manifest, position);
  if (startPlaying) {
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  }
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  const anchor = await globalPosition(page, manifest);
  expect(await page.locator('main > audio').evaluateAll(elements => elements.every(element => (element as HTMLAudioElement).paused))).toBe(true);
  await expect(page.getByRole('slider', { name: '再生位置', exact: true })).toBeDisabled();
  await expect(page.getByLabel('音声の区間', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('再生速度', { exact: true })).toBeDisabled();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
  // Chromium's actual MediaRecorder and fake microphone produce a real encoded
  // upload that the server validates with ffprobe; this is not a human mic test.
  await page.waitForTimeout(1200);
  await page.getByTestId('record-toggle').click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const memo = await response.json() as Memo;
  expect(memo.audio_version).toBe(manifest.audio_version);
  expect(Math.abs(memo.position_ms - anchor)).toBeLessThan(200);
  expect(memo.duration_ms).toBeGreaterThan(0);
  await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
  await expect.poll(() => page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(!startPlaying);
  await pause(page);
  return { memo, frozen_global_anchor_ms: anchor };
}

async function startProbe(page: Page) {
  return page.evaluate(async () => {
    const probe: BrowserProbe = { transitions: [], samples: [] };
    (window as ProbeWindow).__lcPlaylistProbe = probe;
    window.addEventListener('lc-playback-transition', event => {
      const detail = (event as CustomEvent).detail;
      probe.transitions.push({ at: performance.now(), audioId: detail.audioId, index: detail.index, gap_ms: detail.gap_ms });
    });
    try {
      const elements = [...document.querySelectorAll<HTMLAudioElement>('main > audio')];
      if (elements.length !== 2 || typeof AudioContext === 'undefined') return { available: false, reason: 'Two-source WebAudio observation unavailable' };
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      const destination = context.createMediaStreamDestination();
      for (const element of elements) context.createMediaElementSource(element).connect(analyser);
      analyser.connect(destination);
      analyser.connect(context.destination);
      await context.resume();
      const samples = new Float32Array(analyser.fftSize);
      probe.context = context;
      probe.destination = destination;
      probe.timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        probe.samples.push({ at: performance.now(), rms });
      }, 5);
      return { available: true, sample_rate: context.sampleRate, analyser_frames: analyser.fftSize, requested_interval_ms: 5 };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.name : 'WebAudio unavailable' };
    }
  });
}

test.describe('opt-in sixty-minute logical playlist', () => {
  test.skip(process.env.LC_E2E_LONG_AUDIO !== '1', 'Requires the additional guarded long-fixture flag on API and worker.');

  test.beforeEach(async ({ page }) => {
    created.set(page, []);
    const state = { errors: [] as string[], expected503: new Set<string>() };
    diagnostics.set(page, state);
    page.on('pageerror', error => state.errors.push(error.message));
    page.on('console', event => {
      if (event.type() !== 'error') return;
      if ([...state.expected503].some(path => event.location().url.endsWith(path)) && /503|ERR_FAILED|ERR_ABORTED/.test(event.text())) return;
      state.errors.push(event.text());
    });
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await page.goto('about:blank');
    const session = await page.request.get('/api/session/');
    if (session.ok()) {
      const account = await session.json();
      if (account.user?.username === process.env.LC_E2E_ALICE) {
        for (const id of created.get(page) ?? []) {
          expect((await page.request.delete(`/api/documents/${id}/`, { headers: { 'X-CSRFToken': account.csrfToken } })).status()).toBe(204);
        }
      }
    }
    expect(diagnostics.get(page)?.errors ?? []).toEqual([]);
  });

  test('global playback, two anchored memos, transition evidence, media recovery and original context', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    expect(process.env.LC_E2E_LONG_AUDIO_SECONDS_PER_SEGMENT).toBe('600');
    testInfo.annotations.push({ type: 'microphone', description: process.env.LC_E2E_REAL_MIC === '1' ? 'Hardware getUserMedia requested; no human intelligibility assessment' : 'Chromium fake microphone with actual MediaRecorder and API validation' });
    const title = `60分の学習資料 ${Date.now()}`;
    // No newline: deterministic 1,000-codepoint TextBlocks produce six exact
    // 3,000-codepoint provider chunks, including non-BMP Japanese context.
    const original = Array.from('HTTPの応答を確かめます。🌸資料の文脈と録音した疑問を安全に残します。'.repeat(700)).slice(0, 18000).join('');
    expect(Array.from(original)).toHaveLength(18000);
    await page.getByRole('button', { name: '＋ 資料を追加' }).click();
    await page.getByLabel('タイトル', { exact: true }).fill(title);
    await page.getByLabel('資料のテキスト', { exact: true }).fill(original);
    const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '資料を保存', exact: true }).click();
    const response = await createdResponse;
    expect(response.status()).toBe(201);
    const doc = await response.json();
    created.get(page)!.push(doc.id);
    const originalVersion = doc.current_version.id as string;
    const configuration = await (await page.request.get('/api/narration/config/')).json();
    expect(configuration.fixture_segment_duration_ms).toBe(600000);
    expect(configuration.providers.find((provider: { id: string }) => provider.id === 'fixture').enabled).toBe(true);
    const provider = page.getByLabel('読み上げ音声', { exact: true });
    if (await provider.count()) await provider.selectOption('fixture');
    const synthesisRequests: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/(narration|retry|audio-generation)\/$/.test(new URL(request.url()).pathname)) synthesisRequests.push(new URL(request.url()).pathname);
    });
    await page.getByTestId('narration-generate').click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 60000 });
    const fresh = await (await page.request.get(`/api/documents/${doc.id}/`)).json();
    const audio = fresh.audio_versions[0];
    expect(audio.kind).toBe('fixture');
    expect(audio.delivery).toBe('playlist');
    expect(audio.media_url).toBeNull();
    const manifest = await (await page.request.get(audio.playlist_url)).json() as Playlist;
    expect(manifest.audio_version).toBe(audio.id);
    expect(manifest.document_version).toBe(originalVersion);
    expect(manifest.duration_ms).toBe(3600000);
    expect(manifest.segments).toHaveLength(12);
    expect(manifest.segments.every(part => part.duration_ms <= 300000 && part.size_bytes <= 9600044)).toBe(true);
    expect(synthesisRequests).toHaveLength(1);
    await expect(page.getByText('テスト用の人工音声（本文の合成ではありません）', { exact: true })).toBeVisible();
    await expect(page.getByRole('slider', { name: '再生位置', exact: true })).toHaveAttribute('max', '3600000');

    await page.getByLabel('再生速度', { exact: true }).selectOption('1.5');
    await seek(page, manifest, 2422300);
    expect(await globalPosition(page, manifest)).toBeGreaterThan(1200000);
    expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeLessThanOrEqual(300);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => globalPosition(page, manifest)).toBeGreaterThan(2422500);
    expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.playbackRate)).toBe(1.5);
    await pause(page);

    const boundary = manifest.segments[4].end_ms; // 25:00, not a local element offset.
    const before = await recordAt(page, manifest, boundary - 100, false);
    expect(before.memo.position_ms).toBeLessThan(boundary);
    expect(before.memo.position_ms).toBeGreaterThan(boundary - 200);
    const after = await recordAt(page, manifest, boundary + 100);
    expect(after.memo.position_ms).toBeGreaterThan(boundary);
    expect(after.memo.position_ms).toBeLessThan(boundary + 5000);
    await page.getByText('資料の本文', { exact: true }).click();
    await expect(page.getByTestId('source-context')).toHaveText(original);
    await expect(page.getByTestId('active-source-block').first()).toBeVisible();

    // Exercise an actual native ended event, rather than dispatching an event
    // or advancing a fake clock. Only 0.3 seconds of the real asset remain.
    await seek(page, manifest, boundary - 300);
    const probeSetup = await startProbe(page);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__lcPlaylistProbe?.transitions.length ?? 0)).toBeGreaterThan(0);
    await expect.poll(() => globalPosition(page, manifest)).toBeGreaterThan(boundary + 700);
    await pause(page);
    const observation = await page.evaluate(async () => {
      const probe = (window as ProbeWindow).__lcPlaylistProbe!;
      if (probe.timer !== undefined) window.clearInterval(probe.timer);
      // Keep the graph alive until navigation: a MediaElementAudioSource routes
      // this element through its context, so closing it would mute later audio.
      return { transitions: probe.transitions, samples: probe.samples };
    });
    const transition = observation.transitions[0];
    expect(transition.audioId).toBe(audio.id);
    expect(transition.index).toBe(5);
    expect(Number.isFinite(transition.gap_ms)).toBe(true);
    expect(transition.gap_ms).toBeLessThan(1000);
    let observedSilence: number | null = null;
    if (probeSetup.available) {
      const around = observation.samples.filter(sample => sample.at >= transition.at - 150 && sample.at <= transition.at + 250);
      expect(around.some(sample => sample.at < transition.at && sample.rms > 0.02)).toBe(true);
      expect(around.some(sample => sample.at > transition.at && sample.rms > 0.02)).toBe(true);
      let lowSince: number | null = null;
      observedSilence = 0;
      for (const sample of around) {
        if (sample.rms < 0.01) lowSince ??= sample.at;
        else if (lowSince !== null) { observedSilence = Math.max(observedSilence, sample.at - lowSince); lowSince = null; }
      }
      if (lowSince !== null && around.length) observedSilence = Math.max(observedSilence, around.at(-1)!.at - lowSince);
      expect(observedSilence).toBeLessThan(250);
    } else testInfo.annotations.push({ type: 'limitation', description: `Rendered pipeline observation unavailable: ${probeSetup.reason}` });
    const transitionPath = testInfo.outputPath('playlist-transition-software-pipeline.json');
    await writeFile(transitionPath, JSON.stringify({
        qualification: 'Headless browser WebAudio graph observation; not acoustic or hardware output, not an hour of listening. RMS windows and event-loop sampling limit resolution; zero observed silence does not prove a sample-perfect transition.',
        probe: probeSetup, threshold_rms: 0.01, observed_low_rms_run_ms: observedSilence,
        transitions: observation.transitions, samples: observation.samples,
      }, null, 2));
    await testInfo.attach('playlist-transition-software-pipeline', { path: transitionPath, contentType: 'application/json' });

    // Hold the next asset beyond a real ended event. Pause must cancel the
    // pending automatic handover, even while native play() waits for metadata.
    const heldPart = manifest.segments[2];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**${heldPart.media_url}`, async route => {
      await held;
      await route.continue();
    });
    try {
      await seek(page, manifest, heldPart.start_ms - 300);
      await page.getByTestId('play-toggle').click();
      await expect(page.getByRole('status').filter({ hasText: '音声の区間を読み込んでいます' })).toBeVisible();
      await expect(page.getByTestId('play-toggle')).toBeEnabled();
      await expect(page.getByTestId('play-toggle')).toHaveText('一時停止');
      await page.getByTestId('play-toggle').click();
      release();
      await expect(page.getByTestId('play-toggle')).toHaveText('再生');
      await expect(page.getByTestId('play-toggle')).toBeEnabled();
      await expect.poll(() => globalPosition(page, manifest)).toBe(heldPart.start_ms);
      expect(await page.locator('main > audio').evaluateAll(elements => elements.every(element => (element as HTMLAudioElement).paused))).toBe(true);
    } finally {
      release();
      await page.unroute(`**${heldPart.media_url}`);
    }

    // Select an asset outside both current/prefetch slots, fail only its media
    // transport, and require explicit media retry without any TTS request.
    const failingPart = manifest.segments[10];
    diagnostics.get(page)!.expected503.add(failingPart.media_url);
    let blocked = true;
    let failures = 0;
    await page.route(`**${failingPart.media_url}`, route => {
      if (!blocked) return route.continue();
      failures++;
      return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Retry-After': '1' }, body: '{"code":"storage_unavailable"}' });
    });
    const recoveryPosition = failingPart.start_ms + 123400;
    await setSeek(page, recoveryPosition);
    await expect(page.getByRole('button', { name: '音声を再読込', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('音声の区間を読み込めません。位置は保持しています。');
    expect(Math.abs(Number(await page.getByRole('slider', { name: '再生位置', exact: true }).inputValue()) - recoveryPosition)).toBeLessThan(150);
    expect(failures).toBeGreaterThan(0);
    blocked = false;
    await page.getByRole('button', { name: '音声を再読込', exact: true }).click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled();
    await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - recoveryPosition)).toBeLessThan(150);
    expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    expect(synthesisRequests).toHaveLength(1);
    await page.unroute(`**${failingPart.media_url}`);

    const resumePosition = 2345600;
    await seek(page, manifest, resumePosition);
    const progressUrl = `/api/audio/${audio.id}/progress/`;
    await expect.poll(async () => (await (await page.request.get(progressUrl)).json()).position_ms).toBe(resumePosition);
    await page.reload();
    await page.locator('.document-choice').filter({ hasText: title }).click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled();
    await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - resumePosition)).toBeLessThan(150);
    await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await expect(page.getByLabel('ユーザー名', { exact: true })).toBeVisible();
    await login(page);
    await page.locator('.document-choice').filter({ hasText: title }).click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled();
    await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - resumePosition)).toBeLessThan(150);
    await expect(page.getByLabel('再生速度', { exact: true })).toHaveValue('1.5');

    const updated = await page.request.patch(`/api/documents/${doc.id}/`, { headers: { 'X-CSRFToken': await csrf(page) }, data: { text: '更新後の本文です。以前の録音は元の版を参照します。' } });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).current_version.id).not.toBe(originalVersion);
    await page.reload();
    await page.getByRole('button', { name: /声のメモ/ }).click();
    await expect(page.getByTestId('memo-card')).toHaveCount(2);
    const oldMemo = page.getByTestId('memo-card').filter({ has: page.locator(`#memo-text-${before.memo.id}`) });
    await oldMemo.getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
    await expect(page.getByTestId('source-context')).toHaveText(original);
    await expect(page.getByTestId('active-source-block').first()).toBeVisible();
    await expect(page.getByText('資料 v1 · 音声に対応する本文', { exact: true })).toBeVisible();
    await expect.poll(async () => Math.abs(await globalPosition(page, manifest) - before.memo.position_ms)).toBeLessThan(150);
    const context = await (await page.request.get(`/api/documents/${doc.id}/versions/${originalVersion}/`)).json();
    expect(context.text).toBe(original);
    expect(manifest.segments[4].block_ids.every(id => context.blocks.some((block: { id: string }) => block.id === id))).toBe(true);
    expect(synthesisRequests).toHaveLength(1);
    await testInfo.attach('playlist-desktop-evidence.json', {
      body: Buffer.from(JSON.stringify({ fixture: 'explicit sixty-minute 100Hz test signal, not synthesized source text', manifest, before, after, resume_position_ms: resumePosition, media_503_count: failures, synthesis_requests: synthesisRequests.length, microphone: process.env.LC_E2E_REAL_MIC === '1' ? 'requested hardware' : 'Chromium fake device' }, null, 2)),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('desktop-playlist-old-context.png'), fullPage: true });
  });
});
