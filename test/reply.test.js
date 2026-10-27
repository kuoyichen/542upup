// 留言瓶回覆（帳號制）：/api/admin、/api/replies、/reply 頁面、scripts/reply-setup.js
// 全程接本機假 Upstash（dev/fake-upstash.js），絕不碰正式資料庫。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createFakeUpstash } = require('../dev/fake-upstash.js');

const ROOT = path.join(__dirname, '..');
const SETUP_SCRIPT = path.join(ROOT, 'scripts', 'reply-setup.js');
const P = '542upup:';
const PW_S = 'seaside-bottle-01', PW_S2 = '新的密碼-second-02';
const PW_N = 'nantou-yt-pw-01', PW_N2 = 'nantou-yt-pw-02';
const DB_ENV = /(KV|REDIS|UPSTASH)/;
const PICK_ENV = /(KV_REST_API_URL|REDIS_REST_URL|KV_REST_API_TOKEN|REDIS_REST_TOKEN|REDIS_URL|KV_URL)$/;
const BAD_CRED = { error: 'bad credentials' };

let fake, fakeUrl, server, port, tmp, LINKS;
// 子行程用的環境：拿掉所有資料庫相關變數，只留假 Upstash
const childEnv = (extra) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DB_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
};

function call(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null) {
      if (!('content-type' in h)) h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const post = (body, { cookie, headers = {} } = {}) => call('POST', '/api/admin', { headers: { ...(cookie ? { cookie } : {}), ...headers }, body });
const status = (cookie) => call('GET', '/api/admin', { headers: cookie ? { cookie } : {} });
const setCookieOf = (r) => (r.headers['set-cookie'] || []).find((s) => s.startsWith('isl_admin=')) || '';
const cookieOf = (r) => setCookieOf(r).split(';')[0];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ip = (a) => ({ 'x-forwarded-for': a });
const login = (username, password, a) => post({ op: 'login', username, password }, { headers: ip(a) });
const user = (name) => JSON.parse(fake.store.run('HGET', P + 'reply:users', name));

function runSetup(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SETUP_SCRIPT, '--out', LINKS, '--base', 'http://127.0.0.1:9', ...args],
      { env: childEnv({ KV_REST_API_URL: fakeUrl, KV_REST_API_TOKEN: 'dev' }) },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const linkLines = () => fs.readFileSync(LINKS, 'utf8').trim().split('\n');
// 連結檔「帳號 連結」→ 那個帳號的 token
function tokenOf(name) {
  const line = linkLines().find((l) => l.startsWith(name + ' '));
  const m = /#setup=([A-Za-z0-9_-]{43})&user=([a-z0-9_]+)$/.exec(line || '');
  assert.ok(m && m[2] === name, '連結檔沒有 ' + name);
  return m[1];
}

before(async () => {
  fake = createFakeUpstash();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  fakeUrl = 'http://127.0.0.1:' + fake.server.address().port;
  // _redis.js 在 require 時讀環境變數：先清掉所有資料庫變數、指向假 Upstash，再載入 server
  for (const k of Object.keys(process.env)) if (DB_ENV.test(k)) delete process.env[k];
  process.env.KV_REST_API_URL = fakeUrl;
  process.env.KV_REST_API_TOKEN = 'dev';
  server = require('../server.js');
  // server.js 會讀 .env（不覆蓋既有變數）；確認沒有任何正式連線設定混進來，才開始送請求
  for (const k of Object.keys(process.env)) {
    if (PICK_ENV.test(k) && process.env[k]) assert.ok(process.env[k] === fakeUrl || process.env[k] === 'dev', '環境變數 ' + k + ' 不是假 Upstash，中止測試');
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-test-'));
  LINKS = path.join(tmp, 'links.txt');
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fake.server.closeAllConnections();
  await new Promise((r) => fake.server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('回覆後台（帳號制）', () => {
  let sessS, sessS2, sessN;

  it('未設定：ready=false、authed=false、user=null，且 no-store', async () => {
    assert.ok(fakeUrl.startsWith('http://127.0.0.1:'));
    const r = await status();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ready: false, authed: false, user: null });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('reply-setup.js 建立 smalt：連結檔 0600 一行、不印 token、清掉舊版 reply:setup 但不動 reply:pw', async () => {
    fake.store.run('SET', P + 'reply:setup', 'legacy-hash', 'EX', 600);
    fake.store.run('SET', P + 'reply:pw', 'legacy-record');
    const r = await runSetup(['--user', 'smalt', '--name', '小編']);
    assert.equal(r.code, 0, r.stderr);
    const token = tokenOf('smalt');
    assert.deepEqual(linkLines(), ['smalt http://127.0.0.1:9/reply#setup=' + token + '&user=smalt']);
    assert.equal(fs.statSync(LINKS).mode & 0o777, 0o600);
    assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
    assert.ok(r.stdout.includes(LINKS) && r.stdout.includes('小編'));
    assert.equal(fake.store.run('GET', P + 'reply:setup:smalt'), sha(token));
    const ttl = fake.store.run('TTL', P + 'reply:setup:smalt');
    assert.ok(ttl > 604700 && ttl <= 604800, 'ttl ' + ttl);
    assert.equal(fake.store.run('GET', P + 'reply:setup'), null);
    assert.equal(fake.store.run('GET', P + 'reply:pw'), 'legacy-record');
    assert.equal(user('smalt').display, '小編');
    assert.equal(user('smalt').pw, '');
  });

  it('reply-setup.js 建立 nantou_yt：只新增那一行，smalt 那行不變', async () => {
    const before = linkLines()[0];
    const r = await runSetup(['--user', 'nantou_yt', '--name', '媛婷']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(linkLines().length, 2);
    assert.equal(linkLines()[0], before);
    assert.equal(user('nantou_yt').display, '媛婷');
  });

  it('reply-setup.js 參數錯誤、帳號重複或不存在都失敗，連結檔不變', async () => {
    const snap = fs.readFileSync(LINKS, 'utf8');
    const bad = [
      [['--user', 'smalt', '--name', '又一個']], // 已存在
      [['--user', 'ghost', '--reset']],          // 不存在
      [['--user', 'a b', '--name', 'x']],
      [['--user', 'newbie']],                    // 缺 --name
      [['--user', 'smalt', '--reset', '--name', 'x']],
      [['--user', 'newbie', '--name', 'x', '--base', 'ftp://x']],
    ];
    for (const [a] of bad) assert.equal((await runSetup(a)).code, 1, a.join(' '));
    assert.match((await runSetup(['--user', 'smalt', '--name', '又一個'])).stderr, /--reset/);
    assert.equal(fs.readFileSync(LINKS, 'utf8'), snap);
    assert.equal(fake.store.run('HGET', P + 'reply:users', 'ghost'), null);
    assert.equal(fake.store.run('HGET', P + 'reply:users', 'newbie'), null);
  });

  it('帳號都還沒設密碼：ready=false，登入一律「帳號或密碼不正確」', async () => {
    assert.equal((await status()).body.ready, false);
    const r = await login('smalt', 'anything-at-all', '192.0.2.1');
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, BAD_CRED);
  });

  it('setupinfo：token 錯、帳號對不上、帳號不存在都 403；正確回顯示名稱', async () => {
    const tok = tokenOf('smalt');
    assert.equal((await post({ op: 'setupinfo', user: 'smalt', token: 'x'.repeat(43) })).status, 403);
    assert.equal((await post({ op: 'setupinfo', user: 'nantou_yt', token: tok })).status, 403);
    assert.equal((await post({ op: 'setupinfo', user: 'ghost', token: tok })).status, 403);
    const r = await post({ op: 'setupinfo', user: 'smalt', token: tok });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { user: { name: 'smalt', display: '小編' } });
  });

  it('setup：token 錯 403、密碼太短 400（token 仍可用）', async () => {
    const tok = tokenOf('smalt');
    assert.equal((await post({ op: 'setup', user: 'smalt', token: 'x'.repeat(43), password: PW_S })).status, 403);
    assert.equal((await post({ op: 'setup', user: 'smalt', token: tok, password: 'short' })).status, 400);
    assert.equal(fake.store.run('GET', P + 'reply:setup:smalt'), sha(tok));
    assert.equal(user('smalt').pw, '');
  });

  it('setup smalt 成功：HttpOnly + SameSite=Strict cookie、連結用過即失效', async () => {
    const tok = tokenOf('smalt');
    const r = await post({ op: 'setup', user: 'smalt', token: tok, password: PW_S });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, user: { name: 'smalt', display: '小編' } });
    const sc = setCookieOf(r);
    assert.match(sc, /^isl_admin=[A-Za-z0-9_-]{43};/);
    assert.match(sc, /; HttpOnly/);
    assert.match(sc, /; SameSite=Strict/);
    assert.match(sc, /; Path=\/api\/admin/);
    assert.match(sc, /; Max-Age=2592000/);
    assert.doesNotMatch(sc, /Secure/);
    assert.match(user('smalt').pw, /^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.equal(user('smalt').display, '小編');
    assert.equal(fake.store.run('GET', P + 'reply:setup:smalt'), null);
    sessS = cookieOf(r);
    assert.deepEqual((await status(sessS)).body, { ready: true, authed: true, user: { name: 'smalt', display: '小編' } });
    assert.deepEqual((await status()).body, { ready: true, authed: false, user: null });
    assert.equal((await post({ op: 'setup', user: 'smalt', token: tok, password: PW_S2 })).status, 403);
  });

  it('setup nantou_yt 成功，各自的 session 各自是誰', async () => {
    const r = await post({ op: 'setup', user: 'nantou_yt', token: tokenOf('nantou_yt'), password: PW_N });
    assert.equal(r.status, 200);
    sessN = cookieOf(r);
    assert.deepEqual((await status(sessN)).body.user, { name: 'nantou_yt', display: '媛婷' });
    assert.deepEqual((await status(sessS)).body.user, { name: 'smalt', display: '小編' });
  });

  it('login：帳號不存在、密碼錯、帳號還沒設密碼，回應完全一樣且都跑 scrypt', async () => {
    assert.equal((await runSetup(['--user', 'nopw01', '--name', '還沒設'])).code, 0);
    const real = crypto.scrypt;
    let calls = 0;
    crypto.scrypt = (...a) => { calls++; return real(...a); };
    try {
      const cases = [['ghost', PW_S], ['smalt', 'wrong-password'], ['nopw01', PW_S], ['不合法 帳號', PW_S]];
      for (const [u, p] of cases) {
        calls = 0;
        const r = await login(u, p, '192.0.2.2');
        assert.equal(r.status, 401, u);
        assert.deepEqual(r.body, BAD_CRED, u);
        assert.equal(setCookieOf(r), '');
        assert.ok(calls >= 1, u + ' 沒有跑 scrypt');
      }
    } finally {
      crypto.scrypt = real;
    }
    fake.store.run('DEL', P + 'reply:fail:192.0.2.2');
  });

  it('login：帳號不分大小寫、去頭尾空白；回傳是誰', async () => {
    const r = await login('  SMALT ', PW_S, '192.0.2.3');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, user: { name: 'smalt', display: '小編' } });
    sessS2 = cookieOf(r);
    assert.equal((await status(sessS2)).body.user.name, 'smalt');
    assert.equal((await login('nantou_yt', PW_S, '192.0.2.3')).status, 401); // 別人的密碼不能登
  });

  it('login：同一 IP 失敗 8 次後 429（先擋再驗，正確密碼也擋）', async () => {
    const h = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
    for (let i = 0; i < 8; i++) assert.equal((await post({ op: 'login', username: 'smalt', password: 'wrong-' + i }, { headers: h })).status, 401);
    assert.equal((await post({ op: 'login', username: 'smalt', password: PW_S }, { headers: h })).status, 429);
    assert.equal(fake.store.run('GET', P + 'reply:fail:203.0.113.7'), '8');
    // 別的 IP 不受影響（cf-connecting-ip 優先）
    const ok = await post({ op: 'login', username: 'smalt', password: PW_S }, { headers: { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(ok.status, 200);
  });

  it('login：全站每小時失敗超過上限 429', async () => {
    const hour = Math.floor(Date.now() / 3600e3);
    const keys = [hour, hour + 1].map((x) => P + 'reply:fail:all:' + x);
    const prev = keys.map((k) => fake.store.run('GET', k));
    keys.forEach((k) => fake.store.run('SET', k, '60'));
    assert.equal((await login('nantou_yt', PW_N, '192.0.2.44')).status, 429);
    keys.forEach((k, i) => (prev[i] === null ? fake.store.run('DEL', k) : fake.store.run('SET', k, prev[i])));
  });

  it('login 成功：清掉該 IP 的失敗次數，https 時 cookie 帶 Secure', async () => {
    const h = { 'x-forwarded-for': '192.0.2.10', 'x-forwarded-proto': 'https' };
    assert.equal((await post({ op: 'login', username: 'nantou_yt', password: 'nope-nope' }, { headers: h })).status, 401);
    assert.equal(fake.store.run('GET', P + 'reply:fail:192.0.2.10'), '1');
    const r = await post({ op: 'login', username: 'nantou_yt', password: PW_N }, { headers: h });
    assert.equal(r.status, 200);
    assert.match(setCookieOf(r), /; Secure$/);
    assert.equal(fake.store.run('GET', P + 'reply:fail:192.0.2.10'), null);
  });

  it('list：未登入或亂給 cookie 都 401', async () => {
    assert.equal((await call('GET', '/api/admin?list=1')).status, 401);
    assert.equal((await call('GET', '/api/admin?list=1', { headers: { cookie: 'isl_admin=' + 'A'.repeat(43) } })).status, 401);
    assert.equal((await call('GET', '/api/admin?list=1', { headers: { cookie: 'isl_admin=../../x' } })).status, 401);
  });

  it('list：回傳登入者、保留中的瓶子，回覆帶存檔者顯示名稱；舊回覆沒有 by 照常顯示', async () => {
    fake.seed([
      { id: 'mz3abc01', t: 1761500000000, name: '甲', text: '第一則\n換行' },
      { id: 'mz3abc02', t: 1761400000000, name: '乙', text: '第二則', reply: { text: '謝謝！', t: 1761450000000 } },
      { id: 'mz3abc03', t: 1761300000000, name: '丙', text: '第三則', reply: { text: '收到', t: 1761350000000, by: 'nantou_yt' } },
      { id: 'mz3abc04', t: 1761200000000, name: '丁', text: '第四則', reply: { text: '好', t: 1761250000000, by: 'ghost' } },
    ]);
    fake.store.run('LPUSH', P + 'bottles', 'not json'); // 壞資料要略過
    const r = await call('GET', '/api/admin?list=1', { headers: { cookie: sessS } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body.user, { name: 'smalt', display: '小編' });
    assert.deepEqual(r.body.bottles.map((b) => b.id), ['mz3abc01', 'mz3abc02', 'mz3abc03', 'mz3abc04']);
    assert.deepEqual(r.body.bottles[0], { id: 'mz3abc01', t: 1761500000000, name: '甲', text: '第一則\n換行' });
    assert.deepEqual(r.body.bottles[1].reply, { text: '謝謝！', t: 1761450000000 });
    assert.deepEqual(r.body.bottles[2].reply, { text: '收到', t: 1761350000000, by: 'nantou_yt', byName: '媛婷' });
    assert.deepEqual(r.body.bottles[3].reply, { text: '好', t: 1761250000000, by: 'ghost', byName: 'ghost' });
  });

  it('reply：未登入 401；不存在或格式錯的 id 404；缺 text 400', async () => {
    assert.equal((await post({ op: 'reply', id: 'mz3abc01', text: 'hi' })).status, 401);
    assert.equal((await post({ op: 'reply', id: 'zzzzzzzz', text: 'hi' }, { cookie: sessS })).status, 404);
    assert.equal((await post({ op: 'reply', id: 'AB!', text: 'hi' }, { cookie: sessS })).status, 404);
    assert.equal((await post({ op: 'reply', id: 'mz3abc01' }, { cookie: sessS })).status, 400);
  });

  it('reply：超過 300 字 400，剛好 300 字可以', async () => {
    assert.equal((await post({ op: 'reply', id: 'mz3abc01', text: '字'.repeat(301) }, { cookie: sessS })).status, 400);
    const r = await post({ op: 'reply', id: 'mz3abc01', text: '字'.repeat(300) }, { cookie: sessS });
    assert.equal(r.status, 200);
    assert.equal(r.body.reply.text.length, 300);
  });

  it('reply：存檔記下 by，回傳顯示名稱；公開 /api/replies 不帶 by', async () => {
    const r = await post({ op: 'reply', id: 'mz3abc01', text: '  <b>謝謝你</b>\r\n\r\n\r\n\r\n下次見\u0007  ' }, { cookie: sessS });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'mz3abc01');
    assert.equal(r.body.reply.text, 'b謝謝你/b\n\n下次見');
    assert.equal(r.body.reply.by, 'smalt');
    assert.equal(r.body.reply.byName, '小編');
    assert.ok(Math.abs(r.body.reply.t - Date.now()) < 5000);
    assert.equal(JSON.parse(fake.store.run('HGET', P + 'replies', 'mz3abc01')).by, 'smalt');
    const n = await post({ op: 'reply', id: 'mz3abc02', text: '媛婷改寫的回覆' }, { cookie: sessN });
    assert.equal(n.body.reply.by, 'nantou_yt');
    assert.equal(n.body.reply.byName, '媛婷');
    const pub = await call('GET', '/api/replies');
    assert.equal(pub.status, 200);
    assert.equal(pub.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(pub.body.replies).sort(), ['mz3abc01', 'mz3abc02', 'mz3abc03', 'mz3abc04']);
    assert.deepEqual(pub.body.replies.mz3abc01, { text: 'b謝謝你/b\n\n下次見', t: r.body.reply.t });
    assert.doesNotMatch(pub.text, /"by(Name)?"|smalt|nantou_yt|ghost/);
    assert.equal((await call('POST', '/api/replies', { body: {} })).status, 405);
  });

  it('reply：空字串＝刪除回覆', async () => {
    const r = await post({ op: 'reply', id: 'mz3abc04', text: ' \n ' }, { cookie: sessN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 'mz3abc04', deleted: true });
    const pub = await call('GET', '/api/replies');
    assert.deepEqual(Object.keys(pub.body.replies).sort(), ['mz3abc01', 'mz3abc02', 'mz3abc03']);
  });

  it('公開 /api/replies 只回保留中瓶子的回覆（不刪資料）', async () => {
    fake.store.run('HSET', P + 'replies', 'gone00001', JSON.stringify({ text: '舊瓶子的回覆', t: 1, by: 'smalt' }));
    const pub = await call('GET', '/api/replies');
    assert.equal(pub.status, 200);
    assert.ok(!('gone00001' in pub.body.replies));
    assert.ok(fake.store.run('HGET', P + 'replies', 'gone00001'));
  });

  it('reply：瓶子已不在清單時，存檔 404、刪除照樣成功', async () => {
    assert.equal((await post({ op: 'reply', id: 'gone00001', text: '新的回覆' }, { cookie: sessS })).status, 404);
    const r = await post({ op: 'reply', id: 'gone00001', text: '' }, { cookie: sessS });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 'gone00001', deleted: true });
    assert.equal(fake.store.run('HGET', P + 'replies', 'gone00001'), null);
    assert.equal((await post({ op: 'reply', id: 'BAD!', text: '' }, { cookie: sessS })).status, 404);
  });

  it('list：一次 HDEL 清掉孤兒回覆，沒有孤兒時不送 HDEL', async () => {
    fake.store.run('HSET', P + 'replies', 'gone00002', JSON.stringify({ text: 'a', t: 1 }), 'gone00003', 'not json');
    const seen = [], orig = fake.store.exec;
    fake.store.exec = (cmd) => { seen.push(cmd); return orig(cmd); };
    const hdels = () => seen.filter((c) => String(c[0]).toUpperCase() === 'HDEL');
    try {
      const r = await call('GET', '/api/admin?list=1', { headers: { cookie: sessS } });
      assert.equal(r.status, 200);
      assert.equal(hdels().length, 1);
      assert.deepEqual(hdels()[0].slice(1), [P + 'replies', 'gone00002', 'gone00003']);
      assert.equal(fake.store.run('HGET', P + 'replies', 'gone00002'), null);
      assert.equal(fake.store.run('HGET', P + 'replies', 'gone00003'), null);
      assert.ok(fake.store.run('HGET', P + 'replies', 'mz3abc02'));
      seen.length = 0;
      assert.equal((await call('GET', '/api/admin?list=1', { headers: { cookie: sessS } })).status, 200);
      assert.equal(hdels().length, 0);
    } finally {
      fake.store.exec = orig;
    }
  });

  it('password：舊密碼錯 403、新密碼太短 400、未登入 401', async () => {
    assert.equal((await post({ op: 'password', old: 'wrong-old-pw', password: PW_S2 }, { cookie: sessS })).status, 403);
    assert.equal((await post({ op: 'password', old: PW_S, password: 'short' }, { cookie: sessS })).status, 400);
    assert.equal((await post({ op: 'password', old: PW_S, password: PW_S2 })).status, 401);
  });

  it('password：smalt 改密碼只登出 smalt 的所有 session，nantou_yt 不受影響', async () => {
    const r = await post({ op: 'password', old: PW_S, password: PW_S2 }, { cookie: sessS });
    assert.equal(r.status, 200);
    const fresh = cookieOf(r);
    assert.ok(fresh && fresh !== sessS);
    assert.equal((await status(sessS)).body.authed, false);
    assert.equal((await status(sessS2)).body.authed, false);
    assert.equal((await status(fresh)).body.authed, true);
    assert.deepEqual((await status(sessN)).body.user, { name: 'nantou_yt', display: '媛婷' });
    assert.equal(user('smalt').display, '小編');
    assert.equal((await login('smalt', PW_S, '192.0.2.20')).status, 401);
    assert.equal((await login('smalt', PW_S2, '192.0.2.20')).status, 200);
    sessS = fresh;
  });

  it('--reset：重發連結讓舊連結失效；舊密碼在新連結用掉前照常可用；用掉後只登出該帳號', async () => {
    const r1 = await runSetup(['--user', 'nantou_yt', '--reset']);
    assert.equal(r1.code, 0, r1.stderr);
    const a = tokenOf('nantou_yt');
    const r2 = await runSetup(['--user', 'nantou_yt', '--reset']);
    assert.equal(r2.code, 0, r2.stderr);
    const b = tokenOf('nantou_yt');
    assert.notEqual(a, b);
    assert.ok(!r2.stdout.includes(b));
    assert.equal(linkLines().filter((l) => l.startsWith('nantou_yt ')).length, 1);
    assert.ok(linkLines().some((l) => l.startsWith('smalt ')));
    assert.equal(fs.statSync(LINKS).mode & 0o777, 0o600);
    // 新連結用掉之前：舊密碼與既有 session 都還有效，第一次發的連結已失效
    assert.equal((await status(sessN)).body.authed, true);
    const before = await login('nantou_yt', PW_N, '192.0.2.21');
    assert.equal(before.status, 200);
    assert.equal((await post({ op: 'setupinfo', user: 'nantou_yt', token: a })).status, 403);
    assert.equal((await post({ op: 'setup', user: 'nantou_yt', token: a, password: PW_N2 })).status, 403);
    assert.deepEqual((await post({ op: 'setupinfo', user: 'nantou_yt', token: b })).body.user, { name: 'nantou_yt', display: '媛婷' });
    const s = await post({ op: 'setup', user: 'nantou_yt', token: b, password: PW_N2 });
    assert.equal(s.status, 200);
    assert.equal((await status(sessN)).body.authed, false);
    assert.equal((await status(cookieOf(before))).body.authed, false);
    assert.equal((await status(cookieOf(s))).body.user.name, 'nantou_yt');
    assert.equal((await status(sessS)).body.user.name, 'smalt');
    assert.equal((await login('nantou_yt', PW_N, '192.0.2.21')).status, 401);
    assert.equal((await login('nantou_yt', PW_N2, '192.0.2.21')).status, 200);
    sessN = cookieOf(s);
  });

  it('logout：清 cookie，同一個 token 之後無效，其他帳號不受影響', async () => {
    const r = await post({ op: 'logout' }, { cookie: sessN });
    assert.equal(r.status, 200);
    assert.match(setCookieOf(r), /^isl_admin=; Path=\/api\/admin; Max-Age=0; HttpOnly; SameSite=Strict/);
    assert.equal((await status(sessN)).body.authed, false);
    assert.equal((await post({ op: 'reply', id: 'mz3abc03', text: 'hi' }, { cookie: sessN })).status, 401);
    assert.equal((await status(sessS)).body.authed, true);
  });

  it('POST 不是 JSON 415', async () => {
    assert.equal((await post('{"op":"logout"}', { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post('op=logout', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await post({ op: 'logout' }, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
  });

  it('Origin 不是本站 403；本站或反向代理的 X-Forwarded-Host 可以', async () => {
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'null' } })).status, 403);
    assert.equal((await post({ op: 'login', username: 'smalt', password: PW_S2 }, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'http://127.0.0.1:' + port } })).status, 200);
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'https://island.542upup.tw', 'x-forwarded-host': 'island.542upup.tw' } })).status, 200);
  });

  it('其他方法 405、未知 op 400、非物件 body 400、缺欄位 400', async () => {
    assert.equal((await call('PUT', '/api/admin', { body: {} })).status, 405);
    assert.equal((await post({ op: 'nope' })).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post('[1,2]')).status, 400);
    assert.equal((await post({ op: '__proto__' })).status, 400);
    assert.equal((await post({ op: 'login', password: PW_S2 })).status, 400);
    assert.equal((await post({ op: 'setup', user: 'smalt', token: 'x'.repeat(43) })).status, 400);
  });

  it('資料庫出錯 502，不洩漏細節', async () => {
    fake.state.broken = true;
    try {
      const a = await status(sessS);
      assert.equal(a.status, 502);
      assert.deepEqual(a.body, { error: 'storage error' });
      const b = await call('GET', '/api/replies');
      assert.equal(b.status, 502);
      assert.deepEqual(b.body, { error: 'storage error' });
    } finally {
      fake.state.broken = false;
    }
  });

  it('沒有資料庫設定時 503', async () => {
    const code = `const run = (f) => new Promise((ok) => { const res = { h: {}, setHeader(k, v) { this.h[k] = v; }, status(n) { this.code = n; return this; }, json(o) { ok({ code: this.code, o, cc: this.h['Cache-Control'] }); } }; require(f)({ method: 'GET', url: '/', headers: {} }, res); });
      Promise.all([run(${JSON.stringify(path.join(ROOT, 'api', 'replies.js'))}), run(${JSON.stringify(path.join(ROOT, 'api', 'admin.js'))})]).then((x) => { console.log(JSON.stringify(x)); process.exit(0); });`;
    const out = await new Promise((ok, no) => execFile(process.execPath, ['-e', code], { env: childEnv({}) }, (e, so) => (e ? no(e) : ok(so))));
    assert.deepEqual(JSON.parse(out), [{ code: 503, o: { error: 'not configured' }, cc: 'no-store' }, { code: 503, o: { error: 'not configured' }, cc: 'no-store' }]);
  });

  it('/reply 提供後台頁面（noindex、帳號登入、設定連結帶帳號）', async () => {
    const r = await call('GET', '/reply');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /<meta name="robots" content="noindex,nofollow">/);
    assert.doesNotMatch(r.text, /window\.(confirm|alert|prompt)|\b(confirm|alert|prompt)\(/);
    assert.match(r.text, /帳號或密碼不正確。/);
    assert.match(r.text, /#setup=\(\[A-Za-z0-9_-\]\{20,128\}\)&user=/);
    assert.match(r.text, /addEventListener\('hashchange'/);
    assert.equal((await call('HEAD', '/reply')).status, 200);
    assert.equal((await call('POST', '/reply', { body: {} })).status, 405);
    const home = await call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /bottle-reply/);
  });

  it('敏感檔與開發檔一律 404', async () => {
    const paths = ['/.reply-setup-link.txt', '/.reply-setup-links.txt', '/scripts/reply-setup.js', '/dev/fake-upstash.js', '/dev/sample-bottles.json',
      '/test/reply.test.js', '/server.js', '/package.json', '/.env', '/.gitignore', '/api/admin.js', '/api/_redis.js',
      '/reply/', '/%2e%2e/server.js', '/scripts%2freply-setup.js'];
    for (const p of paths) assert.equal((await call('GET', p)).status, 404, p);
  });

  it('既有 /api/track、/api/bottles 照常運作（假 Upstash 指令齊全）', async () => {
    assert.equal((await call('POST', '/api/track', { body: { t: 'view', v: 'abcdef123' } })).status, 204);
    assert.equal((await call('POST', '/api/track', { body: { t: 'dwell', s: 42 } })).status, 204);
    const tr = await call('GET', '/api/track');
    assert.equal(tr.status, 200);
    assert.equal(tr.body.views, 1);
    assert.equal(tr.body.visitors, 1);
    assert.equal(tr.body.dwell, 42);
    assert.equal(tr.body.days.length, 14);
    const sent = await call('POST', '/api/bottles', { body: { vid: 'abcdef123', text: '測試瓶子', name: '' } });
    assert.equal(sent.status, 201);
    assert.equal((await call('POST', '/api/bottles', { body: { vid: 'abcdef123', text: '再一個' } })).status, 429);
    const list = await call('GET', '/api/bottles');
    assert.equal(list.body.bottles[0].id, sent.body.bottle.id);
    assert.equal(list.body.bottles.length, 5);
    // 新瓶子馬上可以回覆
    assert.equal((await post({ op: 'reply', id: sent.body.bottle.id, text: '收到' }, { cookie: sessS })).status, 200);
  });
});
