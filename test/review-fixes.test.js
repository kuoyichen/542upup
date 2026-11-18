// agy 全專案審查確認的四項修正（bottles 計數、Content-Type 閘、票數快取、後台樂觀更新）
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server-env');

const P = '542upup:';
let env, A;
before(async () => { env = await start(); A = require('../api/_ask.js'); });
after(async () => { await env.stop(); });
beforeEach(() => { env.store('FLUSHALL'); A.invalidate(); });

// 監看假 Upstash 收到的每一條指令（執行前記錄）；回傳還原函式
const tapCmds = (list) => {
  const orig = env.fake.store.exec;
  env.fake.store.exec = (cmd) => { list.push(cmd); return orig(cmd); };
  return () => { env.fake.store.exec = orig; };
};

describe('1. bottles：被每人限流擋下的請求不得累加全站小時計數', () => {
  it('同 vid 一則成功、5 則 slow down，小時計數仍為 1', async () => {
    const h0 = Math.floor(Date.now() / 3600e3);
    const body = { vid: 'bottlevid1', text: '今天天氣很好', name: '阿明' };
    const ok = await env.call('POST', '/api/bottles', { body });
    assert.equal(ok.status, 201);
    for (let i = 0; i < 5; i++) {
      const r = await env.call('POST', '/api/bottles', { body });
      assert.deepEqual([r.status, r.body], [429, { error: 'slow down' }]);
    }
    const h1 = Math.floor(Date.now() / 3600e3);
    const sum = [h0, h1].filter((h, i, a) => a.indexOf(h) === i).reduce((n, h) => n + Number(env.store('GET', P + 'bottle:hour:' + h) || 0), 0);
    assert.equal(sum, 1);
  });
});

describe('2. 公開寫入 API 只收 application/json', () => {
  const VILLAGES = require('../api/_villages');
  const cases = [
    ['/api/bottles', { vid: 'ctvid0001', text: '今天天氣很好', name: '阿明' }],
    ['/api/ask', { vid: 'ctvid0001', text: '市場附近什麼時候有停車場？', name: '阿明', vil: VILLAGES[0] }],
    ['/api/ask-vote', { vid: 'ctvid0001', id: 'x', on: true }],
  ];
  for (const [path, payload] of cases) {
    it(path + '：text/plain 與缺 content-type 回 415，且不碰 Redis', async () => {
      const cmds = [];
      const restore = tapCmds(cmds);
      try {
        const a = await env.call('POST', path, { headers: { 'content-type': 'text/plain' }, body: JSON.stringify(payload) });
        assert.deepEqual([a.status, a.body], [415, { error: 'unsupported media type' }]);
        // 缺 content-type：call() 在 headers 沒有該欄位時會補 json，所以改走原始 http 送出
        const b = await new Promise((resolve, reject) => {
          const data = JSON.stringify(payload);
          const req = require('http').request({ host: '127.0.0.1', port: env.port, method: 'POST', path, agent: false, headers: { 'content-length': Buffer.byteLength(data) } },
            (res) => { const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString('utf8')) })); });
          req.on('error', reject); req.end(data);
        });
        assert.deepEqual([b.status, b.body], [415, { error: 'unsupported media type' }]);
      } finally { restore(); }
      assert.deepEqual(cmds, []);
    });
  }
  it('application/json; charset=UTF-8（大小寫、參數）仍可通過', async () => {
    const r = await env.call('POST', '/api/bottles', { headers: { 'content-type': 'Application/JSON ; charset=UTF-8' }, body: cases[0][1] });
    assert.equal(r.status, 201);
  });
  it('網站自己的頁面送出的都是 application/json', () => {
    const fs = require('fs'), path = require('path');
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src('index.html'), /BOTTLE_API, \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}/);
    assert.match(src('ask.html'), /headers: body \? \{ 'content-type': 'application\/json' \}/);
  });
});

