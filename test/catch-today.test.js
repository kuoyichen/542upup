// 捕捉媛婷：/api/catch-today（api/catch-today.js）
// 上游一律是假的：單元測試注入 fetch 與時鐘，整合測試接本機假 bot；絕不連正式 bot 或資料庫。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// 保險：預設 handler 萬一在設好假 bot 前被叫到，也只會打到沒人聽的本機 port
process.env.CATCH_TODAY_URL = 'http://127.0.0.1:9/api/catch/today';
const { createHandler, validate } = require('../api/catch-today.js');

const T0 = Date.parse('2026-11-03T08:00:00+08:00');
const EXPIRES = '2026-11-04T00:00:00+08:00';
const EXP_MS = Date.parse(EXPIRES);
// 含不常見但合法的字元，驗證原樣傳遞
const CLAIM = 'https://liff.line.me/1234567890-AbCdEfGh/catch?c=AbC-_~%2F&x=1#frag';
const active = (extra = {}) => ({ active: true, date: '2026-11-03', island: 'I08', claim_url: CLAIM, expires_at: EXPIRES, ...extra });
const ACTIVE_OUT = { active: true, date: '2026-11-03', island: 'I08', claim_url: CLAIM, expires_at: EXPIRES };

function fakeRes() {
  const headers = {};
  return {
    statusCode: 200, body: undefined, headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    status(n) { this.statusCode = n; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; }
  };
}
async function call(handler, method = 'GET') {
  const res = fakeRes();
  await handler({ method, headers: {} }, res);
  return res;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
function stub(next) {
  const f = async (url, init) => {
    f.calls.push({ url, init });
    const r = typeof f.next === 'function' ? f.next(url, init) : f.next;
    return r instanceof Error ? Promise.reject(r) : r;
  };
  f.calls = [];
  f.next = next;
  return f;
}
const hangAbortable = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
});
function setup(next, opts = {}) {
  const clock = { t: T0 };
  const fetch = stub(next);
  const handler = createHandler({ url: 'https://bot.test/api/catch/today', fetch, now: () => clock.t, ttl: 60e3, timeout: 80, retry: 0, log: () => {}, ...opts });
  return { clock, fetch, handler };
}

describe('/api/catch-today 快取與 expires_at', () => {
  it('active：回規格欄位、no-store、抓的是設定的網址；60 秒內只打一次上游', async () => {
    const { fetch, handler, clock } = setup(() => json(active()));
    const r = await call(handler);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, ACTIVE_OUT);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(fetch.calls[0].url, 'https://bot.test/api/catch/today');
    clock.t += 59_000;
    assert.deepEqual((await call(handler)).body, ACTIVE_OUT);
    assert.equal(fetch.calls.length, 1);
  });

  it('只回規格欄位：上游多給的欄位不外傳', async () => {
    const { handler } = setup(() => json(active({ secret: 'x', extra: 1 })));
    assert.deepEqual((await call(handler)).body, ACTIVE_OUT);
  });

  it('超過 60 秒重新查詢，拿到新資料', async () => {
    const { fetch, handler, clock } = setup(() => json(active()));
    await call(handler);
    fetch.next = () => json(active({ island: 'I03' }));
    clock.t += 60_000;
    assert.equal((await call(handler)).body.island, 'I03');
    assert.equal(fetch.calls.length, 2);
  });

  it('快取的 active 到 expires_at 就不再用：重新查；查失敗回 active:false', async () => {
    const { fetch, handler, clock } = setup(() => json(active()), { ttl: 24 * 3600e3 }); // ttl 拉長，證明靠的是 expires_at
    await call(handler);
    clock.t = EXP_MS - 1;
    assert.equal((await call(handler)).body.active, true);
    assert.equal(fetch.calls.length, 1);
    fetch.next = new Error('down');
    clock.t = EXP_MS; // 剛好等於 expires_at 就算過期
    assert.deepEqual((await call(handler)).body, { active: false });
    assert.equal(fetch.calls.length, 2);
  });

  it('到 expires_at 重新查成功：換成新一天的資料', async () => {
    const { fetch, handler, clock } = setup(() => json(active()), { ttl: 24 * 3600e3 });
    await call(handler);
    const next = active({ date: '2026-11-04', island: 'I09', expires_at: '2026-11-05T00:00:00+08:00' });
    fetch.next = () => json(next);
    clock.t = EXP_MS;
    assert.deepEqual((await call(handler)).body, { ...ACTIVE_OUT, date: '2026-11-04', island: 'I09', expires_at: next.expires_at });
  });

  it('上游 active:false：回 active:false，並取代快取 60 秒', async () => {
    const { fetch, handler, clock } = setup(() => json(active()));
    await call(handler);
    fetch.next = () => json({ active: false });
    clock.t += 60_000;
    assert.deepEqual((await call(handler)).body, { active: false });
    fetch.next = () => json(active());
    clock.t += 30_000;
    assert.deepEqual((await call(handler)).body, { active: false }); // 還在 60 秒內，不重打
    assert.equal(fetch.calls.length, 2);
    clock.t += 30_000;
    assert.equal((await call(handler)).body.active, true);
  });

  it('active 不是 true 就沒有分身（false、缺少、字串 "true"）', async () => {
    for (const body of [{ active: false }, {}, { active: 'true' }, { active: 1 }]) {
      const { handler } = setup(() => json(body));
      assert.deepEqual((await call(handler)).body, { active: false });
    }
  });
});

