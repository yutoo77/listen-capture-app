import { expect, test, type Page } from './fixtures/accounts';

const created = new WeakMap<Page, string[]>();

async function login(page: Page) {
  if (!process.env.LC_E2E_ALICE || !process.env.LC_E2E_PASSWORD)
    throw new Error('Run through scripts/run-e2e.py with temporary E2E users.');
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(process.env.LC_E2E_ALICE);
  await page.getByLabel('パスワード', { exact: true }).fill(process.env.LC_E2E_PASSWORD);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}

test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  const session = await page.request.get('/api/session/');
  if (!session.ok()) return;
  const account = await session.json();
  if (account.user?.username !== process.env.LC_E2E_ALICE) return;
  for (const id of created.get(page) ?? [])
    expect((await page.request.delete(`/api/documents/${id}/`, { headers: { 'X-CSRFToken': account.csrfToken } })).status()).toBe(204);
});

test('long context moves the active passage into the viewport and returns to the same player', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  test.skip(process.env.LC_E2E_LONG_AUDIO === '1', 'Uses ordinary three-second fixtures, not the opt-in long-playlist profile.');
  testInfo.annotations.push({ type: 'evidence', description: 'Automated browser viewport and keyboard checks with synthetic silent audio; not human usability or microphone testing.' });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  created.set(page, []);
  await login(page);
  const configuration = await (await page.request.get('/api/narration/config/')).json();
  expect(configuration.providers.find((item: { id: string }) => item.id === 'fixture')?.enabled).toBe(true);
  expect(configuration.fixture_segment_duration_ms ?? 3000).toBe(3000);
  const original = Array.from('HTTPの応答と資料の文脈を確かめます。🌸長い本文でも自分の疑問に戻れるようにします。'.repeat(600)).slice(0, 18000).join('');
  expect(Array.from(original)).toHaveLength(18000);
  const title = `本文の移動 ${Date.now()}`;
  await page.getByRole('button', { name: '＋ 資料を追加' }).click();
  await page.getByLabel('タイトル', { exact: true }).fill(title);
  await page.getByLabel('資料のテキスト', { exact: true }).fill(original);
  const saving = page.waitForResponse(response => response.url().endsWith('/api/documents/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '資料を保存', exact: true }).click();
  const response = await saving;
  expect(response.status()).toBe(201);
  const document = await response.json();
  created.get(page)!.push(document.id);
  const provider = page.getByLabel('読み上げ音声', { exact: true });
  if (await provider.count()) await provider.selectOption('fixture');
  const accepted = page.waitForResponse(response => response.url().endsWith(`/documents/${document.id}/narration/`) && response.request().method() === 'POST');
  await page.getByTestId('narration-generate').click();
  expect((await accepted).request().postDataJSON().provider).toBe('fixture');
  await expect(page.getByTestId('play-toggle')).toBeEnabled({ timeout: 30000 });
  const saved = await (await page.request.get(`/api/documents/${document.id}/`)).json();
  const audio = saved.audio_versions[0];
  expect(audio.kind).toBe('fixture');
  const mapping = await (await page.request.get(`/api/audio/${audio.id}/narration-map/`)).json();
  expect(mapping.segments.length).toBeGreaterThan(3);
  const last = mapping.segments.at(-1);
  await page.getByLabel('音声の区間', { exact: true }).selectOption(String(last.index));
  await page.getByText('資料の本文', { exact: true }).click();
  await expect(page.getByTestId('source-context')).toHaveText(original);
  const active = page.getByTestId('active-source-block').first();
  await expect(active).toBeVisible();
  const viewport = page.viewportSize()!.height;
  // A visible DOM span can still be thousands of pixels below the viewport.
  expect(await active.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(viewport);
  const position = await page.getByRole('slider', { name: '再生位置', exact: true }).inputValue();
  const jump = page.getByRole('button', { name: '対応する本文へ移動', exact: true });
  await jump.focus();
  await jump.press('Enter');
  await expect.poll(() => active.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  await expect.poll(() => active.evaluate(element => element.getBoundingClientRect().top)).toBeLessThan(viewport);
  const returnPlayer = page.getByRole('button', { name: '再生プレーヤーへ戻る', exact: true });
  await expect(returnPlayer).toBeInViewport();
  const navigationBottom = await page.getByRole('group', { name: '本文と再生の移動', exact: true }).evaluate(element => element.getBoundingClientRect().bottom);
  expect(await active.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(navigationBottom);
  await page.screenshot({ path: testInfo.outputPath('active-source-passage.png') });
  await returnPlayer.focus();
  await returnPlayer.press('Enter');
  const play = page.getByTestId('play-toggle');
  await expect(play).toBeInViewport();
  const bounds = await play.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport);
  expect(await page.getByRole('slider', { name: '再生位置', exact: true }).inputValue()).toBe(position);
  expect(await page.getByTestId('source-audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  await expect(page.getByLabel('音声の区間', { exact: true })).toHaveValue(String(last.index));
  await page.screenshot({ path: testInfo.outputPath('returned-player.png') });
  expect(errors).toEqual([]);
});
