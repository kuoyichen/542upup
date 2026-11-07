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
