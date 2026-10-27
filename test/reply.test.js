// 留言瓶回覆：/api/admin、/api/replies、/reply 頁面、scripts/reply-setup.js
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
const PW1 = 'seaside-bottle-01';
const PW2 = '新的密碼-second-02';
const DB_ENV = /(KV|REDIS|UPSTASH)/;
const PICK_ENV = /(KV_REST_API_URL|REDIS_REST_URL|KV_REST_API_TOKEN|REDIS_REST_TOKEN|REDIS_URL|KV_URL)$/;

let fake, fakeUrl, server, port, tmp, LINK;
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

function runSetup(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SETUP_SCRIPT, '--out', LINK, '--base', 'http://127.0.0.1:9', ...args],
      { env: childEnv({ KV_REST_API_URL: fakeUrl, KV_REST_API_TOKEN: 'dev' }) },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const linkToken = () => fs.readFileSync(LINK, 'utf8').trim().split('#setup=')[1];

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
  LINK = path.join(tmp, 'link.txt');
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fake.server.closeAllConnections();
  await new Promise((r) => fake.server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('回覆後台', () => {
  let token, sessA, sessB, ids;

  it('未設定：ready=false、authed=false，且 no-store', async () => {
    assert.ok(fakeUrl.startsWith('http://127.0.0.1:'));
    const r = await status();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ready: false, authed: false });
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('reply-setup.js 產生連結：檔案 0600、不印 token、存 sha256 並 7 天到期', async () => {
    const r = await runSetup([]);
    assert.equal(r.code, 0, r.stderr);
    token = linkToken();
    assert.match(fs.readFileSync(LINK, 'utf8'), /^http:\/\/127\.0\.0\.1:9\/reply#setup=[A-Za-z0-9_-]{43}\n$/);
    assert.equal(fs.statSync(LINK).mode & 0o777, 0o600);
    assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
    assert.ok(r.stdout.includes(LINK));
    assert.equal(fake.store.run('GET', P + 'reply:setup'), sha(token));
    const ttl = fake.store.run('TTL', P + 'reply:setup');
    assert.ok(ttl > 604700 && ttl <= 604800, 'ttl ' + ttl);
  });

  it('reply-setup.js 參數錯誤就失敗', async () => {
    const r = await runSetup(['--base', 'ftp://x']);
    assert.equal(r.code, 1);
  });

  it('setup：token 錯誤 403', async () => {
    const r = await post({ op: 'setup', token: 'x'.repeat(43), password: PW1 });
    assert.equal(r.status, 403);
    assert.equal(fake.store.run('GET', P + 'reply:pw'), null);
  });

  it('setup：密碼太短 400，token 仍可用', async () => {
    const r = await post({ op: 'setup', token, password: 'short' });
    assert.equal(r.status, 400);
    assert.equal(fake.store.run('GET', P + 'reply:setup'), sha(token));
  });

  it('setup 成功：寫入 scrypt 雜湊、刪 setup key、發 HttpOnly + SameSite=Strict cookie', async () => {
    const r = await post({ op: 'setup', token, password: PW1 });
    assert.equal(r.status, 200);
    const sc = setCookieOf(r);
    assert.match(sc, /^isl_admin=[A-Za-z0-9_-]{43};/);
    assert.match(sc, /; HttpOnly/);
    assert.match(sc, /; SameSite=Strict/);
    assert.match(sc, /; Path=\/api\/admin/);
    assert.match(sc, /; Max-Age=2592000/);
    assert.doesNotMatch(sc, /Secure/);
    assert.match(fake.store.run('GET', P + 'reply:pw'), /^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.equal(fake.store.run('GET', P + 'reply:setup'), null);
    sessA = cookieOf(r);
    assert.deepEqual((await status(sessA)).body, { ready: true, authed: true });
    assert.deepEqual((await status()).body, { ready: true, authed: false });
  });

  it('第二次 setup 409', async () => {
    const r = await post({ op: 'setup', token, password: PW2 });
    assert.equal(r.status, 409);
  });

  it('已設密碼時 reply-setup.js 不加 --reset 會拒絕', async () => {
    const r = await runSetup([]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--reset/);
  });

  it('login：密碼錯 401', async () => {
    const r = await post({ op: 'login', password: 'not-the-password' });
    assert.equal(r.status, 401);
    assert.equal(setCookieOf(r), '');
  });

  it('login：同一 IP 失敗 8 次後 429（先擋再驗，正確密碼也擋）', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
    for (let i = 0; i < 8; i++) assert.equal((await post({ op: 'login', password: 'wrong-' + i }, { headers: ip })).status, 401);
    const r = await post({ op: 'login', password: PW1 }, { headers: ip });
    assert.equal(r.status, 429);
    assert.equal(fake.store.run('GET', P + 'reply:fail:203.0.113.7'), '8');
    // 別的 IP 不受影響（cf-connecting-ip 優先）
    const ok = await post({ op: 'login', password: PW1 }, { headers: { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' } });
    assert.equal(ok.status, 200);
  });

  it('login：全站每小時失敗超過上限 429', async () => {
    const hour = Math.floor(Date.now() / 3600e3);
    const keys = [hour, hour + 1].map((x) => P + 'reply:fail:all:' + x);
    const prev = keys.map((k) => fake.store.run('GET', k));
    keys.forEach((k) => fake.store.run('SET', k, '60'));
    const r = await post({ op: 'login', password: PW1 }, { headers: { 'x-forwarded-for': '192.0.2.44' } });
    assert.equal(r.status, 429);
    keys.forEach((k, i) => (prev[i] === null ? fake.store.run('DEL', k) : fake.store.run('SET', k, prev[i])));
  });

  it('login 成功：清掉該 IP 的失敗次數，https 時 cookie 帶 Secure', async () => {
    const ip = { 'x-forwarded-for': '192.0.2.10', 'x-forwarded-proto': 'https' };
    assert.equal((await post({ op: 'login', password: 'nope-nope' }, { headers: ip })).status, 401);
    assert.equal(fake.store.run('GET', P + 'reply:fail:192.0.2.10'), '1');
    const r = await post({ op: 'login', password: PW1 }, { headers: ip });
    assert.equal(r.status, 200);
    assert.match(setCookieOf(r), /; Secure$/);
    assert.equal(fake.store.run('GET', P + 'reply:fail:192.0.2.10'), null);
    sessB = cookieOf(r);
    assert.equal((await status(sessB)).body.authed, true);
  });

  it('list：未登入或亂給 cookie 都 401', async () => {
    assert.equal((await call('GET', '/api/admin?list=1')).status, 401);
    assert.equal((await call('GET', '/api/admin?list=1', { headers: { cookie: 'isl_admin=' + 'A'.repeat(43) } })).status, 401);
    assert.equal((await call('GET', '/api/admin?list=1', { headers: { cookie: 'isl_admin=../../x' } })).status, 401);
  });

  it('list：回傳保留中的瓶子並合併回覆', async () => {
    fake.seed([
      { id: 'mz3abc01', t: 1761500000000, name: '甲', text: '第一則\n換行' },
      { id: 'mz3abc02', t: 1761400000000, name: '乙', text: '第二則', reply: { text: '謝謝！', t: 1761450000000 } },
      { id: 'mz3abc03', t: 1761300000000, name: '丙', text: '第三則' },
    ]);
    fake.store.run('LPUSH', P + 'bottles', 'not json'); // 壞資料要略過
    const r = await call('GET', '/api/admin?list=1', { headers: { cookie: sessA } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    ids = r.body.bottles.map((b) => b.id);
    assert.deepEqual(ids, ['mz3abc01', 'mz3abc02', 'mz3abc03']);
    assert.deepEqual(r.body.bottles[0], { id: 'mz3abc01', t: 1761500000000, name: '甲', text: '第一則\n換行' });
    assert.deepEqual(r.body.bottles[1].reply, { text: '謝謝！', t: 1761450000000 });
    assert.equal('reply' in r.body.bottles[2], false);
  });

  it('reply：未登入 401', async () => {
    assert.equal((await post({ op: 'reply', id: 'mz3abc01', text: 'hi' })).status, 401);
  });

  it('reply：不存在或格式錯的 id 404', async () => {
    assert.equal((await post({ op: 'reply', id: 'zzzzzzzz', text: 'hi' }, { cookie: sessA })).status, 404);
    assert.equal((await post({ op: 'reply', id: 'AB!', text: 'hi' }, { cookie: sessA })).status, 404);
    assert.equal((await post({ op: 'reply', id: 'mz3abc01' }, { cookie: sessA })).status, 400);
  });

  it('reply：超過 300 字 400，剛好 300 字可以', async () => {
    assert.equal((await post({ op: 'reply', id: 'mz3abc01', text: '字'.repeat(301) }, { cookie: sessA })).status, 400);
    const r = await post({ op: 'reply', id: 'mz3abc01', text: '字'.repeat(300) }, { cookie: sessA });
    assert.equal(r.status, 200);
    assert.equal(r.body.reply.text.length, 300);
  });

  it('reply：存檔（清理控制字元與 <>、保留換行）並出現在公開 /api/replies', async () => {
    const r = await post({ op: 'reply', id: 'mz3abc01', text: '  <b>謝謝你</b>\r\n\r\n\r\n\r\n下次見\u0007  ' }, { cookie: sessA });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'mz3abc01');
    assert.equal(r.body.reply.text, 'b謝謝你/b\n\n下次見');
    assert.ok(Math.abs(r.body.reply.t - Date.now()) < 5000);
    const pub = await call('GET', '/api/replies');
    assert.equal(pub.status, 200);
    assert.equal(pub.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(pub.body.replies).sort(), ['mz3abc01', 'mz3abc02']);
    assert.equal(pub.body.replies.mz3abc01.text, 'b謝謝你/b\n\n下次見');
    assert.equal((await call('POST', '/api/replies', { body: {} })).status, 405);
  });

  it('reply：空字串＝刪除回覆', async () => {
    const r = await post({ op: 'reply', id: 'mz3abc01', text: ' \n ' }, { cookie: sessA });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 'mz3abc01', deleted: true });
    const pub = await call('GET', '/api/replies');
    assert.deepEqual(Object.keys(pub.body.replies), ['mz3abc02']);
  });

  it('公開 /api/replies 只回保留中瓶子的回覆（不刪資料）', async () => {
    fake.store.run('HSET', P + 'replies', 'gone00001', JSON.stringify({ text: '舊瓶子的回覆', t: 1 }));
    const pub = await call('GET', '/api/replies');
    assert.equal(pub.status, 200);
    assert.deepEqual(Object.keys(pub.body.replies), ['mz3abc02']);
    assert.ok(fake.store.run('HGET', P + 'replies', 'gone00001'));
  });

  it('reply：瓶子已不在清單時，存檔 404、刪除照樣成功', async () => {
    assert.equal((await post({ op: 'reply', id: 'gone00001', text: '新的回覆' }, { cookie: sessA })).status, 404);
    const r = await post({ op: 'reply', id: 'gone00001', text: '' }, { cookie: sessA });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: 'gone00001', deleted: true });
    assert.equal(fake.store.run('HGET', P + 'replies', 'gone00001'), null);
    assert.equal((await post({ op: 'reply', id: 'BAD!', text: '' }, { cookie: sessA })).status, 404);
  });

  it('list：一次 HDEL 清掉孤兒回覆，沒有孤兒時不送 HDEL', async () => {
    fake.store.run('HSET', P + 'replies', 'gone00002', JSON.stringify({ text: 'a', t: 1 }), 'gone00003', 'not json');
    const seen = [], orig = fake.store.exec;
    fake.store.exec = (cmd) => { seen.push(cmd); return orig(cmd); };
    const hdels = () => seen.filter((c) => String(c[0]).toUpperCase() === 'HDEL');
    try {
      const r = await call('GET', '/api/admin?list=1', { headers: { cookie: sessA } });
      assert.equal(r.status, 200);
      assert.equal(hdels().length, 1);
      assert.deepEqual(hdels()[0].slice(1), [P + 'replies', 'gone00002', 'gone00003']);
      assert.equal(fake.store.run('HGET', P + 'replies', 'gone00002'), null);
      assert.equal(fake.store.run('HGET', P + 'replies', 'gone00003'), null);
      assert.ok(fake.store.run('HGET', P + 'replies', 'mz3abc02'));
      assert.deepEqual(r.body.bottles[1].reply.text, '謝謝！');
      seen.length = 0;
      assert.equal((await call('GET', '/api/admin?list=1', { headers: { cookie: sessA } })).status, 200);
      assert.equal(hdels().length, 0);
    } finally {
      fake.store.exec = orig;
    }
  });

  it('password：舊密碼錯 403、新密碼太短 400', async () => {
    assert.equal((await post({ op: 'password', old: 'wrong-old-pw', password: PW2 }, { cookie: sessA })).status, 403);
    assert.equal((await post({ op: 'password', old: PW1, password: 'short' }, { cookie: sessA })).status, 400);
    assert.equal((await post({ op: 'password', old: PW1, password: PW2 })).status, 401);
  });

  it('password：改成功後所有舊 session 失效，這個瀏覽器拿到新 session', async () => {
    const r = await post({ op: 'password', old: PW1, password: PW2 }, { cookie: sessA });
    assert.equal(r.status, 200);
    const fresh = cookieOf(r);
    assert.ok(fresh && fresh !== sessA);
    assert.equal((await status(sessA)).body.authed, false);
    assert.equal((await status(sessB)).body.authed, false);
    assert.equal((await status(fresh)).body.authed, true);
    assert.equal((await post({ op: 'login', password: PW1 }, { headers: { 'x-forwarded-for': '192.0.2.20' } })).status, 401);
    const again = await post({ op: 'login', password: PW2 }, { headers: { 'x-forwarded-for': '192.0.2.20' } });
    assert.equal(again.status, 200);
    sessA = fresh;
    sessB = cookieOf(again);
  });

  it('logout：清 cookie，同一個 token 之後無效', async () => {
    const r = await post({ op: 'logout' }, { cookie: sessB });
    assert.equal(r.status, 200);
    assert.match(setCookieOf(r), /^isl_admin=; Path=\/api\/admin; Max-Age=0; HttpOnly; SameSite=Strict/);
    assert.equal((await status(sessB)).body.authed, false);
    assert.equal((await post({ op: 'reply', id: 'mz3abc03', text: 'hi' }, { cookie: sessB })).status, 401);
    assert.equal((await status(sessA)).body.authed, true);
  });

  it('POST 不是 JSON 415', async () => {
    assert.equal((await post('{"op":"logout"}', { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await post('op=logout', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await post({ op: 'logout' }, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200);
  });

  it('Origin 不是本站 403；本站或反向代理的 X-Forwarded-Host 可以', async () => {
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'null' } })).status, 403);
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'http://127.0.0.1:' + port } })).status, 200);
    assert.equal((await post({ op: 'logout' }, { headers: { origin: 'https://island.542upup.tw', 'x-forwarded-host': 'island.542upup.tw' } })).status, 200);
  });

  it('其他方法 405、未知 op 400、非物件 body 400', async () => {
    assert.equal((await call('PUT', '/api/admin', { body: {} })).status, 405);
    assert.equal((await post({ op: 'nope' })).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post('[1,2]')).status, 400);
    assert.equal((await post({ op: '__proto__' })).status, 400);
  });

  it('資料庫出錯 502，不洩漏細節', async () => {
    fake.state.broken = true;
    try {
      const a = await status(sessA);
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
      Promise.all([run(${JSON.stringify(path.join(ROOT, 'api', 'replies.js'))}), run(${JSON.stringify(path.join(ROOT, 'api', 'admin.js'))})]).then((x) => console.log(JSON.stringify(x)));`;
    const out = await new Promise((ok, no) => execFile(process.execPath, ['-e', code], { env: childEnv({}) }, (e, so) => (e ? no(e) : ok(so))));
    assert.deepEqual(JSON.parse(out), [{ code: 503, o: { error: 'not configured' }, cc: 'no-store' }, { code: 503, o: { error: 'not configured' }, cc: 'no-store' }]);
  });

  it('/reply 提供後台頁面（noindex）', async () => {
    const r = await call('GET', '/reply');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /<meta name="robots" content="noindex,nofollow">/);
    assert.doesNotMatch(r.text, /window\.(confirm|alert|prompt)|\b(confirm|alert|prompt)\(/);
    assert.equal((await call('HEAD', '/reply')).status, 200);
    assert.equal((await call('POST', '/reply', { body: {} })).status, 405);
    const home = await call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /bottle-reply/);
  });

  it('敏感檔與開發檔一律 404', async () => {
    const paths = ['/.reply-setup-link.txt', '/scripts/reply-setup.js', '/dev/fake-upstash.js', '/dev/sample-bottles.json',
      '/test/reply.test.js', '/server.js', '/package.json', '/.env', '/.gitignore', '/api/admin.js', '/api/_redis.js',
      '/reply/', '/%2e%2e/server.js', '/scripts%2freply-setup.js'];
    for (const p of paths) assert.equal((await call('GET', p)).status, 404, p);
  });

  it('reply-setup.js --reset：清掉密碼、所有 session 失效、新連結可以重新設定', async () => {
    const old = token;
    const r = await runSetup(['--reset']);
    assert.equal(r.code, 0, r.stderr);
    token = linkToken();
    assert.notEqual(token, old);
    assert.ok(!r.stdout.includes(token));
    assert.equal(fs.statSync(LINK).mode & 0o777, 0o600);
    assert.deepEqual((await status(sessA)).body, { ready: false, authed: false });
    assert.equal((await post({ op: 'login', password: PW2 })).status, 409);
    assert.equal((await post({ op: 'setup', token: old, password: PW1 })).status, 403);
    const s = await post({ op: 'setup', token, password: PW1 });
    assert.equal(s.status, 200);
    assert.deepEqual((await status(cookieOf(s))).body, { ready: true, authed: true });
    assert.equal((await status(sessA)).body.authed, false);
    // 原有回覆不受重設影響
    assert.deepEqual(Object.keys((await call('GET', '/api/replies')).body.replies), ['mz3abc02']);
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
    assert.equal(list.body.bottles.length, 4);
    // 新瓶子馬上可以回覆
    const r = await post({ op: 'login', password: PW1 }, { headers: { 'x-forwarded-for': '192.0.2.30' } });
    assert.equal((await post({ op: 'reply', id: sent.body.bottle.id, text: '收到' }, { cookie: cookieOf(r) })).status, 200);
  });
});
