// _redis.js 的 Upstash 請求逾時：無回應、body 卡住都要在期限內丟錯
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let srv, mode, saved;
before(async () => {
  srv = http.createServer((req, res) => {
    req.resume();
    if (mode === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); } // 送出 header 後卡住
    // mode === 'none'：收到請求後完全不回應
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/(KV|REDIS|UPSTASH)/.test(k)) delete process.env[k];
  process.env.KV_REST_API_URL = 'http://127.0.0.1:' + srv.address().port;
  process.env.KV_REST_API_TOKEN = 'dev';
  process.env.REDIS_TIMEOUT_MS = '200';
});
after(async () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

describe('_redis.redis 逾時', () => {
  for (const m of ['none', 'body']) {
    it(m === 'none' ? '伺服器不回應' : 'header 送出後 body 卡住', async () => {
      mode = m;
      const { redis } = require('../api/_redis');
      const t0 = Date.now();
      await assert.rejects(redis([['GET', 'x']]));
      assert.ok(Date.now() - t0 < 1500, '應在 1.5 秒內逾時');
    });
  }
});
