// 後台登入失敗限制：先預扣再驗（併發不超限）、成功還款、行程內併發驗證上限
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { start, adminCookie } = require('./helpers/server-env');

const P = '542upup:';
const PW = 'ask-admin-test-pw-01'; // adminCookie 設的密碼
let env;
before(async () => { env = await start(); await adminCookie(env, 'reservetest'); });
after(async () => { await env.stop(); });
beforeEach(() => { for (const k of [...env.fake.store.data.keys()]) if (k.startsWith(P + 'reply:fail:')) env.store('DEL', k); });

const login = (ip, password) => env.call('POST', '/api/admin', { headers: { 'cf-connecting-ip': ip }, body: { op: 'login', username: 'reservetest', password } });
const hourKeys = () => { const h = Math.floor(Date.now() / 3600e3); return [h, h + 1].map((x) => P + 'reply:fail:all:' + x); };
const hourSum = () => hourKeys().reduce((n, k) => n + Number(env.store('GET', k) || 0), 0);

describe('admin login：預扣', () => {
  it('同 IP 20 個併發錯誤密碼：恰好 8 個 401、12 個 429', async () => {
    // 行程內同時驗證上限是 4，所以 5 波、每波 4 個同時送（一次全送會有些是被行程上限擋掉，不是被 IP 上限擋）
    const rs = [];
    for (let w = 0; w < 5; w++) rs.push(...await Promise.all(Array.from({ length: 4 }, (_, i) => login('198.51.100.20', 'wrong-pass-' + w + i))));
    const n = (c) => rs.filter((r) => r.status === c).length;
    assert.deepEqual([n(401), n(429)], [8, 12]);
  });

  it('失敗幾次後正確登入：清掉 IP 計數，全站小時計數把預扣還回', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await login('198.51.100.21', 'wrong-pass-' + i)).status, 401);
    assert.equal(hourSum(), 3);
    assert.equal((await login('198.51.100.21', PW)).status, 200);
    assert.equal(env.store('GET', P + 'reply:fail:198.51.100.21'), null);
    assert.equal(hourSum(), 3); // 3 次失敗 + 成功的預扣 1 又還回 1
  });

  it('行程內同時驗證上限 4：第 5 個立刻 429，且不發 Redis 指令', async () => {
    const orig = crypto.scrypt;
    let started = 0;
    const release = [];
    // 拖慢 scrypt：前 4 個請求卡在驗證，直到手動放行
    crypto.scrypt = (...a) => { started++; release.push(() => orig(...a)); };
    const cmds = [];
    const exec = env.fake.store.exec;
    try {
      const held = Array.from({ length: 4 }, (_, i) => login('198.51.100.3' + i, 'wrong-pass-' + i));
      for (let i = 0; i < 200 && started < 4; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(started, 4);
      env.fake.store.exec = (c) => { cmds.push(c); return exec(c); };
      const fifth = await login('198.51.100.39', 'wrong-pass-x');
      assert.deepEqual([fifth.status, fifth.body], [429, { error: 'too many attempts' }]);
      assert.deepEqual(cmds, []);
      env.fake.store.exec = exec;
      release.forEach((f) => f());
      assert.deepEqual((await Promise.all(held)).map((r) => r.status), [401, 401, 401, 401]);
    } finally { crypto.scrypt = orig; env.fake.store.exec = exec; release.forEach((f) => f()); }
    // 放行後額度恢復
    assert.equal((await login('198.51.100.40', PW)).status, 200);
  });
});
