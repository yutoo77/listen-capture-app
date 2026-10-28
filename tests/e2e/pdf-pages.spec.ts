import { expect, test, installLoginPacing, type Page } from './fixtures/accounts';
import { randomUUID } from 'node:crypto';
import { numberedPdf } from './fixtures/pdf';
async function login(page: Page, username = process.env.LC_E2E_ALICE!) {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(username);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}
async function token(page: Page) { return (await (await page.request.get('/api/session/')).json()).csrfToken; }
async function upload(page: Page, pages = 60) {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByLabel('PDFファイル').setInputFiles({ name: 'chapter-selection.pdf', mimeType: 'application/pdf', buffer: numberedPdf(pages) });
  const response = page.waitForResponse(r => r.url().endsWith('/api/pdf-imports/') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
  const result = await response; expect(result.status()).toBe(202); return result.json();
}
test.beforeEach(async ({ page }) => { await login(page); });
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const csrf = await token(page);
  for (const doc of await (await page.request.get('/api/documents/')).json())
    expect((await page.request.delete(`/api/documents/${doc.id}/`, { headers: { 'X-CSRFToken': csrf } })).status()).toBe(204);
  for (const job of await (await page.request.get('/api/pdf-imports/')).json())
    expect((await page.request.delete(`/api/pdf-imports/${job.id}/`, { headers: { 'X-CSRFToken': csrf } })).status()).toBe(204);
});

test('selected pages recover the same receipt after lost response and reload, and preserve owner-only provenance', async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  const job = await upload(page);
  await expect(page.getByLabel('開始ページ')).toBeVisible({ timeout: 35_000 });
  await expect(page.getByRole('status').filter({ hasText: '取り込むページを選んでください' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('開始ページ').fill('52');
  await page.getByLabel('終了ページ').fill('54');
  let first = true; const keys: string[] = [];
  await page.route(`**/api/pdf-imports/${job.id}/pages/`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().postDataJSON().client_id);
    if (first) { first = false; const accepted = await route.fetch(); expect(accepted.status()).toBe(202); return route.abort('failed'); }
    return route.continue();
  });
  await page.getByRole('button', { name: '選んだページを抽出' }).click();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('同じページ選択で受付結果を確認');
  await expect(page.getByRole('button', { name: '同じページ選択を確認' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByRole('button', { name: /chapter-selection/ }).click();
  await page.getByRole('button', { name: '同じページ選択を確認' }).click();
  await expect(page.getByLabel('読み上げる本文')).toHaveValue(/ONLY_PAGE_052/, { timeout: 35_000 });
  const extracted = await page.getByLabel('読み上げる本文').inputValue();
  expect(extracted).toContain('ONLY_PAGE_054'); expect(extracted).not.toContain('ONLY_PAGE_051');
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  expect((await (await page.request.get(`/api/pdf-imports/${job.id}/`)).json()).selection_revision).toBe(1);
  await page.getByLabel('タイトル', { exact: true }).fill('選んだ章');
  await page.getByLabel('読み順と本文を確認しました').check();
  await page.screenshot({ path: testInfo.outputPath('desktop-selected-pages-review.png'), fullPage: true });
  const confirmed = page.waitForResponse(r => r.url().endsWith(`/pdf-imports/${job.id}/confirm/`));
  await page.getByRole('button', { name: '本文を確定して保存' }).click();
  const result = await confirmed; expect(result.status()).toBe(201); const doc = await result.json();
  expect(doc.source_pdf).toMatchObject({ start_page: 52, end_page: 54, page_count: 60, selection_revision: 1 });
  await page.reload();
  await page.locator('.document-choice').filter({ hasText: '選んだ章' }).click();
  await page.getByText('資料の本文', { exact: true }).click();
  await expect(page.getByTestId('source-context')).toHaveText(extracted);
  const context = await browser.newContext();
  await installLoginPacing(context);
  const other = await context.newPage();
  try {
    await login(other, process.env.LC_E2E_BOB!);
    expect((await other.request.get(`/api/pdf-imports/${job.id}/source/`)).status()).toBe(404);
    expect((await other.request.post(`/api/pdf-imports/${job.id}/pages/`, { headers: { 'X-CSRFToken': await token(other) }, data: { client_id: randomUUID(), start_page: 1, end_page: 2, revision: 1 } })).status()).toBe(404);
  } finally { await context.close(); }
});

test('a stale page selection is refused, then explicitly refreshes the latest draft instead of overwriting it', async ({ page }) => {
  const job = await upload(page, 3);
  await expect(page.getByLabel('読み上げる本文')).toHaveValue(/ONLY_PAGE_001/, { timeout: 35_000 });
  await page.getByText('抽出ページを変更', { exact: true }).click();
  await page.getByLabel('開始ページ').fill('2');
  await page.getByLabel('終了ページ').fill('2');
  const newer = await page.request.post(`/api/pdf-imports/${job.id}/pages/`, { headers: { 'X-CSRFToken': await token(page) }, data: { client_id: randomUUID(), start_page: 3, end_page: 3, revision: 0 } });
  expect(newer.status()).toBe(202);
  await page.getByRole('button', { name: '選んだページを抽出' }).click();
  await expect(page.getByRole('alert')).toContainText('別の画面でページが変更');
  await expect(page.getByRole('button', { name: '同じページ選択を確認' })).toHaveCount(0);
  await page.getByRole('button', { name: '最新の取込状況を確認' }).click();
  await expect(page.getByLabel('読み上げる本文')).toHaveValue('ONLY_PAGE_003', { timeout: 35_000 });
  const latest = await (await page.request.get(`/api/pdf-imports/${job.id}/`)).json();
  expect(latest).toMatchObject({ selection_revision: 1, start_page: 3, end_page: 3 });
});
