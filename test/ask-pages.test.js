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
  it('鎮民頁 og:image 是絕對網址、有 og:url', async () => {
    const r = await get('/', { host: 'ask.542upup.tw' });
    assert.ok(r.text.includes('<meta property="og:image" content="https://ask.542upup.tw/og-cover.png">'));
    assert.ok(r.text.includes('<meta property="og:url" content="https://ask.542upup.tw/">'));
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

  describe('投影抽題頁', () => {
    const isDraw = (r) => {
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.ok(r.text.includes(ASK));
      assert.ok(r.text.includes('投影抽題'));
      assert.ok(r.text.includes('ask-qr.svg'));
    };
    it('ask 網域 GET /draw 是投影抽題頁', async () => {
      isDraw(await get('/draw', { host: 'ask.542upup.tw' }));
    });
    it('/ask-draw 任何 Host 都是投影抽題頁', async () => {
      for (const h of ['island.542upup.tw', 'ask.542upup.tw', 'localhost:8091']) isDraw(await get('/ask-draw', { host: h }));
    });
    it('/draw 在島上網域是 404', async () => {
      assert.equal((await get('/draw', { host: 'island.542upup.tw' })).status, 404);
    });
    it('GET /ask-qr.svg 是 SVG', async () => {
      const r = await get('/ask-qr.svg', { host: 'ask.542upup.tw' });
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /^image\/svg\+xml/);
      assert.ok(r.text.includes('<svg'));
    });
    it('沒登入可用示範資料預演；離線佇列存 localStorage；不用 innerHTML', async () => {
      const r = await get('/draw', { host: 'ask.542upup.tw' });
      for (const s of ['請先到後台登入', '用示範資料預演', '示範模式，不會寫入資料', '離線抽題，未確認', '還沒送出', 'ask:draw:queue', '登入過期，請到後台重新登入', '這個池子沒有題目了', 'prefers-reduced-motion']) {
        assert.ok(r.text.includes(s), '缺少：' + s);
      }
      assert.ok(!/innerHTML/.test(r.text));
    });
    it('過期快照不抽題、台上題目被隱藏會撤下、拒絕的寫入有提示', async () => {
      const r = await get('/draw', { host: 'ask.542upup.tw' });
      for (const s of ['請稍候，正在連線', '這題先跳過', '被伺服器拒絕，已略過']) assert.ok(r.text.includes(s), '缺少：' + s);
    });
    it('原始碼不露出本機路徑；字型不擋畫面', async () => {
      const r = await get('/draw', { host: 'ask.542upup.tw' });
      assert.ok(!r.text.includes('/Users/'));
      assert.ok(r.text.includes('python3 -m pip install segno'));
      assert.ok(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*media="print"/.test(r.text));
      assert.ok(r.text.includes('<noscript><link rel="stylesheet" href="https://fonts.googleapis.com'));
    });
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
  it('島上 HTML 含回答影片連結（rv）與英文字樣', async () => {
    const r = await get('/', { host: 'island.542upup.tw' });
    assert.ok(r.text.includes('看回答影片'));
    assert.ok(r.text.includes('Watch the answer'));
    assert.ok(r.text.includes('class="rv"'));
  });
});