describe('3. 票數快取 ask:vc 與定期對帳', () => {
  const VILLAGES = require('../api/_villages');
  const Q = { vid: 'vcvid0001', text: '市場附近什麼時候有停車場？', name: '阿明', vil: VILLAGES[0] };
  // 直接寫 Redis 建題，繞過 45 秒限流
  const seedQ = (id) => env.store('HSET', P + 'ask:q', id, JSON.stringify({ id, t: Date.now(), text: '測試題' + id, name: 'a', vil: 'x', origin: 'ask', src: 'online', raw: '{}' }));
  const vote = (id, vid, on = true) => env.call('POST', '/api/ask-vote', { headers: { 'x-forwarded-for': '1.2.3.4' }, body: { vid, id, on } });
  const list = async () => { A.invalidate(); return (await env.call('GET', '/api/ask')).body.questions; };

  it('(a) 票數來自 ask:vc；快取被改錯時照給快取，強制對帳後恢復並修正 ask:vc', async () => {
    const id = (await env.call('POST', '/api/ask', { body: Q })).body.question.id;
    await vote(id, 'voter001'); await vote(id, 'voter002');
    assert.equal(env.store('HGET', P + 'ask:vc', id), '2');
    A._resetReconcile(); await list(); // 先消耗一次對帳，之後的讀取都在冷卻內
    env.store('HSET', P + 'ask:vc', id, '99');
    assert.equal((await list()).find((q) => q.id === id).votes, 99);
    A._resetReconcile();
    assert.equal((await list()).find((q) => q.id === id).votes, 2);
    assert.equal(env.store('HGET', P + 'ask:vc', id), '2');
    assert.equal((await list()).find((q) => q.id === id).votes, 2);
  });

  it('ask-vote 寫 ask:vc 失敗仍回 200 與正確票數', async () => {
    const id = (await env.call('POST', '/api/ask', { body: Q })).body.question.id;
    const orig = env.fake.store.exec;
    env.fake.store.exec = (cmd) => (cmd[0] === 'HSET' && cmd[1] === P + 'ask:vc' ? { error: 'ERR boom' } : orig(cmd));
    try {
      const r = await vote(id, 'voter001');
      assert.deepEqual([r.status, r.body], [200, { id, votes: 1, on: true }]);
    } finally { env.fake.store.exec = orig; }
  });

  it('(b) 冷卻內的 readAll 不送任何 SCARD', async () => {
    seedQ('s1'); seedQ('s2');
    A._resetReconcile(); await list();
    const cmds = [];
    const restore = tapCmds(cmds);
    try { await list(); await list(); } finally { restore(); }
    assert.ok(cmds.some((c) => c[0] === 'HGETALL' && c[1] === P + 'ask:vc'));
    assert.equal(cmds.filter((c) => c[0] === 'SCARD').length, 0);
  });

  it('(c) 對帳分批：超過 500 題時每個 pipeline 請求不超過 500 條指令', async () => {
    for (let i = 0; i < 1203; i++) env.store('HSET', P + 'ask:q', 'bulk' + i, JSON.stringify({ id: 'bulk' + i, t: Date.now(), text: 'x', name: 'a', vil: 'x', origin: 'ask', src: 'online', raw: '{}' }));
    env.store('SADD', P + 'ask:voters:bulk7', 'aaaaaa', 'bbbbbb');
    // 包 fetch 看每個 /pipeline 請求的指令數
    const sizes = [], origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opt) => { try { const c = JSON.parse(opt.body); if (Array.isArray(c)) sizes.push(c.length); } catch (e) { /* 略 */ } return origFetch(url, opt); };
    try {
      A._resetReconcile();
      const qs = await list();
      assert.equal(qs.length, 1203);
      assert.equal(qs.find((q) => q.id === 'bulk7').votes, 2);
    } finally { globalThis.fetch = origFetch; }
    assert.ok(sizes.length > 3);
    assert.ok(Math.max(...sizes) <= 500, '最大 ' + Math.max(...sizes));
    assert.equal(env.store('HGET', P + 'ask:vc', 'bulk7'), '2');
    assert.equal(env.store('HGET', P + 'ask:vc', 'bulk1202'), '0');
  });
});

describe('4. ask-admin.html act()：請求途中保留樂觀值，失敗還原', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'ask-admin.html'), 'utf8');
  const fn = html.slice(html.indexOf('async function act('), html.indexOf('async function toggleOpen('));
  it('render 之前先套用 answer／src 的樂觀值', () => {
    const iRender = fn.indexOf('S.seq++; render()');
    assert.ok(fn.indexOf('q.answered = body.on') > 0 && fn.indexOf('q.answered = body.on') < iRender);
    assert.ok(fn.indexOf('q.src = body.src') > 0 && fn.indexOf('q.src = body.src') < iRender);
  });
  it('非 200 時在錯誤處理之前還原舊值', () => {
    const iRestore = fn.indexOf("r.status !== 200) { q.answered = oldAnswered; q.src = oldSrc; }");
    assert.ok(iRestore > fn.indexOf('await api('));
    assert.ok(iRestore < fn.indexOf('r.status === 401'));
  });
});
