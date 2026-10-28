import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures/accounts';

// Synthetic title/text/WAV and isolated API/PG data. Screenshots are actual
// Chromium captures, not human usability or physical-device acceptance.
test('memo controls and help stay concise while long titles and unsaved state remain accessible', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/session/')).json();
  const headers = { 'X-CSRFToken': session.csrfToken };
  const demoResponse = await page.request.post('/api/documents/demo/', { headers });
  expect([200, 201]).toContain(demoResponse.status());
  const document = await demoResponse.json();
  const title = '授業資料 — ' + 'データベースとネットワークの復習ノート・'.repeat(7);
  const renamed = await page.request.patch(`/api/documents/${document.id}/`, { headers, data: {
    title, expected_version: document.current_version.id, expected_updated_at: document.updated_at,
  } });
  expect(renamed.status()).toBe(200);
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  try {
    const memoResponse = await page.request.post('/api/memos/', { headers, multipart: {
      client_id: randomUUID(), audio_version: document.audio_versions[0].id,
      position_ms: '12000', duration_ms: '1000', text: '',
      audio: { name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav },
    } });
    expect(memoResponse.status()).toBe(201);
    const memo = await memoResponse.json();
    await page.reload();
    for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.getByRole('button', { name: /声のメモ/ }).click();
      const card = page.getByTestId('memo-card');
      const heading = card.getByRole('heading', { name: title, exact: true });
      await expect(heading).toHaveText(title);
      await expect(heading).toHaveAttribute('title', title);
      expect(await heading.evaluate(element => element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) * 2 + 1)).toBe(true);
      await expect(card.locator('.memo-position')).toHaveText('教材 0:12');
      const input = card.getByLabel('メモ', { exact: true });
      await expect(input).toBeVisible();
      expect(await input.getAttribute('placeholder')).toBeNull();
      await expect(card.getByRole('button', { name: '元の位置へ戻る', exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: '削除', exact: true })).toBeVisible();
      await input.fill(`保存前のメモ ${viewport.width}`);
      await expect(card.locator('.draft-status')).toContainText('サーバー保存は未確認');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`memo-concise-${viewport.width}.png`), fullPage: true });
      await card.getByRole('button', { name: '文章を保存', exact: true }).click();
      await expect(card.locator('.draft-status')).toHaveCount(0);
      expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe(`保存前のメモ ${viewport.width}`);
      await card.getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
      await expect(page.getByTestId('play-toggle')).toBeEnabled();
      await expect(page.getByRole('heading', { name: title, exact: true })).toHaveText(title);
      const libraryTitle = page.locator('.document-choice strong');
      await expect(libraryTitle).toHaveText(title);
      expect(await libraryTitle.evaluate(element => element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) * 2 + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`player-concise-${viewport.width}.png`), fullPage: true });
      await page.getByRole('button', { name: '使い方', exact: true }).click();
      const help = page.getByRole('region', { name: '使い方', exact: true });
      await expect(help.locator('.help-step')).toHaveCount(3);
      for (const name of ['資料を追加', '聴く・録音する', 'メモを確認'])
        await expect(help.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await help.locator('details[open]').count()).toBe(0);
      await help.getByText('「端末内」と「サーバー保存済み」の違い', { exact: true }).click();
      await expect(help.getByText('端末内の一時保存はバックアップではありません。', { exact: false })).toBeVisible();
      await expect(help.getByText('タブを閉じる前に再送するかダウンロードしてください。', { exact: false })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`help-concise-${viewport.width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect((await (await page.request.get(`/api/documents/${document.id}/`)).json()).title).toBe(title);
  } finally {
    page.on('dialog', dialog => void dialog.accept());
    await page.goto('about:blank');
    const current = await (await page.request.get('/api/session/')).json();
    if (current.user?.username === process.env.LC_E2E_ALICE)
      expect((await page.request.delete(`/api/documents/${document.id}/`, { headers: { 'X-CSRFToken': current.csrfToken } })).status()).toBe(204);
  }
});
