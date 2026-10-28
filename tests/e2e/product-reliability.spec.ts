import { expect, test, type Page, type Route } from './fixtures/accounts';
import { createHash, randomUUID } from 'node:crypto';

type Document = {
  id: string;
  title: string;
  audio_versions: { id: string }[];
};
type Memo = {
  id: string;
  text: string;
  media_url: string;
  document: { id: string; title: string };
};
type UploadEvidence = {
  clientId: string;
  audioVersion: string;
  positionMs: number;
  durationMs: number;
  text: string;
  size: number;
  sha256: string;
};
type PendingEvidence = UploadEvidence & {
  userId: string;
  documentId: string;
  createdAt: string;
};
type Diagnostics = {
  errors: string[];
  expectedUnavailable: Set<string>;
  expectedForbidden: Map<string, number>;
};
const diagnostics = new WeakMap<Page, Diagnostics>();
const created = new WeakMap<Page, string[]>();

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function login(page: Page, name: 'ALICE' | 'BOB' = 'ALICE') {
  const username = process.env[`LC_E2E_${name}`];
  const password = process.env.LC_E2E_PASSWORD;
  if (!username || !password) throw new Error('Run through scripts/run-e2e.py with isolated accounts.');
  await page.goto('/');
  await page.getByLabel('ユーザー名', { exact: true }).fill(username);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログアウト', exact: true })).toBeVisible();
}

async function demo(page: Page): Promise<Document> {
  const accepted = page.waitForResponse(response => response.url().endsWith('/api/documents/demo/') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /デモ音声で試す/ }).click();
  const response = await accepted;
  expect([200, 201]).toContain(response.status());
  const document = await response.json() as Document;
  created.get(page)!.push(document.id);
  await expect(page.getByTestId('record-toggle')).toBeEnabled();
  return document;
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

function multipartPart(body: Buffer, contentType: string, name: string): Buffer {
  const boundary = /\bboundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  if (!boundary) throw new Error('Expected a browser multipart recording.');
  const divider = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const nextDivider = Buffer.concat([Buffer.from('\r\n'), divider]);
  let cursor = body.indexOf(divider);
  while (cursor >= 0) {
    const start = cursor + divider.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const headersEnd = body.indexOf('\r\n\r\n', start + 2);
    const end = body.indexOf(nextDivider, headersEnd + 4);
    if (headersEnd < 0 || end < 0) break;
    const headers = body.subarray(start + 2, headersEnd).toString();
    const disposition = /^Content-Disposition:\s*form-data;\s*name="([^"]+)"/im.exec(headers);
    if (disposition?.[1] === name) return body.subarray(headersEnd + 4, end);
    cursor = end + 2;
  }
  throw new Error(`Missing multipart ${name}.`);
}

function uploadEvidence(route: Route): UploadEvidence {
  const body = route.request().postDataBuffer();
  if (!body) throw new Error('A recording upload needs a multipart body.');
  const contentType = route.request().headers()['content-type'];
  const audio = multipartPart(body, contentType, 'audio');
  return {
    clientId: multipartPart(body, contentType, 'client_id').toString(),
    audioVersion: multipartPart(body, contentType, 'audio_version').toString(),
    positionMs: Number(multipartPart(body, contentType, 'position_ms').toString()),
    durationMs: Number(multipartPart(body, contentType, 'duration_ms').toString()),
    text: multipartPart(body, contentType, 'text').toString(),
    size: audio.length,
    sha256: createHash('sha256').update(audio).digest('hex'),
  };
}

