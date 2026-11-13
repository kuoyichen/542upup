const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server-env');

// Cloudflare 來源鎖：設了 ORIGIN_SECRET 後，沒帶正確 x-origin-key 的請求一律 403
describe('來源鎖 ORIGIN_SECRET', () => {
  const SECRET = 'test-origin-secret-0123456789';
  const HOST = 'ask.542upup.tw';
  const saved = process.env.ORIGIN_SECRET;
  let env;
  before(async () => { env = await start(); });
  after(async () => {
    if (saved === undefined) delete process.env.ORIGIN_SECRET; else process.env.ORIGIN_SECRET = saved;
    await env.stop();
  });
  afterEach(() => { delete process.env.ORIGIN_SECRET; });
  const h = (extra) => ({ host: HOST, ...extra });
  const Q = { vid: 'abcdef1', text: '市場附近什麼時候有停車場？', name: '阿明', vil: require('../api/_villages')[0] };

  it('未設定：不檢查，首頁與 API 照常 200', async () => {
    delete process.env.ORIGIN_SECRET;
    assert.equal((await env.call('GET', '/', { headers: h() })).status, 200);
    assert.equal((await env.call('GET', '/api/ask', { headers: h() })).status, 200);
  });

  it('設定後沒帶標頭：頁面、API、POST 都 403 forbidden', async () => {
    process.env.ORIGIN_SECRET = SECRET;
    for (const [m, p, body] of [['GET', '/'], ['GET', '/api/ask'], ['POST', '/api/ask-vote', { vid: 'abcdef1', id: 'x', on: true }]]) {
      const r = await env.call(m, p, { headers: h(), body });
      assert.equal(r.status, 403, m + ' ' + p);
      assert.equal(r.text, 'forbidden');
      assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  it('標頭錯誤（同長度、不同長度、空字串）：403 且 server 仍可回應', async () => {
    process.env.ORIGIN_SECRET = SECRET;
    const same = 'x'.repeat(SECRET.length);
    for (const v of [same, 'short', SECRET + 'extra', '']) {
      const r = await env.call('GET', '/', { headers: h({ 'x-origin-key': v }) });
      assert.equal(r.status, 403, JSON.stringify(v));
    }
    const ok = await env.call('GET', '/', { headers: h({ 'x-origin-key': SECRET }) });
    assert.equal(ok.status, 200);
  });

  it('標頭正確：首頁與 API 200', async () => {
    process.env.ORIGIN_SECRET = SECRET;
    const hh = h({ 'x-origin-key': SECRET });
    assert.equal((await env.call('GET', '/', { headers: hh })).status, 200);
    assert.equal((await env.call('GET', '/api/ask', { headers: hh })).status, 200);
  });

  it('被擋的 POST 不會執行 handler，也不寫入資料庫', async () => {
    process.env.ORIGIN_SECRET = SECRET;
    const orig = env.fake.store.exec;
    const cmds = [];
    env.fake.store.exec = (cmd) => { cmds.push(cmd); return orig(cmd); };
    try {
      const r = await env.call('POST', '/api/ask', { headers: h(), body: Q });
      assert.equal(r.status, 403);
    } finally {
      env.fake.store.exec = orig;
    }
    assert.deepEqual(cmds, []);
  });
});
