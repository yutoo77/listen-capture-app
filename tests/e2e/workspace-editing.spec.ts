import { expect, test, type Page } from './fixtures/accounts';

async function login(page: Page, name: 'ALICE' | 'BOB' = 'ALICE') {
  await page.goto('/');
  // Explicitly log out in this tab when a different account owns the cookie.
  const current = await (await page.request.get('/api/session/')).json();
  if (current.user) {
    expect((await page.request.post('/api/logout/', {headers: {'X-CSRFToken': current.csrfToken}})).status()).toBe(204);
    await page.reload();
  }
  await page.getByLabel('ユーザー名', {exact:true}).fill(process.env[`LC_E2E_${name}`]!);
  await page.getByLabel('パスワード', {exact:true}).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button', {name:'ログイン',exact:true}).click();
  await expect(page.getByRole('button', {name:'ログアウト',exact:true})).toBeVisible();
}
async function csrf(page: Page) { return (await (await page.request.get('/api/session/')).json()).csrfToken; }
const created = new WeakMap<Page,string[]>();
test.beforeEach(async ({page}) => { created.set(page,[]); await login(page); });
test.afterEach(async ({page}) => {
  page.once('dialog', dialog => dialog.accept());
  await page.goto('about:blank');
  const token = await csrf(page);
  for (const id of created.get(page) ?? [])
    expect((await page.request.delete(`/api/documents/${id}/`, {headers:{'X-CSRFToken':token}})).status()).toBe(204);
});
async function create(page: Page) {
  const response = await page.request.post('/api/documents/', {headers:{'X-CSRFToken':await csrf(page)},data:{title:'修正検証',text:'元の本文です。'}});
  expect(response.status()).toBe(201);
  const doc = await response.json(); created.get(page)!.push(doc.id);
  await page.reload();
  await page.getByRole('button', {name:/修正検証 テキストのみ/}).click();
  await page.getByRole('button', {name:'修正',exact:true}).click();
  return doc;
}
test('old workspace cannot create under a different account and can recover without losing input', async ({page,context}) => {
  await page.getByRole('button',{name:'＋ 資料を追加'}).click();
  await page.getByLabel('タイトル',{exact:true}).fill('元アカウントの入力');
  await page.getByLabel('資料のテキスト',{exact:true}).fill('送信前の本文です。');
  const other = await context.newPage();
  await login(other,'BOB');
  let creations = 0;
  page.on('request',request => {if(request.method()==='POST' && request.url().endsWith('/api/documents/')) creations++;});
  await page.getByRole('button',{name:'資料を保存',exact:true}).click();
  await expect(page.getByRole('heading',{name:'元のアカウントでログインし直してください'})).toBeVisible();
  await expect(page.getByLabel('資料のテキスト',{exact:true})).toHaveValue('送信前の本文です。');
  await expect(page.getByRole('button',{name:'資料を保存',exact:true})).toBeDisabled();
  expect(creations).toBe(0);
  expect(await (await other.request.get('/api/documents/')).json()).toEqual([]);
  await login(other,'ALICE');
  await page.getByRole('button',{name:'ログイン状態を再確認'}).click();
  await expect(page.getByRole('button',{name:'資料を保存',exact:true})).toBeEnabled();
  const accepted = page.waitForResponse(response => response.request().method()==='POST' && response.url().endsWith('/api/documents/'));
  await page.getByRole('button',{name:'資料を保存',exact:true}).click();
  const response = await accepted; expect(response.status()).toBe(201);
  const doc = await response.json(); created.get(page)!.push(doc.id);
  expect(response.request().headers()['x-workspace-user']).toBe((await (await page.request.get('/api/session/')).json()).user.id);
  await other.close();
});
test('stale editor keeps its text and refuses to overwrite a newer immutable version', async ({page}) => {
  const doc = await create(page);
  await page.getByLabel('本文',{exact:true}).fill('この画面での修正。');
  const updated = await page.request.patch(`/api/documents/${doc.id}/`,{headers:{'X-CSRFToken':await csrf(page)},data:{text:'別の画面で更新した本文。',expected_version:doc.current_version.id}});
  expect(updated.status()).toBe(200);
  await page.getByRole('button',{name:'修正を保存'}).click();
  await expect(page.getByRole('alert')).toContainText('別の画面で資料が更新');
  await expect(page.getByLabel('本文',{exact:true})).toHaveValue('この画面での修正。');
  const current = await (await page.request.get(`/api/documents/${doc.id}/`)).json();
  expect(current.current_version.number).toBe(2);
  expect(current.current_version.text).toBe('別の画面で更新した本文。');
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'最新本文を読み込む'}).click();
  await expect(page.getByLabel('本文',{exact:true})).toHaveValue('別の画面で更新した本文。');
  await page.getByRole('button',{name:'キャンセル',exact:true}).click();
  await expect(page.getByRole('button',{name:'修正',exact:true})).toBeFocused();
});
test('lost edit acknowledgment is reconciled without creating a duplicate version', async ({page}) => {
  const doc = await create(page);
  await page.getByLabel('本文',{exact:true}).fill('応答だけ失われた修正。\n');
  await page.route(`**/api/documents/${doc.id}/`,async route=>{
    if(route.request().method()!=='PATCH') return route.fallback();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  await page.getByRole('button',{name:'修正を保存'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const current = await (await page.request.get(`/api/documents/${doc.id}/`)).json();
  expect(current.current_version.number).toBe(2);
  expect(current.current_version.text).toBe('応答だけ失われた修正。\n');
});
test('body editing cannot silently undo a rename made in another tab', async ({page}) => {
  const doc = await create(page);
  await page.getByLabel('本文',{exact:true}).fill('別の画面を開いた後の修正。');
  const renamed = await page.request.patch(`/api/documents/${doc.id}/`, {headers:{'X-CSRFToken':await csrf(page)},data:{title:'他の画面で付けた題名',expected_version:doc.current_version.id,expected_updated_at:doc.updated_at}});
  expect(renamed.status()).toBe(200);
  expect((await renamed.json()).current_version.number).toBe(1);
  await page.getByRole('button',{name:'修正を保存'}).click();
  await expect(page.getByRole('alert')).toContainText('別の画面で資料が更新');
  const current = await (await page.request.get(`/api/documents/${doc.id}/`)).json();
  expect(current.title).toBe('他の画面で付けた題名');
  expect(current.current_version.text).toBe(doc.current_version.text);
  await expect(page.getByLabel('本文',{exact:true})).toHaveValue('別の画面を開いた後の修正。');
});