async function pendingRecording(page: Page): Promise<PendingEvidence[]> {
  return page.evaluate(async () => {
    const items = await new Promise<{
      clientId: string; userId: string; blob: Blob; documentId: string;
      audioVersion: string; positionMs: number; durationMs: number; text: string; createdAt: string;
    }[]>((resolve, reject) => {
      const opening = indexedDB.open('listen-capture-outbox-v1', 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction('recordings', 'readonly');
        const request = transaction.objectStore('recordings').getAll();
        transaction.oncomplete = () => { database.close(); resolve(request.result); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    return Promise.all(items.map(async item => ({
      clientId: item.clientId,
      userId: item.userId,
      documentId: item.documentId,
      audioVersion: item.audioVersion,
      positionMs: item.positionMs,
      durationMs: item.durationMs,
      text: item.text,
      createdAt: item.createdAt,
      size: item.blob.size,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await item.blob.arrayBuffer())))
        .map(byte => byte.toString(16).padStart(2, '0')).join(''),
    })));
  });
}

async function expectOriginalSaved(page: Page, original: PendingEvidence, attempts: UploadEvidence[]) {
  expect(attempts).toEqual([{
    clientId: original.clientId,
    audioVersion: original.audioVersion,
    positionMs: original.positionMs,
    durationMs: original.durationMs,
    text: original.text,
    size: original.size,
    sha256: original.sha256,
  }]);
  expect(await pendingRecording(page)).toEqual([]);
  const response = await page.request.get('/api/memos/');
  expect(response.status()).toBe(200);
  const saved = await response.json();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    client_id: original.clientId,
    audio_version: original.audioVersion,
    document: { id: original.documentId },
    position_ms: original.positionMs,
    duration_ms: original.durationMs,
    text: original.text,
  });
  const media = await page.request.get(saved[0].media_url);
  expect(media.status()).toBe(200);
  const bytes = await media.body();
  expect(bytes.length).toBe(original.size);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.sha256);
}

async function seededMemo(page: Page): Promise<{ document: Document; memo: Memo }> {
  const document = await demo(page);
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
  const memo = await response.json() as Memo;
  await page.reload();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(page.getByTestId('memo-card')).toHaveCount(1);
  return { document, memo };
}

const draftInput = (page: Page) => page.getByTestId('memo-card').getByLabel('メモ', { exact: true });
const documentChoice = (page: Page, document: Document) => page.locator('.document-list').getByRole('button').filter({ hasText: document.title });

