import { expect, test, type Page } from './fixtures/accounts';
import { createHash, randomUUID } from 'node:crypto';

type Document = {
  id: string;
  title: string;
  current_version: { id: string; number: number; text: string };
  audio_versions: { id: string; document_version: string; media_url: string }[];
};
type Memo = {
  id: string;
  client_id: string;
  audio_version: string;
  document_version: { id: string; number: number };
  position_ms: number;
  duration_ms: number;
  text: string;
  media_url: string;
};
const owned = new WeakMap<Page, Set<string>>();
const errors = new WeakMap<Page, string[]>();

async function login(page: Page) {
  if (!process.env.LC_E2E_ALICE || !process.env.LC_E2E_PASSWORD)
    throw new Error('Use scripts/run-e2e.py with isolated accounts.');
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
}

async function demo(page: Page): Promise<Document> {
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/documents/demo/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  const response = await accepted;
  expect([200, 201]).toContain(response.status());
  const document = await response.json() as Document;
  owned.get(page)!.add(document.id);
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  return document;
}

function syntheticWav() {
  const bytes = Buffer.alloc(44 + 16000 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function seedMemo(page: Page, document: Document): Promise<Memo> {
  const session = await (await page.request.get('/api/session/')).json();
  const response = await page.request.post('/api/memos/', {
    headers: { 'X-CSRFToken': session.csrfToken },
    multipart: {
      client_id: randomUUID(), audio_version: document.audio_versions[0].id,
      position_ms: '12000', duration_ms: '1000', text: '',
      audio: { name: 'synthetic.wav', mimeType: 'audio/wav', buffer: syntheticWav() },
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function openMemos(page: Page) {
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(page.getByTestId('memo-card')).toHaveCount(1);
}

async function getDocument(page: Page, id: string): Promise<Document> {
  const response = await page.request.get(`/api/documents/${id}/`);
  expect(response.status()).toBe(200);
  return response.json();
}

test.beforeEach(async ({ page }, info) => {
  test.skip(process.env.LC_E2E_LONG_AUDIO === '1', 'Uses the ordinary demo profile.');
  info.annotations.push({ type: 'evidence', description: 'Real UI/API/PostgreSQL with isolated accounts and synthetic WAV seed; screenshots are Chromium captures, not iPhone or human usability evidence.' });
  owned.set(page, new Set());
  const failures: string[] = [];
  errors.set(page, failures);
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') failures.push(entry.text()); });
  await login(page);
});

test.afterEach(async ({ page }) => {
  page.once('dialog', dialog => dialog.accept());
  await page.goto('about:blank');
  const sessionResponse = await page.request.get('/api/session/');
  if (sessionResponse.ok()) {
    const session = await sessionResponse.json();
    if (session.user?.username === process.env.LC_E2E_ALICE) {
      for (const id of owned.get(page) ?? []) {
        const response = await page.request.delete(`/api/documents/${id}/`, { headers: { 'X-CSRFToken': session.csrfToken } });
        expect(response.status()).toBe(204);
      }
    }
  }
  expect(errors.get(page)).toEqual([]);
});

test('editing source text creates only the intended version and preserves an old audio memo anchor', async ({ page }) => {
  const document = await demo(page);
  const originalAudio = document.audio_versions[0];
  const memo = await seedMemo(page, document);
  const generationPosts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(?:documents\/[^/]+\/(?:narration|audio-generation)\/|narrations\/[^/]+\/retry\/)/.test(request.url()))
      generationPosts.push(new URL(request.url()).pathname);
  });

  const renamed = '改訂を検証する再生・録音デモ';
  await page.getByRole('button', { name: '修正', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '資料を修正', exact: true });
  await expect(editor.getByLabel('本文', { exact: true })).toHaveValue(document.current_version.text);
  await editor.getByLabel('タイトル', { exact: true }).fill(renamed);
  let saved = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/`) && response.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '修正を保存', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(editor).toHaveCount(0);
  const titleOnly = await getDocument(page, document.id);
  expect(titleOnly.title).toBe(renamed);
  expect(titleOnly.current_version).toEqual(document.current_version);
  expect(titleOnly.audio_versions).toEqual(document.audio_versions);

  await page.getByRole('button', { name: '修正', exact: true }).click();
  const revised = `${document.current_version.text}\n追記：保存結果が不明なときは同じ依頼で確認します。`;
  await editor.getByLabel('本文', { exact: true }).fill(revised);
  saved = page.waitForResponse(response => response.url().endsWith(`/api/documents/${document.id}/`) && response.request().method() === 'PATCH');
  await editor.getByRole('button', { name: '修正を保存', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(editor).toHaveCount(0);
  const changed = await getDocument(page, document.id);
  expect(changed.current_version.id).not.toBe(document.current_version.id);
  expect(changed.current_version.number).toBe(document.current_version.number + 1);
  expect(changed.current_version.text).toBe(revised);
  expect(changed.audio_versions).toEqual(document.audio_versions);

  // The API seed is deliberately synthetic; its persisted owner/version/file
  // still pass the same production serializer and private media endpoint.
  const oldMemoResponse = await page.request.get(`/api/memos/${memo.id}/`);
  expect(oldMemoResponse.status()).toBe(200);
  const oldMemo = await oldMemoResponse.json() as Memo;
  expect(oldMemo).toMatchObject({
    client_id: memo.client_id, audio_version: originalAudio.id,
    document_version: { id: document.current_version.id, number: document.current_version.number },
    position_ms: 12000, duration_ms: 1000,
  });
  const media = await page.request.get(oldMemo.media_url);
  expect(media.status()).toBe(200);
  expect(createHash('sha256').update(await media.body()).digest('hex')).toBe(createHash('sha256').update(syntheticWav()).digest('hex'));
  await page.reload();
  await openMemos(page);
  await page.getByTestId('memo-card').getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await expect(page.getByTestId('source-audio')).toHaveAttribute('src', originalAudio.media_url);
  await expect(page.getByTestId('source-context')).toHaveText(document.current_version.text);
  await expect(page.getByText(`資料 v${document.current_version.number} · 音声に対応する本文`, { exact: true })).toBeVisible();
  expect(await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeCloseTo(12, 1);
  expect(generationPosts).toEqual([]);
});

test('a local supplementary draft survives reload and only explicit save confirms the server value', async ({ page }) => {
  const document = await demo(page);
  const memo = await seedMemo(page, document);
  await page.reload();
  await openMemos(page);
  const card = page.getByTestId('memo-card');
  const input = card.getByLabel('メモ', { exact: true });
  const draft = '再読込しても残したい、まだサーバーに保存していない考え。';
  await input.fill(draft);
  await expect(card.locator('.draft-status')).toContainText('端末内に保存済み');
  await expect(card.locator('.draft-status')).toContainText('サーバー保存は未確認');
  expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe('');
  // Accept the real navigation warning: the persisted draft must be restored
  // after a new document lifetime, not merely retained in React memory.
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await openMemos(page);
  await expect(input).toHaveValue(draft);
  await expect(card.locator('.draft-status')).toContainText('端末内に保存済み');
  expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe('');
  const accepted = page.waitForResponse(response => response.url().endsWith(`/api/memos/${memo.id}/`) && response.request().method() === 'PATCH');
  await card.getByRole('button', { name: '文章を保存', exact: true }).click();
  expect((await accepted).status()).toBe(200);
  await expect(card.locator('.draft-status')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '文章を保存', exact: true })).toHaveCount(0);
  await page.reload();
  await openMemos(page);
  await expect(input).toHaveValue(draft);
  await expect(card.locator('.draft-status')).toHaveCount(0);
  expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe(draft);
});

test('everyday player help and memo review remain usable at three viewport widths', async ({ page }, info) => {
  const document = await demo(page);
  await seedMemo(page, document);
  await page.reload();
  await openMemos(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: '使い方', exact: true }).click();
    const help = page.getByRole('region', { name: '使い方', exact: true });
    await expect(help).toBeVisible();
    await expect(help.locator('.help-step')).toHaveCount(3);
    const summary = help.getByText('「端末内」と「サーバー保存済み」の違い', { exact: true });
    await summary.click();
    await expect(help.getByText('端末内の一時保存はバックアップではありません。', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`everyday-help-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: /声のメモ/ }).click();
    const back = page.getByTestId('memo-card').getByRole('button', { name: '元の位置へ戻る', exact: true });
    await expect(back).toBeVisible();
    const backBox = await back.boundingBox();
    expect(backBox!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath(`everyday-memo-${viewport.width}.png`), fullPage: true });
    await back.click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled();
    await expect(page.getByTestId('source-context')).toHaveText(document.current_version.text);
    const record = page.getByTestId('record-toggle');
    await record.scrollIntoViewIfNeeded();
    await expect(record).toBeInViewport({ ratio: 1 });
    for (const control of [record, page.getByTestId('play-toggle'), page.getByRole('button', { name: '修正', exact: true })]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`everyday-player-${viewport.width}.png`), fullPage: true });
  }
});
