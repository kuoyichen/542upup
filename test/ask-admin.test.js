// 鎮妹！給問嗎？後台 API：/api/admin/ask。全程接本機假 Upstash。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, adminCookie } = require('./helpers/server-env.js');
// _redis.js 在 require 時讀環境變數，所以 _ask.js 要等 start() 之後才載入
let A, env, cookie, n = 0, vil;
const ADMIN = '/api/admin/ask';
const ask = (text, extra = {}) => env.call('POST', '/api/ask', { body: { vid: 'vid' + (++n) + 'abcdef', text, name: 'T', vil, ...extra } });
const adm = (body, headers = {}) => env.call('POST', ADMIN, { headers: { cookie, ...headers }, body });
const pub = async () => (await env.call('GET', '/api/ask')).body;
const adminList = async () => (await env.call('GET', ADMIN, { headers: { cookie } })).body;
const inPub = async (id) => (await pub()).questions.some((q) => q.id === id);
const inAdmin = async (id) => (await adminList()).questions.find((q) => q.id === id);
const bottleRaws = () => env.store('LRANGE', A.K.BOTTLES, 0, -1);
const excluded = () => env.store('SMEMBERS', A.K.EXCLUDED);

before(async () => {
  env = await start();
  A = require('../api/_ask.js');
  vil = A.VILLAGES[0];
  cookie = await adminCookie(env, 'smalt');
});
after(async () => { await env.stop(); });

describe('/api/admin/ask', () => {
  describe('守門', () => {
    it('無 cookie GET／POST 都 401', async () => {
      assert.equal((await env.call('GET', ADMIN)).status, 401);
      assert.equal((await env.call('POST', ADMIN, { body: { op: 'hide', id: 'x' } })).status, 401);
    });
    it('跨站 Origin 403、非 JSON 415', async () => {
      assert.equal((await adm({ op: 'hide', id: 'x' }, { origin: 'http://evil.example' })).status, 403);
      assert.equal((await adm('op=hide', { 'content-type': 'text/plain' })).status, 415);
    });
    it('未知 op 400、id 不存在 404、GET 不含 raw', async () => {
      assert.equal((await adm({ op: 'nope' })).status, 400);
      assert.equal((await adm({ op: 'hide', id: 'nonexistent' })).status, 404);
      const q = (await ask('GET 不含 raw 的測試題')).body.question;
      const l = (await env.call('GET', ADMIN, { headers: { cookie } })).body;
      assert.equal(l.user.name, 'smalt');
      assert.ok(l.open && typeof l.open.online === 'boolean');
      const got = l.questions.find((x) => x.id === q.id);
      assert.ok(got && !('raw' in got));
    });
  });

  describe('hide / unhide', () => {
    it('活動頁提問 hide：公開列表立即不含、瓶子清單不含、excluded 含、admin hidden', async () => {
      const q = (await ask('要被隱藏的活動頁問題')).body.question;
      assert.ok(await inPub(q.id));
      assert.equal((await adm({ op: 'hide', id: q.id })).status, 200);
      assert.ok(!(await inPub(q.id)));
      assert.ok(!(await bottleRaws()).some((r) => r.includes(q.id)));
      assert.ok((await excluded()).includes(q.id));
      assert.equal((await inAdmin(q.id)).hidden, true);
    });
    it('島上瓶子 hide：LRANGE 不含原字串，且不因同步回來', async () => {
      const raw = JSON.stringify({ id: 'isl1', t: Date.now(), name: '島民', text: '島上來的留言一則' });
      env.store('LPUSH', A.K.BOTTLES, raw);
      assert.ok(await inAdmin('isl1')); // 後台 GET 不走快取，觸發島上瓶子同步
      assert.equal((await adm({ op: 'hide', id: 'isl1' })).status, 200);
      assert.ok(!(await bottleRaws()).includes(raw));
      assert.ok(!(await inPub('isl1')));
      assert.ok(!(await bottleRaws()).includes(raw));
    });
    it('unhide：公開又看得到、bottles 恰好一則、excluded 仍含', async () => {
      const q = (await ask('隱藏再取消隱藏的問題')).body.question;
      await adm({ op: 'hide', id: q.id });
      assert.equal((await adm({ op: 'unhide', id: q.id })).status, 200);
      assert.ok(await inPub(q.id));
      assert.equal((await bottleRaws()).filter((r) => r.includes(q.id)).length, 1);
      assert.ok((await excluded()).includes(q.id));
      // 沒隱藏過直接 unhide 也不會重複
      await adm({ op: 'unhide', id: q.id });
      assert.equal((await bottleRaws()).filter((r) => r.includes(q.id)).length, 1);
    });
  });

  describe('exclude / include / src', () => {
    it('include 後 excluded 不含；exclude 後含', async () => {
      const q = (await ask('排除與納入的問題')).body.question;
      assert.equal((await adm({ op: 'exclude', id: q.id })).status, 200);
      assert.ok((await excluded()).includes(q.id));
      assert.equal((await adm({ op: 'include', id: q.id })).status, 200);
      assert.ok(!(await excluded()).includes(q.id));
    });
    it('src live：admin 與公開都是 live；src x 400', async () => {
      const q = (await ask('改來源的問題')).body.question;
      assert.equal((await adm({ op: 'src', id: q.id, src: 'live' })).status, 200);
      assert.equal((await inAdmin(q.id)).src, 'live');
      assert.equal((await pub()).questions.find((x) => x.id === q.id).src, 'live');
      assert.equal((await adm({ op: 'src', id: q.id, src: 'x' })).status, 400);
    });
  });

  describe('open', () => {
    it('online 關閉寫 closedAt，線上提問 403；重開後 201', async () => {
      assert.equal((await adm({ op: 'open', which: 'online', open: false })).status, 200);
      assert.ok(Number.isFinite(Number(env.store('HGET', A.K.OPEN, 'closedAt'))) && Number(env.store('HGET', A.K.OPEN, 'closedAt')) > 0);
      assert.equal((await ask('關閉後線上提問')).status, 403);
      assert.equal((await adm({ op: 'open', which: 'online', open: true })).status, 200);
      assert.equal((await ask('重開後線上提問')).status, 201);
    });
    it('which 不合法 400', async () => {
      assert.equal((await adm({ op: 'open', which: 'x', open: true })).status, 400);
      assert.equal((await adm({ op: 'open', which: 'live', open: 'yes' })).status, 400);
    });
  });
});