describe('/api/catch-today 失敗處理', () => {
  const bigBody = () => new Response(JSON.stringify(active({ pad: 'x'.repeat(20 * 1024) })), { status: 200 });
  const FAILURES = {
    '非 200': () => new Response('oops', { status: 500 }),
    '201': () => json(active(), 201),
    '壞 JSON': () => new Response('{not json', { status: 200 }),
    'JSON 不是物件': () => json([1, 2]),
    '兩種形狀都不是（{}）': () => json({}),
    'active 是字串 "true"': () => json({ active: 'true' }),
    'null': () => new Response('null', { status: 200 }),
    '島 id 不合（I13）': () => json(active({ island: 'I13' })),
    '島 id 不合（I00）': () => json(active({ island: 'I00' })),
    '島 id 小寫': () => json(active({ island: 'i08' })),
    'claim_url 是 http': () => json(active({ claim_url: 'http://liff.line.me/x/catch?c=1' })),
    'claim_url 有空白': () => json(active({ claim_url: 'https://liff.line.me/x/catch?c=1 2' })),
    'claim_url 有換行': () => json(active({ claim_url: 'https://liff.line.me/x/catch?c=1\n' })),
    'claim_url 太長': () => json(active({ claim_url: 'https://liff.line.me/' + 'a'.repeat(2000) })),
    'claim_url 不是字串': () => json(active({ claim_url: 123 })),
    '缺 expires_at': () => json(active({ expires_at: undefined })),
    'expires_at 無法解析': () => json(active({ expires_at: 'tomorrow' })),
    'expires_at 已過期': () => json(active({ expires_at: '2026-11-03T07:59:59+08:00' })),
    'expires_at 剛好是現在': () => json(active({ expires_at: '2026-11-03T08:00:00+08:00' })),
    'date 格式不合': () => json(active({ date: '2026/11/03' })),
    '超過大小上限': bigBody,
    '連線錯誤': () => new Error('ECONNREFUSED')
  };

  for (const [name, bad] of Object.entries(FAILURES)) {
    it(`${name}：沒有快取回 active:false`, async () => {
      const { handler } = setup(bad);
      const r = await call(handler);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(r.body, { active: false });
    });
    it(`${name}：還沒到 expires_at 的快取繼續用（stale）`, async () => {
      const { fetch, handler, clock } = setup(() => json(active()));
      await call(handler);
      fetch.next = bad;
      clock.t += 61_000;
      assert.deepEqual((await call(handler)).body, ACTIVE_OUT);
      assert.equal(fetch.calls.length, 2);
    });
  }

  it('逾時（5 秒）：abort 後沒有快取回 active:false；有快取繼續用', async () => {
    const a = setup(hangAbortable);
    assert.deepEqual((await call(a.handler)).body, { active: false });
    const b = setup(() => json(active()));
    await call(b.handler);
    b.fetch.next = hangAbortable;
    b.clock.t += 61_000;
    assert.deepEqual((await call(b.handler)).body, ACTIVE_OUT);
  });

  it('完全不理 abort 的上游也會逾時脫身', async () => {
    const { handler } = setup(() => new Promise(() => {}));
    assert.deepEqual((await call(handler)).body, { active: false });
  });

  it('stale 期間過了 expires_at：不再服務過期的碼', async () => {
    const { fetch, handler, clock } = setup(() => json(active()));
    await call(handler);
    fetch.next = new Error('down');
    clock.t = EXP_MS - 1;
    assert.equal((await call(handler)).body.active, true);
    clock.t = EXP_MS + 1;
    assert.deepEqual((await call(handler)).body, { active: false });
  });

  it('失敗後的重試間隔內不重抓（retry）', async () => {
    const { fetch, handler, clock } = setup(new Error('down'), { retry: 10e3 });
    await call(handler);
    clock.t += 5_000;
    await call(handler);
    assert.equal(fetch.calls.length, 1);
    clock.t += 5_000;
    await call(handler);
    assert.equal(fetch.calls.length, 2);
  });

  it('同時進來的請求共用同一次抓取；失敗也不產生 unhandled rejection', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { fetch, handler } = setup(async () => { await gate; return json(active()); });
    const ps = [call(handler), call(handler), call(handler)];
    release();
    const rs = await Promise.all(ps);
    assert.equal(fetch.calls.length, 1);
    for (const r of rs) assert.deepEqual(r.body, ACTIVE_OUT);
    const bad = setup(() => new Error('x'));
    const rs2 = await Promise.all([call(bad.handler), call(bad.handler)]);
    assert.equal(bad.fetch.calls.length, 1);
    for (const r of rs2) assert.deepEqual(r.body, { active: false });
  });

  it('失敗會寫 log', async () => {
    const msgs = [];
    const { handler } = setup(() => new Response('', { status: 503 }), { log: (m) => msgs.push(m) });
    await call(handler);
    assert.match(msgs[0], /catch-today upstream: upstream 503/);
  });

  it('POST / PUT 回 405，不打上游；HEAD 允許', async () => {
    const { fetch, handler } = setup(() => json(active()));
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await call(handler, m);
      assert.equal(r.statusCode, 405);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
    assert.equal(fetch.calls.length, 0);
    assert.equal((await call(handler, 'HEAD')).statusCode, 200);
  });
});

