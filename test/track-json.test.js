// 足跡統計 POST 只收 application/json
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers/server-env');

const P = '542upup:';
let env;
before(async () => { env = await start(); });
after(async () => { await env.stop(); });
beforeEach(() => { env.store('FLUSHALL'); });

describe('track：Content-Type 閘', () => {
  it('text/plain 回 415，不碰 Redis', async () => {
    const cmds = [];
    const orig = env.fake.store.exec;
    env.fake.store.exec = (c) => { cmds.push(c); return orig(c); };
    try {
      const r = await env.call('POST', '/api/track', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ t: 'view', v: 'trackvid01' }) });
      assert.deepEqual([r.status, r.body], [415, { error: 'unsupported media type' }]);
    } finally { env.fake.store.exec = orig; }
    assert.deepEqual(cmds, []);
    assert.equal(env.store('GET', P + 'views'), null);
  });
  it('application/json 的 view 與 dwell 照常計數', async () => {
    assert.equal((await env.call('POST', '/api/track', { body: { t: 'view', v: 'trackvid01' } })).status, 204);
    assert.equal((await env.call('POST', '/api/track', { headers: { 'content-type': 'application/json; charset=UTF-8' }, body: { t: 'dwell', s: 30 } })).status, 204);
    assert.equal(Number(env.store('GET', P + 'views')), 1);
    assert.equal(Number(env.store('GET', P + 'dwell')), 30);
  });
});
