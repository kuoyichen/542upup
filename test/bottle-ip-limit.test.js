// 留言瓶：每個來源 IP 每小時上限（換 vid 也繞不過）
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server-env');

const P = '542upup:';
let env;
before(async () => { env = await start(); });
after(async () => { await env.stop(); });
beforeEach(() => { env.store('FLUSHALL'); });

const post = (i, ip) => env.call('POST', '/api/bottles', {
  headers: { 'cf-connecting-ip': ip },
  body: { vid: 'ipvid' + String(i).padStart(4, '0'), text: '第' + i + '則留言', name: '阿明' }
});

describe('bottles：每 IP 每小時上限', () => {
  it('同 IP 換 31 個 vid，第 31 個 429 busy，全站計數 30、寫入 30 則；別的 IP 仍可投', async () => {
    const h0 = Math.floor(Date.now() / 3600e3);
    for (let i = 1; i <= 30; i++) assert.equal((await post(i, '203.0.113.5')).status, 201, '第 ' + i + ' 則');
    const r = await post(31, '203.0.113.5');
    assert.deepEqual([r.status, r.body], [429, { error: 'busy' }]);
    const h1 = Math.floor(Date.now() / 3600e3);
    const sum = [h0, h1].filter((h, i, a) => a.indexOf(h) === i).reduce((n, h) => n + Number(env.store('GET', P + 'bottle:hour:' + h) || 0), 0);
    assert.equal(sum, 30);
    assert.equal(env.store('LRANGE', P + 'bottles', 0, -1).length, 30);
    assert.equal((await post(32, '203.0.113.99')).status, 201);
  });
});