describe('claim_url 原樣傳遞', () => {
  it('不解析、不重組、不編碼：一個字元都不變', async () => {
    const urls = [
      CLAIM,
      'https://liff.line.me/TESTLIFF/catch?c=FAKE-I08',
      'https://liff.line.me/1-a/catch?c=a%20b%2Fc+d&e=%E4%B8%AD#x',
      'https://liff.line.me/x/catch?c=A.b_c~d!e*f(g)h'
    ];
    for (const u of urls) {
      const { handler } = setup(() => json(active({ claim_url: u })));
      assert.equal((await call(handler)).body.claim_url, u);
    }
  });

  it('validate：合格的資料原樣保留 claim_url，並附 exp', () => {
    const v = validate(active(), T0);
    assert.equal(v.claim_url, CLAIM);
    assert.equal(v.exp, EXP_MS);
    assert.deepEqual(validate({ active: false }, T0), { active: false });
    assert.equal(validate(active({ island: 'I12' }), T0).island, 'I12');
    assert.equal(validate(active({ island: 'I01' }), T0).island, 'I01');
  });
});

// ───────── 透過 server.js 的路由（接本機假 bot）─────────
describe('server.js 的 /api/catch-today 路由', () => {
  let upstream, server, port, hits = 0;
  const DB_ENV = /(KV|REDIS|UPSTASH)/;
  // 假 bot 回「明天才到期」的 active 資料，用真實時鐘算，確保測試時一定在未來
  const expires = new Date(Date.now() + 3600e3).toISOString();

  before(async () => {
    upstream = http.createServer((req, res) => {
      hits++;
      if (req.url !== '/api/catch/today') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: true, date: '2026-11-03', island: 'I05', claim_url: CLAIM, expires_at: expires }));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    process.env.CATCH_TODAY_URL = `http://127.0.0.1:${upstream.address().port}/api/catch/today`;
    for (const k of Object.keys(process.env)) if (DB_ENV.test(k)) delete process.env[k];
    process.env.KV_REST_API_URL = 'http://127.0.0.1:9';
    process.env.KV_REST_API_TOKEN = 'dev';
    server = require('../server.js');
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  });

  const req = (method) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: '/api/catch-today', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });

  it('GET 回今天的島，第二次走快取；HEAD 沒有內文；POST 405', async () => {
    const r = await req('GET');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(r.text), { active: true, date: '2026-11-03', island: 'I05', claim_url: CLAIM, expires_at: expires });
    assert.equal(hits, 1);
    assert.equal((await req('GET')).status, 200);
    assert.equal(hits, 1);
    const h = await req('HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.text, '');
    assert.equal((await req('POST')).status, 405);
  });
});
