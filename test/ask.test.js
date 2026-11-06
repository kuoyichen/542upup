const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('里名清單', () => {
  const VILLAGES = require('../api/_villages');

  // 草屯鎮正式里數 27（中選會 111 年草屯鎮里長選舉公報，第 1~4 選區合計 7+6+6+8）
  // 來源：https://eebulletin.cec.gov.tw/?dir=111/11南投縣/05村里長
  it('筆數 = 官方 27 里', () => {
    assert.equal(VILLAGES.length, 27);
  });
  it('無重複', () => {
    assert.equal(new Set(VILLAGES).size, VILLAGES.length);
  });
  it('每一項都以「里」結尾', () => {
    for (const v of VILLAGES) assert.match(v, /里$/);
  });
  it('不含外地鄉親', () => {
    assert.ok(!VILLAGES.includes('外地鄉親'));
  });
});

describe('提問 API', () => {
  const { before, after, beforeEach } = require('node:test');
  const { start } = require('./helpers/server-env');
  const VILLAGES = require('../api/_villages');
  const P = '542upup:';
  let env, invalidate;
  const Q = { vid: 'abcdef1', text: '市場附近什麼時候有停車場？', name: '阿明', vil: VILLAGES[0] };
  const post = (b) => env.call('POST', '/api/ask', { body: b });

  before(async () => { env = await start(); ({ invalidate } = require('../api/_ask.js')); });
  after(async () => { await env.stop(); });
  beforeEach(() => { env.store('FLUSHALL'); invalidate(); });

  it('POST 成功：201、公開欄位、瓶子帶 ask:1', async () => {
    const r = await post(Q);
    assert.equal(r.status, 201);
    const q = r.body.question;
    assert.ok(q.id && q.t && q.text && q.name && q.vil);
    assert.equal(q.origin, 'ask');
    assert.equal(q.src, 'online');
    assert.equal(q.votes, 0);
    assert.ok(!('raw' in q));
    const b = env.store('LRANGE', P + 'bottles', 0, -1).map(JSON.parse)[0];
    assert.equal(b.ask, 1);
    assert.equal(b.vil, VILLAGES[0]);
    assert.equal(b.id, q.id);
  });
  it('GET 列出問題、里名、開關，no-store', async () => {
    const id = (await post(Q)).body.question.id;
    const g = await env.call('GET', '/api/ask');
    assert.equal(g.status, 200);
    assert.equal(g.body.questions[0].id, id);
    assert.deepEqual(g.body.villages, VILLAGES);
    assert.deepEqual(g.body.open, { online: true, live: true });
    assert.equal(g.headers['cache-control'], 'no-store');
  });
  it('暱稱：空→匿名鎮民、20 字→截 16', async () => {
    assert.equal((await post({ ...Q, name: '' })).body.question.name, '匿名鎮民');
    env.store('FLUSHALL');
    const r = await post({ ...Q, name: '一二三四五六七八九十一二三四五六七八九十' });
    assert.equal(r.body.question.name.length, 16);
  });
  it('驗證錯誤', async () => {
    let r = await post({ ...Q, vil: '不存在里' });
    assert.deepEqual([r.status, r.body], [400, { error: 'bad village' }]);
    r = await post({ ...Q, text: '停' });
    assert.deepEqual([r.status, r.body], [400, { error: 'too short' }]);
    r = await post({ ...Q, text: '看 https://x.y 這個' });
    assert.deepEqual([r.status, r.body], [400, { error: 'blocked' }]);
    r = await post({ ...Q, vid: '!!' });
    assert.deepEqual([r.status, r.body], [400, { error: 'bad request' }]);
  });
  it('同 vid 連送 → 429 slow down', async () => {
    assert.equal((await post(Q)).status, 201);
    const r = await post(Q);
    assert.deepEqual([r.status, r.body], [429, { error: 'slow down' }]);
  });
  it('全站每小時上限 → 429 busy', async () => {
    env.store('SET', P + 'ask:hour:' + Math.floor(Date.now() / 3600e3), '600');
    const r = await post(Q);
    assert.deepEqual([r.status, r.body], [429, { error: 'busy' }]);
  });
  it('收題開關：online 關 403、live 可送、live 也關 403', async () => {
    env.store('HSET', P + 'ask:open', 'online', '0');
    let r = await post(Q);
    assert.deepEqual([r.status, r.body], [403, { error: 'closed' }]);
    r = await post({ ...Q, live: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.question.src, 'live');
    env.store('HSET', P + 'ask:open', 'live', '0');
    r = await post({ ...Q, vid: 'abcdef2', live: true });
    assert.deepEqual([r.status, r.body], [403, { error: 'closed' }]);
  });
  it('GET 不回 hidden', async () => {
    const id = (await post(Q)).body.question.id;
    env.store('SADD', P + 'ask:hidden', id);
    invalidate();
    const g = await env.call('GET', '/api/ask');
    assert.ok(!g.body.questions.some((q) => q.id === id));
  });
});
