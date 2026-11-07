// 後台登入失敗限制：先預扣再驗（併發不超限）、成功與被擋都還款
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, adminCookie } = require('./helpers/server-env');

const P = '542upup:';
const PW = 'ask-admin-test-pw-01'; // adminCookie 設的密碼
let env, cookie;
before(async () => { env = await start(); cookie = await adminCookie(env, 'reservetest'); });
after(async () => { await env.stop(); });
beforeEach(() => { for (const k of [...env.fake.store.data.keys()]) if (k.startsWith(P + 'reply:fail:')) env.store('DEL', k); });

const login = (ip, password) => env.call('POST', '/api/admin', { headers: { 'cf-connecting-ip': ip }, body: { op: 'login', username: 'reservetest', password } });
const hourKeys = () => { const h = Math.floor(Date.now() / 3600e3); return [h, h + 1].map((x) => P + 'reply:fail:all:' + x); };
const hourSum = () => hourKeys().reduce((n, k) => n + Number(env.store('GET', k) || 0), 0);

describe('admin login：預扣', () => {
  it('同 IP 20 個同時送出的錯誤密碼：恰好 8 個 401、12 個 429', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => login('198.51.100.20', 'wrong-pass-' + i)));
    const n = (c) => rs.filter((r) => r.status === c).length;
    assert.deepEqual([n(401), n(429)], [8, 12]);
  });

  it('失敗幾次後正確登入：清掉 IP 計數，全站小時計數把預扣還回', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await login('198.51.100.21', 'wrong-pass-' + i)).status, 401);
    assert.equal(hourSum(), 3);
    assert.equal((await login('198.51.100.21', PW)).status, 200);
    assert.equal(env.store('GET', P + 'reply:fail:198.51.100.21'), null);
    assert.equal(hourSum(), 3);
  });

  it('被擋的 70 次不佔額度：全站計數仍為 8，別的 IP 可正常登入', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await login('198.51.100.22', 'wrong-pass-' + i)).status, 401);
    for (let i = 0; i < 70; i++) assert.equal((await login('198.51.100.22', 'wrong-pass-x' + i)).status, 429);
    assert.equal(hourSum(), 8);
    assert.equal(env.store('GET', P + 'reply:fail:198.51.100.22'), '8');
    assert.equal((await login('198.51.100.23', PW)).status, 200);
  });

  it('password：改密碼成功不讓 IP 計數高於改之前；被擋也不累加', async () => {
    const pw = (ip, old, password) => env.call('POST', '/api/admin', { headers: { cookie, 'cf-connecting-ip': ip }, body: { op: 'password', old, password } });
    const ipKey = P + 'reply:fail:198.51.100.24';
    // 計數已滿時被擋：不累加（先測，因為改密碼成功會讓這個 cookie 失效）
    env.store('SET', ipKey, '8');
    const sum0 = hourSum();
    assert.equal((await pw('198.51.100.24', 'x-wrong-pw-1', 'ask-admin-test-pw-03')).status, 429);
    assert.equal(env.store('GET', ipKey), '8');
    assert.equal(hourSum(), sum0);
    env.store('SET', ipKey, '1');
    const r = await pw('198.51.100.24', PW, 'ask-admin-test-pw-02');
    assert.equal(r.status, 200);
    assert.ok(Number(env.store('GET', ipKey) || 0) <= 1);
  });

  it('固定窗口：已滿的 IP 被擋時不延長 TTL，計數仍為 8', async () => {
    const k = P + 'reply:fail:198.51.100.25';
    env.store('SET', k, '8', 'EX', 2);
    assert.equal((await login('198.51.100.25', 'wrong-pass-0')).status, 429);
    assert.ok(env.store('TTL', k) <= 2);
    assert.equal(env.store('GET', k), '8');
  });

  it('固定窗口：新 IP 第一次失敗後 TTL 在 1 到 900 之間', async () => {
    assert.equal((await login('198.51.100.26', 'wrong-pass-0')).status, 401);
    const ttl = env.store('TTL', P + 'reply:fail:198.51.100.26');
    assert.ok(ttl >= 1 && ttl <= 900, 'ttl=' + ttl);
  });

  it('固定窗口：有值沒 TTL 的 IP key，下一次嘗試後補上 TTL', async () => {
    const k = P + 'reply:fail:198.51.100.27';
    env.store('SET', k, '2');
    assert.equal(env.store('TTL', k), -1);
    assert.equal((await login('198.51.100.27', 'wrong-pass-0')).status, 401);
    const ttl = env.store('TTL', k);
    assert.ok(ttl >= 1 && ttl <= 900, 'ttl=' + ttl);
  });
});
