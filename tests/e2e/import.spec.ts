import { expect, test, type Page } from './fixtures/accounts';
import { randomUUID } from 'node:crypto';

import { textPdf } from "./fixtures/pdf";
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}
async function token(page: Page) { return (await (await page.request.get('/api/session/')).json()).csrfToken; }
test.beforeEach(async ({ page }) => { await login(page); });
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const csrf = await token(page);
  const docs = await (await page.request.get('/api/documents/')).json();
  for (const doc of docs) expect((await page.request.delete(`/api/documents/${doc.id}/`, { headers: { 'X-CSRFToken': csrf } })).status()).toBe(204);
  const imports = await (await page.request.get('/api/pdf-imports/')).json();
  for (const job of imports) expect((await page.request.delete(`/api/pdf-imports/${job.id}/`, { headers: { 'X-CSRFToken': csrf } })).status()).toBe(204);
});
async function upload(page: Page, bytes: Buffer) {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByLabel('PDFファイル', { exact: true }).setInputFiles({ name: 'http-lesson.pdf', mimeType: 'application/pdf', buffer: bytes });
  const response = page.waitForResponse(r => r.url().endsWith('/api/pdf-imports/') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
  const result = await response; expect([200, 202]).toContain(result.status());
  return result.json();
}

test('PDF is extracted, corrected, confirmed once, recovered after reload and its private original deleted', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const job = await upload(page, textPdf());
  await expect(page.getByLabel('読み上げる本文', { exact: true })).toHaveValue(/Learning HTTP/, { timeout: 35_000 });
  await expect(page.getByRole('button', { name: '本文を確定して保存' })).toBeDisabled();
  await page.getByLabel('タイトル', { exact: true }).fill('HTTPとトランザクション');
  const corrected = 'HTTPではリクエストとレスポンスを交換します。\n\nトランザクションは複数の変更をまとめて確定します。\n\n<script>window.injected = true</script>';
  await page.getByLabel('読み上げる本文', { exact: true }).fill(corrected);
  await page.getByLabel('読み順と本文を確認しました').check();
  await page.screenshot({ path: testInfo.outputPath('desktop-pdf-review.png'), fullPage: true });
  const confirmation = page.waitForResponse(r => r.url().endsWith(`/pdf-imports/${job.id}/confirm/`));
  await page.getByRole('button', { name: '本文を確定して保存' }).click();
  const saved = await confirmation; expect(saved.status()).toBe(201); const doc = await saved.json();
  const replay = await page.request.post(`/api/pdf-imports/${job.id}/confirm/`, { headers: { 'X-CSRFToken': await token(page) }, data: { client_id: randomUUID(), title: doc.title, text: corrected } });
  expect(replay.status()).toBe(200); expect((await replay.json()).id).toBe(doc.id);
  const version = await (await page.request.get(`/api/documents/${doc.id}/versions/${doc.current_version.id}/`)).json();
  expect(version.blocks.map((block: { text: string }) => block.text).join('')).toBe(corrected);
  await page.reload(); await page.locator('.document-choice').filter({ hasText: doc.title }).click();
  await page.getByText('資料の本文', { exact: true }).click();
  await expect(page.getByTestId('source-context')).toHaveText(corrected);
  expect(await page.evaluate(() => (window as Window & { injected?: boolean }).injected)).toBeUndefined();
  const original = await page.request.get(`/api/pdf-imports/${job.id}/source/`);
  expect(original.status()).toBe(200); expect(original.headers()['content-disposition']).toContain('attachment');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'PDF原本を削除', exact: true }).click();
  await expect(page.getByRole('link', { name: 'PDF原本をダウンロード' })).toHaveCount(0);
  expect((await page.request.get(`/api/pdf-imports/${job.id}/source/`)).status()).toBe(404);
  expect((await page.request.get(`/api/documents/${doc.id}/`)).status()).toBe(200);
});

test('a PDF without selectable text fails visibly without creating a document', async ({ page }) => {
  await upload(page, textPdf(''));
  await expect(page.getByRole('alert')).toContainText('抽出できるテキストがありません', { timeout: 35_000 });
  await expect(page.getByRole('button', { name: '本文を確定して保存' })).toHaveCount(0);
  expect(await (await page.request.get('/api/documents/')).json()).toEqual([]);
});

test('lost PDF upload response reuses the same file and request key', async ({ page }) => {
  let first = true; let originalId = ''; const keys: string[] = [];
  await page.route('**/api/pdf-imports/', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().postDataBuffer()!.toString().match(/name="client_id"\r\n\r\n([^\r]+)/)![1]);
    if (first) { first = false; const response = await route.fetch(); originalId = (await response.json()).id; return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByLabel('PDFファイル').setInputFiles({ name: 'retry.pdf', mimeType: 'application/pdf', buffer: textPdf() });
  await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('同じファイルを再送');
  await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
  await expect(page.getByLabel('読み上げる本文')).toHaveValue(/Learning HTTP/, { timeout: 35_000 });
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  const imports = await (await page.request.get('/api/pdf-imports/')).json();
  expect(imports.map((item: { id: string }) => item.id)).toEqual([originalId]);
});

test('a delayed PDF-original deletion cannot replace a newly selected document', async ({ page }) => {
  const job = await upload(page, textPdf());
  await expect(page.getByLabel('読み上げる本文')).toHaveValue(/Learning HTTP/, { timeout: 35_000 });
  await page.getByLabel('タイトル', { exact: true }).fill('削除する原本の資料');
  await page.getByLabel('読み順と本文を確認しました').check();
  const confirmation = page.waitForResponse(response => response.url().endsWith(`/pdf-imports/${job.id}/confirm/`));
  await page.getByRole('button', { name: '本文を確定して保存', exact: true }).click();
  const original = await (await confirmation).json();
  const other = await page.request.post('/api/documents/', { headers: { 'X-CSRFToken': await token(page) }, data: { title: '次に学ぶ資料', text: '選択中の資料を古い非同期応答で変更しません。' } });
  expect(other.status()).toBe(201);
  await page.reload(); await page.locator('.document-choice').filter({ hasText: original.title }).click();
  await page.getByText('資料の本文', { exact: true }).click();
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void; const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route(`**/api/pdf-imports/${job.id}/`, async route => { if (route.request().method() !== 'DELETE') return route.continue(); received(); await hold; return route.continue(); });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'PDF原本を削除', exact: true }).click(); await requested;
  await page.locator('.document-choice').filter({ hasText: '次に学ぶ資料' }).click();
  const deleted = page.waitForResponse(response => response.url().endsWith(`/pdf-imports/${job.id}/`) && response.request().method() === 'DELETE');
  release(); expect((await deleted).status()).toBe(204);
  await expect(page.getByRole('heading', { name: '次に学ぶ資料', exact: true })).toBeVisible();
  await page.getByText('資料の本文', { exact: true }).click();
  await expect(page.getByTestId('source-context')).toHaveText('選択中の資料を古い非同期応答で変更しません。');
});
