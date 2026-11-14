import { expect, test, type Page } from './fixtures/accounts';
import { randomUUID } from 'node:crypto';

// Synthetic account, text and recordings only. These are real browser captures,
// not evidence of iPhone, physical microphone quality or human usability.
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}

function syntheticWav() {
  const buffer = Buffer.alloc(44 + 16000 * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

test('product audit: empty library, capture states and ten/thirty memo review at four widths', async ({ page }, info) => {
  test.setTimeout(180000);
  test.skip(process.env.LC_E2E_LONG_AUDIO === '1', 'Ordinary demo profile.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1366, height: 768 });
  await login(page);
  const shot = async (name: string) => page.screenshot({ path: info.outputPath(`${process.env.LC_AUDIT_STAGE || 'current'}-${name}.png`), fullPage: false });
  await expect(page.getByText('まだ資料がありません。', { exact: false })).toBeVisible();
  await shot('empty-1366');
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill('HTTPを学ぶ — 合成テスト教材');
  await page.getByLabel('資料のテキスト', { exact: true }).fill('HTTPでは要求と応答が対応します。保存の応答を失ったとき、何を確認すべきでしょうか。');
  await shot('text-import');
  const created = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  const textDocument = await (await created).json();
  await expect(page.getByTestId('narration-generate')).toBeVisible();
  await shot('before-generation');
  const provider = page.getByLabel('読み上げ音声', { exact: true });
  if (await provider.count()) await provider.selectOption('fixture');
  await page.getByTestId('narration-generate').click();
  await expect(page.getByTestId('narration-progress')).toBeVisible();
  await shot('generating');
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 30000 });
  const generated = await (await page.request.get(`/api/documents/${textDocument.id}/`)).json();
  expect(generated.audio_versions[0].kind).toBe('fixture');
  // A real demo is long enough for the capture interaction; generated fixtures
  // exercise the TTS pipeline in narration.spec.ts and windows-playlist.spec.ts.
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  await shot('ready-1366');
  const source = page.getByTestId('source-audio');
  await source.evaluate((audio: HTMLAudioElement) => { audio.currentTime = 12; });
  await page.getByTestId('play-toggle').click();
  await shot('playing');
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
  await expect(page.getByRole('button', { name: '声・高さ', exact: true })).toBeDisabled();
  await shot('recording');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/memos/', async route => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });
  await page.waitForTimeout(1200); // MediaRecorder needs nonzero encoded duration.
  await page.getByTestId('record-toggle').click();
  await expect(page.getByTestId('upload-status')).toBeVisible();
  await shot('saving');
  release();
  await expect(page.getByTestId('recent-memo')).toBeVisible();
  await expect(page.getByTestId('recent-memo').getByLabel('直前に保存した録音を聴き直す')).toBeInViewport({ ratio: 1 });
  await shot('saved');
  await page.unroute('**/api/memos/');
  const session = await (await page.request.get('/api/session/')).json();
  const firstMemo = (await (await page.request.get('/api/memos/')).json())[0];
  for (let index = 2; index <= 30; index++) {
    const response = await page.request.post('/api/memos/', { headers: { 'X-CSRFToken': session.csrfToken }, multipart: {
      client_id: randomUUID(), audio_version: index % 2 === 0 ? generated.audio_versions[0].id : firstMemo.audio_version,
      position_ms: String(index % 2 === 0 ? 1000 : index * 3000), duration_ms: '1000',
      text: index % 3 === 0 ? `問い ${index}：なぜ保存結果の確認が必要なのだろう。` : '',
      audio: { name: 'synthetic.wav', mimeType: 'audio/wav', buffer: syntheticWav() },
    } });
    expect(response.status()).toBe(201);
    if (index === 10) {
      await page.reload();
      await page.getByRole('button', { name: /声のメモ/ }).click();
      await expect(page.getByTestId('memo-card')).toHaveCount(10);
      await shot('memos-10');
    }
  }
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(page.getByTestId('memo-card')).toHaveCount(30);
  await page.getByLabel('資料で絞り込む', { exact: true }).selectOption(textDocument.id);
  await expect(page.getByTestId('memo-card')).toHaveCount(15);
  await expect(page.getByTestId('memo-card').first()).toContainText(textDocument.title);
  await page.getByLabel('資料で絞り込む', { exact: true }).selectOption('');
  const firstCard = page.getByTestId('memo-card').first();
  await firstCard.getByLabel('メモ', { exact: true }).fill('資料を絞り込んでも、未保存の考えを失わない。');
  await page.getByLabel('資料で絞り込む', { exact: true }).selectOption(firstMemo.document.id);
  await expect(page.getByTestId('memo-card')).toHaveCount(15);
  await page.getByLabel('資料で絞り込む', { exact: true }).selectOption('');
  await expect(firstCard.getByLabel('メモ', { exact: true })).toHaveValue('資料を絞り込んでも、未保存の考えを失わない。');
  for (const size of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await shot(`memos-30-${size.width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '元の位置へ戻る', exact: true }).first().click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await shot('returned-390');
  for (const size of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await page.evaluate(() => scrollTo(0, 0));
    await shot(`returned-${size.width}`);
    await info.attach(`returned-controls-${size.width}.json`, {
      contentType: 'application/json', body: Buffer.from(JSON.stringify({
        viewport: size,
        record: await page.getByTestId('record-toggle').boundingBox(),
        microphone: await page.getByLabel('入力マイク', { exact: true }).boundingBox(),
        seek: await page.getByRole('slider', { name: '再生位置' }).boundingBox(),
        voiceSettings: await page.getByRole('button', { name: '声・高さ', exact: true }).boundingBox(),
      })),
    });
    await expect(page.getByTestId('record-toggle')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('slider', { name: '再生位置' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByLabel('入力マイク', { exact: true })).toBeInViewport({ ratio: 1 });
    expect((await page.getByLabel('入力マイク', { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const voiceSettings = page.getByRole('button', { name: '声・高さ', exact: true });
    await expect(voiceSettings).toBeInViewport({ ratio: 1 });
    expect((await voiceSettings.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(errors).toEqual([]);
});
