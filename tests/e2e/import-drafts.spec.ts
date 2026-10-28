import { expect, test, type Page } from './fixtures/accounts';
import { textPdf } from './fixtures/pdf';

// Real browser forms and real API/parser persistence with synthetic documents.
// These checks make no claim about human listening or microphone quality.
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => { await login(page); });
test.afterEach(async ({ page }) => {
  const accept = (dialog: import('@playwright/test').Dialog) => void dialog.accept();
  page.on('dialog', accept);
  await page.goto('about:blank');
  page.off('dialog', accept);
  const session = await (await page.request.get('/api/session/')).json();
  if (session.user?.username !== process.env.LC_E2E_ALICE) return;
  const headers = { 'X-CSRFToken': session.csrfToken };
  for (const doc of await (await page.request.get('/api/documents/')).json())
    expect((await page.request.delete(`/api/documents/${doc.id}/`, { headers })).status()).toBe(204);
  for (const job of await (await page.request.get('/api/pdf-imports/')).json())
    expect((await page.request.delete(`/api/pdf-imports/${job.id}/`, { headers })).status()).toBe(204);
});

async function newText(page: Page) {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill('入力途中の教材');
  await page.getByLabel('資料のテキスト', { exact: true }).fill('送信前の日本語本文です。');
}

async function dismissReload(page: Page) {
  const beforeUnload = page.waitForEvent('dialog');
  // Do not await page.reload(): a dismissed native beforeunload keeps it pending.
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const dialog = await beforeUnload;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
}

async function uploadPdf(page: Page) {
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByLabel('PDFファイル', { exact: true }).setInputFiles({
    name: 'draft-protection.pdf', mimeType: 'application/pdf', buffer: textPdf(),
  });
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/pdf-imports/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
  expect([200, 202]).toContain((await accepted).status());
  await expect(page.getByLabel('読み上げる本文', { exact: true })).toHaveValue(/Learning HTTP/, { timeout: 35_000 });
}

test('text input survives method changes and cancelled navigation, then saving removes the leave guard', async ({ page }) => {
  await newText(page);
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('入力途中の教材');
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('送信前の日本語本文です。');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '← ライブラリへ戻る', exact: true }).click();
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('送信前の日本語本文です。');
  await dismissReload(page);
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('送信前の日本語本文です。');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '入力途中の教材', exact: true })).toBeVisible();
  // A stale import dirty flag must not warn after the acknowledged form unmounts.
  const dialogs: string[] = [];
  const accept = (dialog: import('@playwright/test').Dialog) => { dialogs.push(dialog.type()); void dialog.accept(); };
  page.on('dialog', accept);
  await page.reload();
  page.off('dialog', accept);
  expect(dialogs).toEqual([]);
  expect((await (await page.request.get('/api/documents/')).json())[0].current_version.text).toBe('送信前の日本語本文です。');
});

test('logout preserves the same account and input when cancelled, and discards only after confirmation', async ({ page }) => {
  await newText(page);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('送信前の日本語本文です。');
  expect((await (await page.request.get('/api/session/')).json()).user.username).toBe(process.env.LC_E2E_ALICE);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
  await login(page);
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('');
});

test('corrected PDF input survives method changes and rejects accidental discard or replacement', async ({ page }) => {
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await uploadPdf(page);
  await page.getByLabel('タイトル', { exact: true }).fill('校正中のPDF教材');
  await page.getByText('抽出ページを変更', { exact: true }).click();
  let pageSelections = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/pages/')) pageSelections++; });
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '選んだページを抽出', exact: true }).click();
  expect(pageSelections).toBe(0);
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('校正中のPDF教材');
  await page.getByLabel('読み上げる本文', { exact: true }).fill('原文と照らして直した本文です。');
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(page.getByLabel('読み上げる本文', { exact: true })).toHaveValue('原文と照らして直した本文です。');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '別のPDFを取り込む', exact: true }).click();
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('校正中のPDF教材');
  await dismissReload(page);
  await expect(page.getByLabel('読み上げる本文', { exact: true })).toHaveValue('原文と照らして直した本文です。');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '← ライブラリへ戻る', exact: true }).click();
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('校正中のPDF教材');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '← ライブラリへ戻る', exact: true }).click();
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  // History displays the server's suggested title (filename stem), not .pdf.
  await page.locator('.import-history').getByRole('button', { name: /^draft-protection/ }).click();
  await expect(page.getByLabel('読み上げる本文', { exact: true })).toHaveValue(/Learning HTTP/);
  expect(await (await page.request.get('/api/documents/')).json()).toEqual([]);
});

test('saving a PDF asks before discarding a retained text draft and clears the guard after success', async ({ page }) => {
  await newText(page);
  await uploadPdf(page);
  await page.getByLabel('読み順と本文を確認しました').check();
  let confirmations = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/confirm/')) confirmations++; });
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '本文を確定して保存', exact: true }).click();
  expect(confirmations).toBe(0);
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('送信前の日本語本文です。');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/confirm/'));
  await page.getByRole('button', { name: '本文を確定して保存', exact: true }).click();
  expect((await accepted).status()).toBe(201);
  await expect(page.getByRole('heading', { name: 'draft-protection', exact: true })).toBeVisible();
  expect(confirmations).toBe(1);
  const dialogs: string[] = [];
  const accept = (dialog: import('@playwright/test').Dialog) => { dialogs.push(dialog.type()); void dialog.accept(); };
  page.on('dialog', accept);
  await page.reload();
  page.off('dialog', accept);
  expect(dialogs).toEqual([]);
});

test('text saving preserves both drafts when PDF discard is cancelled, and unmodified PDF input needs no discard confirmation', async ({ page }) => {
  await newText(page);
  await uploadPdf(page);
  await page.getByLabel('タイトル', { exact: true }).fill('まだ確定していないPDF');
  await page.getByLabel('読み上げる本文', { exact: true }).fill('PDF側だけで修正した本文です。');
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  let creations = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/documents/')) creations++; });
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  expect(creations).toBe(0);
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('入力途中の教材');
  await expect(page.getByLabel('資料のテキスト', { exact: true })).toHaveValue('送信前の日本語本文です。');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveValue('まだ確定していないPDF');
  await expect(page.getByLabel('読み上げる本文', { exact: true })).toHaveValue('PDF側だけで修正した本文です。');
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  const first = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/documents/'));
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  const firstSaved = await first;
  expect(firstSaved.status()).toBe(201);
  expect((await firstSaved.json()).current_version.text).toBe('送信前の日本語本文です。');
  await expect(page.getByRole('heading', { name: '入力途中の教材', exact: true })).toBeVisible();

  // Merely visiting a freshly extracted PDF is not an edited PDF draft.
  await newText(page);
  await page.getByLabel('タイトル', { exact: true }).fill('二つ目のテキスト教材');
  await uploadPdf(page);
  await page.getByRole('button', { name: 'テキスト', exact: true }).click();
  const dialogs: string[] = [];
  const accept = (dialog: import('@playwright/test').Dialog) => { dialogs.push(dialog.type()); void dialog.accept(); };
  page.on('dialog', accept);
  const second = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/documents/'));
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  expect((await second).status()).toBe(201);
  await expect(page.getByRole('heading', { name: '二つ目のテキスト教材', exact: true })).toBeVisible();
  page.off('dialog', accept);
  expect(dialogs).toEqual([]);
  expect(creations).toBe(2);
});
