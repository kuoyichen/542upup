// 媛婷手機提詞頁：GET /api/ask-now 與 /now。全程接本機假 Upstash。
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, adminCookie } = require('./helpers/server-env.js');
let A, N, env, cookie, n = 0, vil;
const NOW = '/api/ask-now';
const ask = (text, extra = {}) => env.call('POST', '/api/ask', { body: { vid: 'nowv' + (++n) + 'abcdef', text, name: 'T', vil, ...extra } });
const adm = (body) => env.call('POST', '/api/admin/ask', { headers: { cookie }, body });
const now = async () => (await env.call('GET', NOW)).body.now;
const drawQ = async (text) => {
  const q = (await ask(text)).body.question;
  assert.equal((await adm({ op: 'draw', id: q.id })).status, 200);
  return q;
};

before(async () => {
  env = await start();
  A = require('../api/_ask.js');
  N = require('../api/ask-now.js');
  vil = A.VILLAGES[0];
  cookie = await adminCookie(env, 'smalt');
});
after(async () => { await env.stop(); });
beforeEach(async () => {
  for (const id of await env.store('SMEMBERS', A.K.DRAWN)) await env.store('SREM', A.K.DRAWN, id);
  N._resetNowCache();
});

describe('/api/ask-now', () => {
  it('沒抽題 → 200 { now: [] }、no-store', async () => {
    const r = await env.call('GET', NOW);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { now: [] });
    assert.match(r.headers['cache-control'], /no-store/);
  });

  it('draw 一題後只有那一題，欄位固定、無 raw', async () => {
    await ask('沒被抽到的另一題');
    const q = await drawQ('被抽到的題目文字');
    const list = await now();
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'name', 'origin', 'text', 'vil', 'votes']);
    assert.equal(list[0].id, q.id);
    assert.equal(list[0].text, '被抽到的題目文字');
    assert.equal(list[0].origin, 'ask');
    assert.equal(list[0].votes, 0);
  });

  it('name 空用匿名鎮民、votes 取自 VC、島上題 origin 為 island', async () => {
    const q = (await ask('島上來的題目文字')).body.question;
    await env.store('HSET', A.K.VC, q.id, '7');
    const stored = JSON.parse(await env.store('HGET', A.K.Q, q.id));
    stored.name = ''; stored.origin = 'island';
    await env.store('HSET', A.K.Q, q.id, JSON.stringify(stored));
    await adm({ op: 'draw', id: q.id });
    const [x] = await now();
    assert.equal(x.name, '匿名鎮民');
    assert.equal(x.origin, 'island');
    assert.equal(x.votes, 7);
  });

  it('壞 JSON、查無題目、在 HIDDEN 的都跳過', async () => {
    const q = (await ask('壞掉的題目文字')).body.question;
    await env.store('HSET', A.K.Q, q.id, '{壞');
    await env.store('SADD', A.K.DRAWN, q.id, 'ghost');
    assert.deepEqual(await now(), []);
    const q2 = await drawQ('防禦隱藏的題目');
    N._resetNowCache();
    await env.store('SADD', A.K.HIDDEN, q2.id);
    assert.deepEqual(await now(), []);
  });

  it('依 t 由新到舊', async () => {
    const a = (await ask('比較舊的題目文字')).body.question;
    const b = (await ask('比較新的題目文字')).body.question;
    for (const [q, t] of [[a, 1000], [b, 2000]]) {
      const s = JSON.parse(await env.store('HGET', A.K.Q, q.id)); s.t = t;
      await env.store('HSET', A.K.Q, q.id, JSON.stringify(s));
      await env.store('SADD', A.K.DRAWN, q.id);
    }
    assert.deepEqual((await now()).map((x) => x.id), [b.id, a.id]);
  });

  for (const [label, op] of [['answer(on)', (id) => ({ op: 'answer', id, on: true })], ['putback', (id) => ({ op: 'putback', id })], ['exclude', (id) => ({ op: 'exclude', id })], ['hide', (id) => ({ op: 'hide', id })]]) {
    it(label + ' 後 now 變空，且不必等 2 秒快取（靠 invalidate）', async () => {
      const q = await drawQ('要處理掉的題目 ' + label);
      assert.equal((await now()).length, 1); // 快取已暖
      assert.equal((await adm(op(q.id))).status, 200);
      assert.deepEqual(await now(), []);
    });
  }

  it('2 秒快取：連續兩次 GET 只打一次 Upstash；_resetNowCache 後再打', async () => {
    await drawQ('快取測試題目文字');
    N._resetNowCache();
    const base = env.fake.state.requests;
    await now(); const afterFirst = env.fake.state.requests;
    await now();
    assert.ok(afterFirst > base);
    assert.equal(env.fake.state.requests, afterFirst);
    N._resetNowCache();
    await now();
    assert.ok(env.fake.state.requests > afterFirst);
  });

  it('同時進來的請求共用同一次讀取', async () => {
    await drawQ('同時請求測試題目');
    N._resetNowCache();
    const base = env.fake.state.requests;
    const rs = await Promise.all([1, 2, 3, 4].map(() => env.call('GET', NOW)));
    rs.forEach((r) => assert.equal(r.body.now.length, 1));
    assert.ok(env.fake.state.requests - base <= 2, '請求數 ' + (env.fake.state.requests - base));
  });

  it('POST → 405 Allow: GET', async () => {
    const r = await env.call('POST', NOW, { body: {} });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'GET');
  });

  it('Upstash 出錯 → 502 storage error', async () => {
    env.fake.state.broken = true;
    try {
      const r = await env.call('GET', NOW);
      assert.equal(r.status, 502);
      assert.deepEqual(r.body, { error: 'storage error' });
    } finally { env.fake.state.broken = false; }
  });
});

describe('/now 頁面', () => {
  it('ask 網域 200 html 含「等待抽題」', async () => {
    const r = await env.call('GET', '/now', { headers: { host: 'ask.542upup.tw' } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.ok(r.text.includes('等待抽題'));
  });
  it('island 網域 404', async () => {
    const r = await env.call('GET', '/now', { headers: { host: 'island.542upup.tw' } });
    assert.equal(r.status, 404);
  });
  it('原始碼含 wakeLock、/api/ask-now、noindex，不含 innerHTML', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ask-now.html'), 'utf8');
    for (const s of ['wakeLock', '/api/ask-now', 'noindex']) assert.ok(src.includes(s), s);
    assert.ok(!src.includes('innerHTML'));
  });
});