test.beforeEach(async ({ page }, info) => {
  test.skip(process.env.LC_E2E_LONG_AUDIO === '1', 'Uses the ordinary demo profile.');
  info.annotations.push({ type: 'evidence', description: 'Isolated accounts, synthetic WAV seeds and Chromium fake-microphone MediaRecorder; not physical microphone, human usability or iPhone evidence.' });
  created.set(page, []);
  const state: Diagnostics = { errors: [], expectedUnavailable: new Set(), expectedForbidden: new Map() };
  diagnostics.set(page, state);
  page.on('pageerror', error => state.errors.push(`pageerror: ${error.message}`));
  page.on('console', event => {
    if (event.type() !== 'error') return;
    const expectedPath = [...state.expectedUnavailable].some(path => event.location().url.endsWith(path));
    if (expectedPath && /the server responded with a status of 503\b/.test(event.text())) return;
    const forbiddenPath = [...state.expectedForbidden.keys()].find(path => event.location().url.endsWith(path));
    if (forbiddenPath && /the server responded with a status of 403\b/.test(event.text()) && state.expectedForbidden.get(forbiddenPath)! > 0) {
      state.expectedForbidden.set(forbiddenPath, state.expectedForbidden.get(forbiddenPath)! - 1);
      return;
    }
    state.errors.push(`console: ${event.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  // Discard only test-owned unsaved drafts while unmounting before API cleanup.
  page.once('dialog', dialog => dialog.accept());
  await page.goto('about:blank');
  const session = await page.request.get('/api/session/');
  if (session.ok()) {
    const account = await session.json();
    if (account.user?.username === process.env.LC_E2E_ALICE) {
      for (const id of new Set(created.get(page) ?? [])) {
        const removed = await page.request.delete(`/api/documents/${id}/`, { headers: { 'X-CSRFToken': account.csrfToken } });
        expect(removed.status()).toBe(204);
      }
    }
  }
  expect(diagnostics.get(page)?.errors ?? []).toEqual([]);
});

test('late initial snapshots preserve a newly created document and an acknowledged recording', async ({ page }) => {
  const captured = { documents: latch(), memos: latch() };
  const release = latch();
  const delivered = { documents: latch(), memos: latch() };
  for (const name of ['documents', 'memos'] as const) {
    let first = true;
    await page.route(`**/api/${name}/`, async route => {
      if (route.request().method() !== 'GET' || !first) return route.continue();
      first = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const body = await response.body();
      expect(JSON.parse(body.toString())).toEqual([]);
      captured[name].resolve();
      await release.promise;
      try { await route.fulfill({ response, body }); }
      finally { delivered[name].resolve(); }
    });
  }
  try {
    await login(page);
    await Promise.all([captured.documents.promise, captured.memos.promise]);
    const document = await demo(page);
    await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => { audio.currentTime = 12; });
    await page.getByTestId('play-toggle').click();
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
    await page.waitForTimeout(1200); // A real encoded duration is required by ffprobe.
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
    await page.getByTestId('record-toggle').click();
    const response = await accepted;
    expect(response.status()).toBe(201);
    const memo = await response.json() as Memo;
    expect(memo.document.id).toBe(document.id);
    await expect(page.getByTestId('recent-memo')).toBeVisible();
    release.resolve();
    await Promise.all([delivered.documents.promise, delivered.memos.promise]);
    await expect(page.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
    await expect(documentChoice(page, document)).toHaveCount(1);
    await page.getByRole('button', { name: /声のメモ/ }).click();
    await expect(page.getByTestId('memo-card')).toHaveCount(1);
    await expect(page.getByTestId('memo-card').locator('audio')).toHaveAttribute('src', memo.media_url);
  } finally {
    release.resolve();
    await page.unroute('**/api/documents/');
    await page.unroute('**/api/memos/');
  }
});

test('unsaved supplementary text survives tab changes and a return to the source position', async ({ page }) => {
  await login(page);
  await seededMemo(page);
  const draft = '応答を失ったときも、同じUUIDで結果を確かめたい。';
  await draftInput(page).fill(draft);
  await page.getByRole('button', { name: '聴く', exact: true }).click();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(draftInput(page)).toHaveValue(draft);
  await page.getByTestId('memo-card').getByRole('button', { name: '元の位置へ戻る', exact: true }).click();
  await expect(page.getByTestId('play-toggle')).toBeEnabled();
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(draftInput(page)).toHaveValue(draft);
  await expect(page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true })).toBeVisible();
});

test('an older supplementary-text acknowledgment does not erase a newer draft after tab navigation', async ({ page }) => {
  await login(page);
  const { memo } = await seededMemo(page);
  const committed = latch();
  const release = latch();
  let first = true;
  await page.route(`**/api/memos/${memo.id}/`, async route => {
    if (route.request().method() !== 'PATCH' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  const oldText = '先に送った補足。';
  const newText = '送信待ちの間に考え直した、新しい補足。';
  try {
    await draftInput(page).fill(oldText);
    await page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true }).click();
    await committed.promise;
    await page.getByRole('button', { name: '聴く', exact: true }).click();
    await page.getByRole('button', { name: /声のメモ/ }).click();
    await expect(draftInput(page)).toHaveValue(oldText);
    await draftInput(page).fill(newText);
    const acknowledged = page.waitForResponse(response => response.url().endsWith(`/api/memos/${memo.id}/`) && response.request().method() === 'PATCH');
    release.resolve();
    expect((await acknowledged).status()).toBe(200);
    await expect(page.getByTestId('status')).toContainText('新しい編集は未保存です');
    await expect(draftInput(page)).toHaveValue(newText);
    await page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe(newText);
  } finally {
    release.resolve();
    await page.unroute(`**/api/memos/${memo.id}/`);
  }
});

test('returning a draft to its original saved value during a PATCH still preserves that newer edit', async ({ page }) => {
  await login(page);
  const { memo } = await seededMemo(page);
  expect(memo.text).toBe('');
  const committed = latch();
  const release = latch();
  let first = true;
  await page.route(`**/api/memos/${memo.id}/`, async route => {
    if (route.request().method() !== 'PATCH' || !first) return route.continue();
    first = false;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await draftInput(page).fill('送信したけれど、やはり補足を空に戻したい。');
    await page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true }).click();
    await committed.promise;
    await page.getByRole('button', { name: '聴く', exact: true }).click();
    await page.getByRole('button', { name: /声のメモ/ }).click();
    await draftInput(page).fill('');
    const acknowledged = page.waitForResponse(response => response.url().endsWith(`/api/memos/${memo.id}/`) && response.request().method() === 'PATCH');
    release.resolve();
    expect((await acknowledged).status()).toBe(200);
    await expect(page.getByTestId('status')).toContainText('新しい編集は未保存です');
    await expect(draftInput(page)).toHaveValue('');
    const save = page.getByTestId('memo-card').getByRole('button', { name: /^(文章を保存|補足を保存中…)$/ });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(async () => (await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe('');
  } finally {
    release.resolve();
    await page.unroute(`**/api/memos/${memo.id}/`);
  }
});

test('a supplementary-text save remains single-flight after navigation while newer text stays editable', async ({ page }) => {
  await login(page);
  const { memo } = await seededMemo(page);
  const committed = latch();
  const release = latch();
  let patches = 0;
  await page.route(`**/api/memos/${memo.id}/`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches++;
    if (patches !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  const newText = '画面を移動しても、前の保存を待ちながら考えを編集できる。';
  try {
    await draftInput(page).fill('最初の補足。');
    await page.getByTestId('memo-card').getByRole('button', { name: '文章を保存', exact: true }).click();
    await committed.promise;
    await page.getByRole('button', { name: '聴く', exact: true }).click();
    await page.getByRole('button', { name: /声のメモ/ }).click();
    await expect(draftInput(page)).toBeEditable();
    await draftInput(page).fill(newText);
    const save = page.getByTestId('memo-card').getByRole('button', { name: /^(文章を保存|補足を保存中…)$/ });
    await expect(save).toBeDisabled();
    expect(patches).toBe(1);
    const acknowledged = page.waitForResponse(response => response.url().endsWith(`/api/memos/${memo.id}/`) && response.request().method() === 'PATCH');
    release.resolve();
    expect((await acknowledged).status()).toBe(200);
    await expect(draftInput(page)).toHaveValue(newText);
    await expect(save).toBeEnabled();
    const savedNewText = page.waitForResponse(response => response.url().endsWith(`/api/memos/${memo.id}/`) && response.request().method() === 'PATCH');
    await save.click();
    expect((await savedNewText).status()).toBe(200);
    expect(patches).toBe(2);
    await expect.poll(async () => (await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe(newText);
  } finally {
    release.resolve();
    await page.unroute(`**/api/memos/${memo.id}/`);
  }
});

test('a dirty supplementary draft warns before reload and stays intact when navigation is cancelled', async ({ page }) => {
  await login(page);
  await seededMemo(page);
  const draft = '再読み込みの前に、この未保存の考えに気づけること。';
  await draftInput(page).fill(draft);
  const dialogPromise = page.waitForEvent('dialog');
  const documentMarker = randomUUID();
  // A dismissed beforeunload dialog can leave Playwright's reload() waiting
  // for a load that correctly never happens. Schedule the browser action
  // instead, then prove that both the original document and its draft remain.
  await page.evaluate(marker => {
    Object.assign(window, { __lcDraftGuardDocument: marker });
    setTimeout(() => location.reload(), 0);
  }, documentMarker);
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await expect(draftInput(page)).toHaveValue(draft);
  expect(await page.evaluate(() => (window as Window & { __lcDraftGuardDocument?: string }).__lcDraftGuardDocument)).toBe(documentMarker);
});

test('supplementary drafts are discarded only after confirmed logout and do not cross account sessions', async ({ page }) => {
  await login(page);
  const { memo } = await seededMemo(page);
  const draft = 'このセッションだけの、まだ保存していない考え。';
  await draftInput(page).fill(draft);
  const confirmation = page.waitForEvent('dialog');
  const loggingOut = page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  const dialog = await confirmation;
  expect(dialog.type()).toBe('confirm');
  await dialog.accept();
  await loggingOut;
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
  await login(page, 'BOB');
  await expect(page.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(page.getByTestId('memo-card')).toHaveCount(0);
  await expect(page.getByText(draft, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
  await login(page);
  await page.getByRole('button', { name: /声のメモ/ }).click();
  await expect(draftInput(page)).toHaveValue('');
  expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).text).toBe('');
});

test('an expired session keeps the recording and only retries its original bytes after the same account signs in again', async ({ page }) => {
  await login(page);
  const document = await demo(page);
  const accountResponse = await page.request.get('/api/session/');
  expect(accountResponse.status()).toBe(200);
  const account = await accountResponse.json();
  const attempts: UploadEvidence[] = [];
  const inspectUpload = async (route: Route) => {
    if (route.request().method() === 'POST') attempts.push(uploadEvidence(route));
    await route.continue();
  };
  await page.context().route('**/api/memos/', inspectUpload);
  let reauthentication: Page | undefined;
  try {
    const positionSaved = page.waitForResponse(response => response.url().endsWith(`/api/audio/${document.audio_versions[0].id}/progress/`) && response.request().method() === 'PUT');
    await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => { audio.currentTime = 12; });
    expect((await positionSaved).status()).toBe(200);
    await expect(page.getByTestId('progress-status')).toContainText('再生位置を保存済み');
    // Capture from this settled, paused anchor so unrelated background progress
    // writes do not race the intentional session expiration below.
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
    // End only this isolated test user's real server session while its current
    // workspace and MediaRecorder remain alive with their original CSRF token.
    const expired = await page.request.post('/api/logout/', { headers: { 'X-CSRFToken': account.csrfToken } });
    expect(expired.status()).toBe(204);
    await page.waitForTimeout(1200);
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('pending-memo')).toHaveCount(1);
    await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
    const heading = page.getByRole('heading', { name: '元のアカウントでログインし直してください', exact: true });
    await expect(heading).toBeVisible();
    const originals = await pendingRecording(page);
    expect(originals).toHaveLength(1);
    expect(originals[0].userId).toBe(account.user.id);
    expect(originals[0].documentId).toBe(document.id);
    expect(originals[0].audioVersion).toBe(document.audio_versions[0].id);
    expect(originals[0].positionMs).toBe(12000);
    expect(originals[0].durationMs).toBeGreaterThan(0);
    expect(originals[0].size).toBeGreaterThan(0);
    expect(attempts).toEqual([]); // The initial send must also check the live session before sending bytes.

    await page.getByTestId('pending-memo').getByRole('button', { name: '保存を再試行', exact: true }).click();
    await expect(heading).toBeVisible();
    expect(attempts).toHaveLength(0); // Session null must not submit the file.
    expect(await pendingRecording(page)).toEqual(originals);
    const signInLink = page.getByRole('link', { name: '別タブでログイン', exact: true });
    await expect(signInLink).toHaveAttribute('target', '_blank');
    const destination = await signInLink.getAttribute('href');
    expect(destination).toBeTruthy();
    expect(new URL(destination!, page.url()).origin).toBe(new URL(page.url()).origin);
    [reauthentication] = await Promise.all([page.waitForEvent('popup'), signInLink.click()]);
    await login(reauthentication, 'BOB');
    await expect(reauthentication.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
    const checkedOtherAccount = page.waitForResponse(response => response.url().endsWith('/api/session/') && response.request().method() === 'GET');
    await page.getByTestId('pending-memo').getByRole('button', { name: '保存を再試行', exact: true }).click();
    expect((await checkedOtherAccount).status()).toBe(200);
    await expect(page.getByTestId('pending-memo').getByRole('button', { name: '保存を再試行', exact: true })).toBeEnabled();
    await expect(heading).toBeVisible();
    expect(attempts).toHaveLength(0); // Another signed-in account must not send it.
    expect(await pendingRecording(page)).toEqual(originals);

    await reauthentication.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await expect(reauthentication.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
    await login(reauthentication);
    await expect(reauthentication.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
    await expect(reauthentication.getByTestId('pending-memo')).toHaveCount(1);
    expect(attempts).toHaveLength(0); // Login alone must not automatically resend.
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
    await page.getByTestId('pending-memo').getByRole('button', { name: '保存を再試行', exact: true }).click();
    expect((await accepted).status()).toBe(201);
    await expect(page.getByTestId('pending-memo')).toHaveCount(0);
    await expect(page.getByTestId('recent-memo')).toBeVisible();
    await expectOriginalSaved(page, originals[0], attempts);
  } finally {
    await page.context().unroute('**/api/memos/', inspectUpload);
    await reauthentication?.close();
  }
});

test('a changed account cannot upload a held final recording until its original owner explicitly retries', async ({ page }) => {
  await login(page);
  const document = await demo(page);
  const account = await (await page.request.get('/api/session/')).json();
  const positionSaved = page.waitForResponse(response => response.url().endsWith(`/api/audio/${document.audio_versions[0].id}/progress/`) && response.request().method() === 'PUT');
  await page.getByTestId('source-audio').evaluate((audio: HTMLAudioElement) => { audio.currentTime = 12; });
  expect((await positionSaved).status()).toBe(200);
  await expect(page.getByTestId('progress-status')).toContainText('再生位置を保存済み');

  // Hold only the real encoder's final callback delivery. Both account changes
  // and all session/owner API responses below remain real server operations.
  await page.evaluate(() => {
    const NativeRecorder = window.MediaRecorder;
    const delayed: (() => void)[] = [];
    class HeldFinalRecorder extends NativeRecorder {
      holdingFinal = false;
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        const listen = this.addEventListener.bind(this);
        this.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (!listener || !['dataavailable', 'stop'].includes(type)) return listen(type, listener, options);
          listen(type, event => {
            const deliver = () => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
            if (this.holdingFinal) delayed.push(deliver);
            else deliver();
          }, options);
        }) as MediaRecorder['addEventListener'];
      }
      override stop() {
        this.holdingFinal = true;
        super.stop();
      }
    }
    window.MediaRecorder = HeldFinalRecorder;
    Object.assign(window, {
      __lcHeldFinalCount: () => delayed.length,
      __lcReleaseFinal: () => delayed.splice(0).forEach(deliver => deliver()),
      __lcRestoreRecorder: () => { window.MediaRecorder = NativeRecorder; },
    });
  });
  const attempts: UploadEvidence[] = [];
  const inspectUpload = async (route: Route) => {
    if (route.request().method() === 'POST') attempts.push(uploadEvidence(route));
    await route.continue();
  };
  await page.context().route('**/api/memos/', inspectUpload);
  let otherTab: Page | undefined;
  try {
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了');
    await page.waitForTimeout(1200);
    await page.getByTestId('record-toggle').click();
    await expect(page.getByTestId('record-toggle')).toHaveText('録音を終了しています…');
    await expect.poll(() => page.evaluate(() => (window as Window & { __lcHeldFinalCount: () => number }).__lcHeldFinalCount())).toBeGreaterThanOrEqual(2);

    // A second tab shares cookies, but must not change the recorder's captured
    // owner and immutable source. Do not reload or recreate A's workspace.
    otherTab = await page.context().newPage();
    await otherTab.goto('/');
    await otherTab.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await expect(otherTab.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
    await login(otherTab, 'BOB');
    await expect(otherTab.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
    const bob = await (await otherTab.request.get('/api/session/')).json();
    expect(bob.user.username).toBe(process.env.LC_E2E_BOB);
    expect(bob.user.id).not.toBe(account.user.id);

    await page.evaluate(() => (window as Window & { __lcReleaseFinal: () => void }).__lcReleaseFinal());
    await expect(page.getByTestId('pending-memo')).toHaveCount(1);
    await expect(page.getByTestId('record-toggle')).toHaveText('メモする');
    await expect(page.getByRole('heading', { name: '元のアカウントでログインし直してください', exact: true })).toBeVisible();
    expect(attempts).toEqual([]);
    const originals = await pendingRecording(page);
    expect(originals).toHaveLength(1);
    expect(originals[0]).toMatchObject({
      userId: account.user.id, documentId: document.id,
      audioVersion: document.audio_versions[0].id, positionMs: 12000, text: '',
    });
    expect(originals[0].size).toBeGreaterThan(0);
    expect(originals[0].durationMs).toBeGreaterThan(0);

    // Reload B after the local Blob exists, proving the other account cannot
    // display or send A's IndexedDB entry, nor see an accidental server memo.
    await otherTab.reload();
    await expect(otherTab.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
    await expect(otherTab.getByTestId('pending-memo')).toHaveCount(0);
    await otherTab.getByRole('button', { name: /声のメモ/ }).click();
    await expect(otherTab.getByTestId('memo-card')).toHaveCount(0);
    const bobMemos = await otherTab.request.get('/api/memos/');
    expect(bobMemos.status()).toBe(200);
    expect(await bobMemos.json()).toEqual([]);
    expect(await pendingRecording(page)).toEqual(originals);
    expect(attempts).toEqual([]);

    await otherTab.getByRole('button', { name: 'ログアウト', exact: true }).click();
    await expect(otherTab.getByRole('button', { name: 'ログイン', exact: true })).toBeVisible();
    await login(otherTab);
    await expect(otherTab.getByRole('region', { name: 'あなたの資料', exact: true })).toHaveAttribute('aria-busy', 'false');
    await expect(otherTab.getByTestId('pending-memo')).toHaveCount(1);
    expect(await pendingRecording(page)).toEqual(originals);
    expect(attempts).toEqual([]); // A's login alone does not send the Blob.
    const accepted = page.waitForResponse(response => response.url().endsWith('/api/memos/') && response.request().method() === 'POST');
    await page.getByTestId('pending-memo').getByRole('button', { name: '保存を再試行', exact: true }).click();
    expect((await accepted).status()).toBe(201);
    await expect(page.getByTestId('pending-memo')).toHaveCount(0);
    await expect(page.getByTestId('recent-memo')).toContainText('サーバー保存済み');
    await expectOriginalSaved(page, originals[0], attempts);
  } finally {
    await page.context().unroute('**/api/memos/', inspectUpload);
    await page.evaluate(() => (window as Window & { __lcRestoreRecorder: () => void }).__lcRestoreRecorder());
    await otherTab?.close();
  }
});

for (const failedList of ['documents', 'memos'] as const) {
  test(`a failed initial ${failedList} list preserves the other list and recovers through explicit reload`, async ({ page }) => {
    await login(page);
    const { document } = await seededMemo(page);
    const path = `/api/${failedList}/`;
    diagnostics.get(page)!.expectedUnavailable.add(path);
    let first = true;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'GET' || !first) return route.continue();
      first = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic one-shot list unavailability.' }) });
    });
    try {
      await page.reload();
      if (failedList === 'memos') {
        await expect(documentChoice(page, document)).toHaveCount(1);
      } else {
        await page.getByRole('button', { name: /声のメモ/ }).click();
        await expect(page.getByTestId('memo-card')).toHaveCount(1);
      }
      await page.getByRole('button', { name: '一覧を再読込', exact: true }).click();
      await page.getByRole('button', { name: '聴く', exact: true }).click();
      await expect(documentChoice(page, document)).toHaveCount(1);
      await page.getByRole('button', { name: /声のメモ/ }).click();
      await expect(page.getByTestId('memo-card')).toHaveCount(1);
    } finally {
      await page.unroute(`**${path}`);
    }
  });
}
