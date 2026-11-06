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
  // 監看假 Upstash 執行的每一條指令（指令跑完才呼叫 fn）；回傳還原函式
  const tap = (fn) => {
    const orig = env.fake.store.exec;
    env.fake.store.exec = (cmd) => { const r = orig(cmd); fn(cmd); return r; };
    return () => { env.fake.store.exec = orig; };
  };
  const isReadAll = (c) => c[0] === 'HGETALL' && c[1] === P + 'ask:q';
  const hourNow = () => Math.floor(Date.now() / 3600e3);

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

describe('提問頻率限制', () => {
  const hourKey = () => P + 'ask:hour:' + hourNow();
  const postFrom = (b, ip, extra = {}) => env.call('POST', '/api/ask', { headers: { 'cf-connecting-ip': ip, ...extra }, body: b });
  // 分批同時送出（每批 size 個），回傳每個請求的狀態碼
  async function burst(n, size, make) {
    const codes = [];
    for (let i = 0; i < n; i += size) {
      const rs = await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, j) => make(i + j)));
      codes.push(...rs.map((r) => r.status));
    }
    return codes;
  }

  it('同 vid 被擋下（slow down）的請求不碰全站與 IP 計數', async () => {
    assert.equal((await postFrom(Q, '203.0.113.5')).status, 201);
    assert.equal(env.store('GET', hourKey()), '1');
    const r = await postFrom(Q, '203.0.113.5');
    assert.deepEqual([r.status, r.body], [429, { error: 'slow down' }]);
    assert.equal(env.store('GET', hourKey()), '1');
    assert.equal(env.store('GET', P + 'ask:qip:203.0.113.5:' + hourNow()), '1');
  });
  it('同一個 vid 連送 601 次，另一個 vid 照樣能送', async () => {
    const codes = await burst(601, 50, () => post({ ...Q, vid: 'flood01' }));
    assert.equal(codes.filter((c) => c === 201).length, 1);
    assert.equal(codes.filter((c) => c === 429).length, 600);
    const r = await post({ ...Q, vid: 'other01' });
    assert.equal(r.status, 201);
  });
  it('同 IP 每小時第 101 題 → 429 busy；偽造 X-Forwarded-For 也一樣；其他 IP 照常', async () => {
    const ip = '198.51.100.7';
    const codes = await burst(100, 20, (i) => postFrom({ ...Q, vid: 'ipcap' + String(i).padStart(3, '0') }, ip));
    assert.ok(codes.every((c) => c === 201), String(codes.filter((c) => c !== 201)));
    const r = await postFrom({ ...Q, vid: 'ipcap100' }, ip);
    assert.deepEqual([r.status, r.body], [429, { error: 'busy' }]);
    const f = await postFrom({ ...Q, vid: 'ipcap101' }, ip, { 'x-forwarded-for': '192.0.2.1' });
    assert.deepEqual([f.status, f.body], [429, { error: 'busy' }]);
    assert.equal((await postFrom({ ...Q, vid: 'ipcap102' }, '198.51.100.8')).status, 201);
    // 被 IP 上限擋下的不算進全站計數：100 + 另一個 IP 的 1
    assert.equal(env.store('GET', hourKey()), '101');
  });
});

describe('公開列表快取', () => {
  it('讀取途中隱藏並 invalidate，這次的舊結果不寫回快取', async () => {
    const id = (await post(Q)).body.question.id;
    let armed = true;
    // readAll 的 pipeline 讀完瓶子清單（已拿到「未隱藏」的快照）、回應還沒送出時，後台隱藏這題
    const restore = tap((c) => {
      if (armed && c[0] === 'LRANGE' && c[1] === P + 'bottles') {
        armed = false;
        env.store('SADD', P + 'ask:hidden', id);
        invalidate();
      }
    });
    try {
      const first = await env.call('GET', '/api/ask');
      assert.equal(first.status, 200);
      assert.ok(first.body.questions.some((q) => q.id === id), '這次讀取在隱藏前就開始，回舊資料是預期的');
    } finally { restore(); }
    assert.equal(armed, false);
    const g = await env.call('GET', '/api/ask');
    assert.ok(!g.body.questions.some((q) => q.id === id), '隱藏的題目被舊讀取寫回快取');
  });
  it('冷快取時同時 8 個 GET 只跑一次 readAll', async () => {
    await post(Q);
    let reads = 0;
    const restore = tap((c) => { if (isReadAll(c)) reads++; });
    try {
      const rs = await Promise.all(Array.from({ length: 8 }, () => env.call('GET', '/api/ask')));
      assert.ok(rs.every((r) => r.status === 200 && r.body.questions.length === 1));
      assert.equal(reads, 1);
    } finally { restore(); }
  });
  it('讀取失敗不會卡住：下一次重新讀', async () => {
    env.fake.state.broken = true;
    try {
      assert.equal((await env.call('GET', '/api/ask')).status, 502);
    } finally { env.fake.state.broken = false; }
    assert.equal((await env.call('GET', '/api/ask')).status, 200);
  });
});

