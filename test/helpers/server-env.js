// 測試共用：起假 Upstash、把環境指向它、再載入 server（_redis.js 在 require 時讀環境變數，順序不可顛倒）。
// 絕不碰正式資料庫。
const assert = require('node:assert/strict');
const http = require('http');
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
  return { fake, call, store, stop };
}

module.exports = { start };
