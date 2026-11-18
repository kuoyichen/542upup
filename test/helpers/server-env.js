// 測試共用：起假 Upstash、把環境指向它、再載入 server（_redis.js 在 require 時讀環境變數，順序不可顛倒）。
// 絕不碰正式資料庫。
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createFakeUpstash } = require('../../dev/fake-upstash.js');

const DB_ENV = /(KV|REDIS|UPSTASH)/;
const PICK_ENV = /(KV_REST_API_URL|REDIS_REST_URL|KV_REST_API_TOKEN|REDIS_REST_TOKEN|REDIS_URL|KV_URL)$/;

async function start() {
  const fake = createFakeUpstash();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  const fakeUrl = 'http://127.0.0.1:' + fake.server.address().port;
  for (const k of Object.keys(process.env)) if (DB_ENV.test(k)) delete process.env[k];
  process.env.KV_REST_API_URL = fakeUrl;
  process.env.KV_REST_API_TOKEN = 'dev';
  const server = require('../../server.js');
  for (const k of Object.keys(process.env)) {
    if (PICK_ENV.test(k) && process.env[k]) assert.ok(process.env[k] === fakeUrl || process.env[k] === 'dev', '環境變數 ' + k + ' 不是假 Upstash，中止測試');
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

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
  const store = (cmd, ...args) => fake.store.run(cmd, ...args);
  async function stop() {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fake.server.closeAllConnections();
    await new Promise((r) => fake.server.close(r));
  }
  return { fake, fakeUrl, port, call, store, stop };
}

// 與 test/reply.test.js 相同的帳號流程：reply-setup.js 建帳號 → setup 設密碼 → login 取 cookie
async function adminCookie(env, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-admin-'));
  const links = path.join(dir, 'links.txt');
  try {
    const childEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!DB_ENV.test(k)) childEnv[k] = v;
    childEnv.KV_REST_API_URL = env.fakeUrl;
    childEnv.KV_REST_API_TOKEN = 'dev';
    const script = path.join(__dirname, '..', '..', 'scripts', 'reply-setup.js');
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [script, '--out', links, '--base', 'http://127.0.0.1:9', '--user', name, '--name', name],
        { env: childEnv }, (err, so, se) => (err ? reject(new Error(se || String(err))) : resolve()));
    });
    const line = fs.readFileSync(links, 'utf8').trim().split('\n').find((l) => l.startsWith(name + ' '));
    const m = /#setup=([A-Za-z0-9_-]{43})&user=([a-z0-9_]+)$/.exec(line || '');
    assert.ok(m && m[2] === name, '連結檔沒有 ' + name);
    const password = 'ask-admin-test-pw-01';
    const s = await env.call('POST', '/api/admin', { body: { op: 'setup', user: name, token: m[1], password } });
    assert.equal(s.status, 200);
    const l = await env.call('POST', '/api/admin', { headers: { 'x-forwarded-for': '192.0.2.77' }, body: { op: 'login', username: name, password } });
    assert.equal(l.status, 200);
    const c = (l.headers['set-cookie'] || []).find((x) => x.startsWith('isl_admin='));
    assert.ok(c, '沒有 session cookie');
    return c.split(';')[0];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { start, adminCookie };