describe('島上同步', () => {
  const get = () => env.call('GET', '/api/ask');
  const push = (v) => env.store('LPUSH', P + 'bottles', typeof v === 'string' ? v : JSON.stringify(v));

  it('補建正常瓶子、略過壞資料、不重複', async () => {
    push({ id: 'b1', t: 1000, text: '加油', name: '' });
    push('not json');
    push({ id: 5, text: 'x' });
    const g = await get();
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.questions.map((q) => q.id), ['b1']);
    const q = g.body.questions[0];
    assert.equal(q.origin, 'island');
    assert.equal(q.vil, '');
    assert.equal(q.name, '匿名鎮民');
    invalidate();
    await get();
    assert.equal(env.store('HGETALL', P + 'ask:q').length / 2, 1);
  });
  it('closedAt 之後的新瓶子在關閉時進 excluded', async () => {
    env.store('HSET', P + 'ask:open', 'online', '0', 'closedAt', '5000');
    push({ id: 'b2', t: 4000, text: '早', name: 'a' });
    push({ id: 'b3', t: 6000, text: '晚', name: 'a' });
    await get();
    const ex = env.store('SMEMBERS', P + 'ask:excluded');
    assert.ok(ex.includes('b3'));
    assert.ok(!ex.includes('b2'));
  });
  it('開放中不進 excluded', async () => {
    env.store('HSET', P + 'ask:open', 'online', '1');
    push({ id: 'b4', t: 7000, text: '開', name: 'a' });
    await get();
    assert.ok(!env.store('SMEMBERS', P + 'ask:excluded').includes('b4'));
  });
  it('活動頁提問（ask:1）不被當 island 再建', async () => {
    push({ id: 'a1', t: 1, text: '問', name: 'a', vil: 'x', ask: 1 });
    const g = await get();
    assert.equal(g.body.questions.length, 0);
    assert.equal(env.store('HGETALL', P + 'ask:q').length, 0);
  });
});

describe('我也想問', () => {
  const ask = async () => (await env.call('POST', '/api/ask', { body: Q })).body.question.id;
  const vote = (id, on, vid = 'voter01', ip = '1.2.3.4') =>
    env.call('POST', '/api/ask-vote', { headers: { 'x-forwarded-for': ip }, body: { vid, id, on } });
  const votesOf = async (id) => (await env.call('GET', '/api/ask')).body.questions.find((q) => q.id === id).votes;

  it('同 vid 重複 on:true 只算一次，取消後歸零且不為負', async () => {
    const id = await ask();
    for (let i = 0; i < 2; i++) {
      const r = await vote(id, true);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { id, votes: 1, on: true });
    }
    assert.equal((await vote(id, false)).body.votes, 0);
    const r = await vote(id, false);
    assert.equal(r.status, 200);
    assert.equal(r.body.votes, 0);
  });
  it('不同 vid 累加', async () => {
    const id = await ask();
    await vote(id, true, 'voter01');
    assert.equal((await vote(id, true, 'voter02')).body.votes, 2);
  });
  it('IP 每小時上限 → 429 busy，其他 IP 照常', async () => {
    const id = await ask();
    env.store('SET', P + 'ask:vrl:1.2.3.4:' + Math.floor(Date.now() / 3600e3), '400');
    const r = await vote(id, true);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'busy');
    assert.equal((await vote(id, true, 'voter01', '5.6.7.8')).status, 200);
  });
  it('IP 以 cf-connecting-ip 為準：偽造 X-Forwarded-For 仍被擋', async () => {
    const id = await ask();
    env.store('SET', P + 'ask:vrl:203.0.113.9:' + hourNow(), '400');
    const r = await env.call('POST', '/api/ask-vote', {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '10.9.8.7' },
      body: { vid: 'voter01', id, on: true },
    });
    assert.deepEqual([r.status, r.body], [429, { error: 'busy' }]);
  });
  it('不存在或已隱藏 → 404', async () => {
    assert.equal((await vote('nope', true)).status, 404);
    const id = await ask();
    env.store('SADD', P + 'ask:hidden', id);
    const r = await vote(id, true);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not found');
  });
  it('請求格式錯誤 → 400；非 POST → 405', async () => {
    const id = await ask();
    assert.equal((await vote(id, 'yes')).status, 400);
    assert.equal((await vote(id, true, 'A!')).status, 400);
    assert.equal((await vote(5, true)).status, 400);
    assert.equal((await env.call('GET', '/api/ask-vote')).status, 405);
  });
  it('收題關閉後仍可投票', async () => {
    const id = await ask();
    env.store('HSET', P + 'ask:open', 'online', '0');
    assert.equal((await vote(id, true)).status, 200);
  });
  it('快取失效後 GET /api/ask 反映票數', async () => {
    const id = await ask();
    assert.equal(await votesOf(id), 0);
    await vote(id, true);
    invalidate();
    assert.equal(await votesOf(id), 1);
  });
  it('投票不清快取：投票者看回應的票數，GET 不重讀', async () => {
    const id = await ask();
    let reads = 0;
    const restore = tap((c) => { if (isReadAll(c)) reads++; });
    try {
      assert.equal(await votesOf(id), 0);
      assert.equal(reads, 1);
      const r = await vote(id, true);
      assert.equal(r.body.votes, 1);
      assert.equal(await votesOf(id), 0); // 快取期間（5 秒）其他人看到的還是舊票數
      assert.equal(reads, 1);
    } finally { restore(); }
  });
});
});
