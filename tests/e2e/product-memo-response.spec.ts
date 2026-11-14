import { expect, test } from './fixtures/accounts';
import { randomUUID } from 'node:crypto';

test('a committed supplementary save with a lost response can be explicitly reverted to the original text', async ({ page }) => {
  // Synthetic WAV and isolated accounts; this checks an uncertain text PATCH,
  // not real microphone quality. The existing recording receipt is unchanged.
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
  const { csrfToken } = await (await page.request.get('/api/session/')).json();
  const document = await (await page.request.post('/api/documents/demo/', { headers: { 'X-CSRFToken': csrfToken } })).json();
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  const created = await page.request.post('/api/memos/', { headers: { 'X-CSRFToken': csrfToken }, multipart: {
    client_id: randomUUID(), audio_version: document.audio_versions[0].id,
    position_ms: '12000', duration_ms: '1000', text: '',
    audio: { name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav },
  } });
  expect(created.status()).toBe(201);
  const memo = await created.json();
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  const card = page.getByTestId('memo-card');
  await expect(card).toHaveCount(1);
  const errors: string[] = [];
  let expectedLoss = 1;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => {
    if (event.type() !== 'error') return;
    if (expectedLoss && event.location().url.endsWith(`/api/memos/${memo.id}/`) && /net::ERR_FAILED/.test(event.text())) { expectedLoss--; return; }
    errors.push(event.text());
  });
  let first = true;
  await page.route(`**/api/memos/${memo.id}/`, async route => {
    if (route.request().method() !== 'PATCH' || !first) return route.continue();
    first = false;
    expect((await route.fetch()).status()).toBe(200); // Server committed; only ACK is lost.
    await route.abort('failed');
  });
  const input = card.getByLabel('メモ', { exact: true });
  await input.fill('保存できたか分からない補足。');
  await card.getByRole('button', { name: '文章を保存', exact: true }).click();
  await expect(page.getByTestId('status')).toContainText('補足の保存結果を確認できませんでした');
  expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe('保存できたか分からない補足。');
  await input.fill(''); // Equals the old UI snapshot, not the server's current text.
  const save = card.getByRole('button', { name: '文章を保存', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByTestId('status')).toContainText('文章メモを保存しました');
  expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe('');
  await expect(save).toHaveCount(0);
  await expect(input).toHaveValue('');
  expect(errors).toEqual([]);
});
