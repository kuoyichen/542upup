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
