import {expect, test, type Page} from './fixtures/accounts';
import {randomUUID} from 'node:crypto';

async function token(page: Page) {return (await (await page.request.get('/api/session/')).json()).csrfToken;}
function wav() {
  const bytes=Buffer.alloc(32044);
  bytes.write('RIFF'); bytes.writeUInt32LE(32036,4); bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16); bytes.writeUInt16LE(1,20); bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(16000,24); bytes.writeUInt32LE(32000,28);
  bytes.writeUInt16LE(2,32); bytes.writeUInt16LE(16,34);
  bytes.write('data',36); bytes.writeUInt32LE(32000,40); return bytes;
}
test('reviewing an old memo does not switch to an already generated revision until explicitly requested', async ({page})=>{
  test.skip(process.env.LC_E2E_EXPECT_FIXTURE !== '1','Uses a deterministic synthetic narration with no external provider.');
  await page.goto('/');
  await page.getByLabel('ユーザー名',{exact:true}).fill(process.env.LC_E2E_ALICE!);
  await page.getByLabel('パスワード',{exact:true}).fill(process.env.LC_E2E_PASSWORD!);
  await page.getByRole('button',{name:'ログイン',exact:true}).click();
  await expect(page.getByRole('button',{name:'ログアウト',exact:true})).toBeVisible();
  const headers={'X-CSRFToken':await token(page)};
  const demo=await page.request.post('/api/documents/demo/',{headers});
  expect(demo.status()).toBe(201);
  const doc=await demo.json();
  try {
    const original=doc.audio_versions[0];
    const saved=await page.request.post('/api/memos/',{headers,multipart:{
      client_id:randomUUID(),audio_version:original.id,position_ms:'12000',duration_ms:'1000',text:'',
      audio:{name:'synthetic.wav',mimeType:'audio/wav',buffer:wav()},
    }});
    expect(saved.status()).toBe(201); const memo=await saved.json();
    const edited=await page.request.patch(`/api/documents/${doc.id}/`,{headers,data:{text:'修正後の日本語の本文です。'}});
    expect(edited.status()).toBe(200); const revised=await edited.json();
    const generation=await page.request.post(`/api/documents/${doc.id}/narration/`,{headers,data:{client_id:randomUUID(),document_version:revised.current_version.id,provider:'fixture'}});
    expect(generation.status()).toBe(202); const job=await generation.json();
    await expect.poll(async()=>(await (await page.request.get(`/api/narrations/${job.id}/`)).json()).state).toBe('succeeded');
    const fresh=await (await page.request.get(`/api/documents/${doc.id}/`)).json();
    const latest=fresh.audio_versions.find((audio:{document_version:string})=>audio.document_version===revised.current_version.id);
    expect(latest).toBeTruthy();
    const latestUrl=latest.delivery==='playlist'
      ? (await (await page.request.get(latest.playlist_url)).json()).segments[0].media_url
      : latest.media_url;
    let generationReads=0;
    page.on('request',request=>{if(request.method()==='GET' && request.url().endsWith(`/api/documents/${doc.id}/narration/`)) generationReads++;});
    await page.reload();
    await page.getByRole('button',{name:/声のメモ/}).click();
    await page.getByRole('button',{name:'元の位置へ戻る',exact:true}).click();
    await expect(page.getByTestId('play-toggle')).toBeEnabled();
    // A collapsed option must not mount a controller that applies a completed
    // new-version job behind the user's old memo context.
    expect(generationReads).toBe(0);
    await expect(page.getByTestId('source-audio')).toHaveAttribute('src',original.media_url);
    await expect(page.getByTestId('source-context')).toHaveText(doc.current_version.text);
    await page.getByText('修正後の本文の音声を用意する',{exact:true}).click();
    await expect(page.getByTestId('source-audio')).toHaveAttribute('src',latestUrl);
    expect(generationReads).toBeGreaterThan(0);
    expect((await (await page.request.get(`/api/memos/${memo.id}/`)).json()).audio_version).toBe(original.id);
  } finally {
    page.once('dialog',dialog=>dialog.accept());
    await page.goto('about:blank');
    expect((await page.request.delete(`/api/documents/${doc.id}/`,{headers:{'X-CSRFToken':await token(page)}})).status()).toBe(204);
  }
});
