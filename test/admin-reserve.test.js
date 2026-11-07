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
// 每 IP 失敗計數的 key 依 15 分鐘窗口命名；off 為時間偏移（毫秒）
const ikey = (ip, off = 0) => P + 'reply:fail:' + ip + ':' + Math.floor((Date.now() + off) / 900e3);
const hourKeys = () => { const h = Math.floor(Date.now() / 3600e3); return [h, h + 1].map((x) => P + 'reply:fail:all:' + x); };
const hourSum = () => hourKeys().reduce((n, k) => n + Number(env.store('GET', k) || 0), 0);

describe('admin login：預扣', () => {
  it('同 IP 20 個同時送出的錯誤密碼：恰好 8 個 401、12 個 429', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => login('198.51.100.20', 'wrong-pass-' + i)));
    const n = (c) => rs.filter((r) => r.status === c).length;
    assert.deepEqual([n(401), n(429)], [8, 12]);
  });

  it('失敗 3 次後正確登入：IP 計數與全站計數都剩 3（成功只還自己的預扣）', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await login('198.51.100.21', 'wrong-pass-' + i)).status, 401);
    assert.equal(hourSum(), 3);
    assert.equal((await login('198.51.100.21', PW)).status, 200);
    assert.equal(env.store('GET', ikey('198.51.100.21')), '3');
    assert.equal(hourSum(), 3);
  });

  it('被擋的 70 次不佔額度：全站計數仍為 8，別的 IP 可正常登入', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await login('198.51.100.22', 'wrong-pass-' + i)).status, 401);
    for (let i = 0; i < 70; i++) assert.equal((await login('198.51.100.22', 'wrong-pass-x' + i)).status, 429);
    assert.equal(hourSum(), 8);
    assert.equal(env.store('GET', ikey('198.51.100.22')), '8');
    assert.equal((await login('198.51.100.23', PW)).status, 200);
  });

  it('password：改密碼成功不讓 IP 計數高於改之前；被擋也不累加', async () => {
    const pw = (ip, old, password) => env.call('POST', '/api/admin', { headers: { cookie, 'cf-connecting-ip': ip }, body: { op: 'password', old, password } });
    const ipKey = ikey('198.51.100.24');
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

  it('窗口命名：被擋的請求計數維持 8，下一個窗口重新有 8 次', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await login('198.51.100.25', 'wrong-pass-' + i)).status, 401);
    for (let i = 0; i < 3; i++) assert.equal((await login('198.51.100.25', 'wrong-pass-x' + i)).status, 429);
    assert.equal(env.store('GET', ikey('198.51.100.25')), '8');
    const real = Date.now;
    Date.now = () => real() + 900e3; // 進入下一個窗口
    try {
      for (let i = 0; i < 8; i++) assert.equal((await login('198.51.100.25', 'wrong-pass-n' + i)).status, 401);
      assert.equal((await login('198.51.100.25', 'wrong-pass-n9')).status, 429);
    } finally { Date.now = real; }
  });

  it('新窗口的 key 帶 TTL（2 倍窗口），不會永久留下', async () => {
    assert.equal((await login('198.51.100.26', 'wrong-pass-0')).status, 401);
    const ttl = env.store('TTL', ikey('198.51.100.26'));
    assert.ok(ttl > 900 && ttl <= 1800, 'ttl=' + ttl);
  });

  it('成功登入與被擋請求併發：計數不會變負，也不會多給嘗試次數', async () => {
    const k = ikey('198.51.100.28');
    env.store('SET', k, '7', 'EX', 900);
    const slow = login('198.51.100.28', 'ask-admin-test-pw-02'); // 前面的 password 測試已把密碼改成 -02；先到的請求預扣成 8，進入 scrypt
    await new Promise((r) => setTimeout(r, 15));
    const rejected = await login('198.51.100.28', 'wrong-pass-0'); // 預扣成 9，被擋並還回
    assert.equal(rejected.status, 429);
    assert.equal((await slow).status, 200);
    assert.equal(env.store('GET', k), '7');
    assert.equal((await login('198.51.100.28', 'wrong-pass-1')).status, 401);
    assert.equal((await login('198.51.100.28', 'wrong-pass-2')).status, 429);
  });

  it('還款前舊窗口 key 已不在、時間已進入新窗口：新窗口計數不受影響，下一窗口仍恰好 8 次', async () => {
    const real = Date.now;
    const slow = login('198.51.100.29', 'ask-admin-test-pw-02'); // 預扣在舊窗口，進入 scrypt
    await new Promise((r) => setTimeout(r, 15));
    const oldKey = ikey('198.51.100.29');
    assert.equal(env.store('GET', oldKey), '1');
    env.store('DEL', oldKey);   // 模擬舊窗口 key 在還款前過期
    Date.now = () => real() + 900e3; // 時間進入新窗口
    try {
      assert.equal((await slow).status, 200); // 成功還款落在自己（舊窗口）的 key
      assert.equal(env.store('GET', ikey('198.51.100.29')), null); // 新窗口 key 沒被碰
      for (let i = 0; i < 8; i++) assert.equal((await login('198.51.100.29', 'wrong-pass-' + i)).status, 401);
      assert.equal((await login('198.51.100.29', 'wrong-pass-z')).status, 429);
    } finally { Date.now = real; }
  });
});
