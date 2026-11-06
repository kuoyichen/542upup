// 依網域分流：ask.* 網域 / 回鎮民頁，/admin 回後台；其他網域維持政策島。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server-env.js');

let env;
before(async () => { env = await start(); });
after(async () => { await env.stop(); });

const ASK = '鎮妹！給問嗎？';
const get = (p, headers) => env.call('GET', p, { headers });

describe('依網域分流', () => {
  it('ask 網域 GET / 是鎮民頁', async () => {
    const r = await get('/', { host: 'ask.542upup.tw' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.ok(r.text.includes(ASK));
  });
  it('島上網域 GET / 仍是政策島', async () => {
    const r = await get('/', { host: 'island.542upup.tw' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('草屯政策島'));
    assert.ok(!r.text.includes(ASK));
  });
  it('x-forwarded-host 優先於 host，並取第一段、去 port、不分大小寫', async () => {
    const r = await get('/', { host: 'x', 'x-forwarded-host': 'ASK.542upup.tw:443, other.example' });
    assert.ok(r.text.includes(ASK));
    const r2 = await get('/', { host: 'ask.542upup.tw', 'x-forwarded-host': 'island.542upup.tw' });
    assert.ok(!r2.text.includes(ASK));
  });
  it('ask 網域 GET /admin 是後台頁', async () => {
    const r = await get('/admin', { host: 'ask.542upup.tw' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('鎮妹給問後台'));
  });
  it('後台「隱藏」要在頁面內再按一次確認，不用 window.confirm', async () => {
    const r = await get('/admin', { host: 'ask.542upup.tw' });
    assert.ok(r.text.includes('再按一次確認隱藏'));
    assert.ok(!/\bconfirm\s*\(/.test(r.text));
  });
  it('後台頁對在別處被刪掉的瓶子顯示標記', async () => {
    const r = await get('/admin', { host: 'ask.542upup.tw' });
    assert.ok(r.text.includes('瓶子已在別處被刪除'));
  });
  it('/ask 任何 Host 都是鎮民頁（含 ?live=1）', async () => {
    for (const h of ['island.542upup.tw', 'ask.542upup.tw', 'localhost:8091']) {
      const r = await get('/ask', { host: h });
      assert.equal(r.status, 200);
      assert.ok(r.text.includes(ASK));
    }
    assert.ok((await get('/ask?live=1', { host: 'island.542upup.tw' })).text.includes(ASK));
  });
  it('/admin 在島上網域是 404', async () => {
    assert.equal((await get('/admin', { host: 'island.542upup.tw' })).status, 404);
  });
});

describe('島上活動瓶子標籤', () => {
  it('島上 HTML 含鎮妹給問標籤、樣式與活動頁連結', async () => {
    const r = await get('/', { host: 'island.542upup.tw' });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('bottle-ask'));
    assert.ok(r.text.includes('鎮妹給問'));
    assert.ok(r.text.includes('Ask Yuan-ting'));
    assert.ok(r.text.includes('https://ask.542upup.tw/'));
    assert.ok(r.text.includes('#fcea8b'));
    assert.ok(!/\.bottle-ask\{[^}]*inline-block/.test(r.text), '標籤要自成一行');
    assert.ok(r.text.includes('到活動頁看大家的問題'));
  });
});
