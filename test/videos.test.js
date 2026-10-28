// 影音紀錄跟官網同步：/api/videos（api/videos.js）與頁面的 mergeVideos()（index.html）
// 上游一律是假的：單元測試注入 fetch，整合測試接本機假官網；資料庫變數指向沒人聽的本機 port，絕不碰正式資料庫。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 保險：預設 handler 萬一在設好假官網前被叫到，也只會打到沒人聽的本機 port，不會連正式官網
process.env.SITE_VIDEOS_URL = 'http://127.0.0.1:9/videos.json';
const { createHandler, sanitize, MAX_ITEMS } = require('../api/videos.js');

const BASE = 'https://media.542upup.tw/videos';
const site = (slug, title, file = slug, extra = {}) => ({
  slug, title, preview: `${BASE}/${file}-preview.mp4`, poster: `${BASE}/${file}.jpg`, id: `${BASE}/${file}.mp4`, ...extra
});
// 官網 out/videos.json 的形狀（節錄）
const SITE = {
  items: [
    site('celeb-kuo', '郭昱晴推薦'),
    site('celeb-liu', '劉柏君推薦'),
    site('interview-toutou-4', '《投投告訴你》專訪：發展觀光先解決交通痛點', 'interview-toutou-4-v2'),
    site('interview-henhenwen', '《政治狠狠問》專訪：站路口的三十秒政見', 'interview-henhenwen', {
      wide: { id: `${BASE}/interview-henhenwen-wide.mp4`, poster: `${BASE}/interview-henhenwen-wide.jpg` }
    }),
    site('pottery', '帶潘孟安去捏陶', 'pottery-v2')
  ]
};

// ───────── 小工具 ─────────
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
// 可換回應的假 fetch：next 是函式（每次呼叫）或固定值；記錄每次呼叫
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
// 尊重 abort 的「永遠不回」：逾時時被 abort 才 reject
const hangAbortable = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
});
// 完全不理 abort 的「永遠不回」：只能靠 Promise.race 的計時器脫身
const hangForever = () => new Promise(() => {});

function setup(next, opts = {}) {
  const clock = { t: 1_000_000 };
  const fetch = stub(next);
  const handler = createHandler({ url: 'https://site.test/videos.json', fetch, now: () => clock.t, ttl: 600e3, timeout: 80, retry: 60e3, log: () => {}, ...opts });
  return { clock, fetch, handler };
}
const slugs = (r) => r.body.items.map((v) => v.slug);

// ───────── /api/videos：單元（注入 fetch）─────────
describe('/api/videos 快取與退路', () => {
  it('成功：回清理過的清單、帶公開快取標頭，抓的是設定的網址', async () => {
    const { fetch, handler } = setup(() => json(SITE));
    const r = await call(handler);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { items: sanitize(SITE) });
    assert.deepEqual(slugs(r), ['celeb-kuo', 'celeb-liu', 'interview-toutou-4', 'interview-henhenwen', 'pottery']);
    assert.equal(r.body.stale, undefined);
    assert.equal(r.headers['cache-control'], 'public, max-age=300');
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, 'https://site.test/videos.json');
    assert.equal(fetch.calls[0].init.headers.accept, 'application/json');
    assert.ok(fetch.calls[0].init.signal instanceof AbortSignal);
  });

  it('快取命中：10 分鐘內不再抓上游；過期才重抓並換成新內容', async () => {
    const { clock, fetch, handler } = setup(() => json(SITE));
    await call(handler);
    clock.t += 599e3;
    const hit = await call(handler);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(slugs(hit), slugs({ body: { items: SITE.items } }));
    fetch.next = () => json({ items: [site('new-one', '新影片'), ...SITE.items] });
    clock.t += 2e3;
    const fresh = await call(handler);
    assert.equal(fetch.calls.length, 2);
    assert.equal(fresh.body.items[0].slug, 'new-one');
    assert.equal(fresh.body.stale, undefined);
  });

  it('同時進來的請求共用同一次抓取', async () => {
    let release;
    const { fetch, handler } = setup(() => new Promise((r) => { release = () => r(json(SITE)); }));
    const p = Promise.all([call(handler), call(handler), call(handler)]);
    await new Promise((r) => setImmediate(r));
    release();
    const rs = await p;
    assert.equal(fetch.calls.length, 1);
    for (const r of rs) assert.equal(r.statusCode, 200);
  });

  it('上游壞掉（500、連線錯誤）：回上一份好的並標 stale、no-store；1 分鐘內不重抓，之後恢復', async () => {
    const { clock, fetch, handler } = setup(() => json(SITE));
    const good = await call(handler);
    clock.t += 601e3;
    fetch.next = () => json({ error: 'boom' }, 500);
    const s1 = await call(handler);
    assert.equal(s1.statusCode, 200);
    assert.equal(s1.body.stale, true);
    assert.deepEqual(s1.body.items, good.body.items);
    assert.equal(s1.headers['cache-control'], 'no-store');
    assert.equal(fetch.calls.length, 2);
    // 重試間隔內直接回舊的，不等上游
    clock.t += 30e3;
    const s2 = await call(handler);
    assert.equal(s2.body.stale, true);
    assert.equal(fetch.calls.length, 2);
    // 間隔過了再試：連線錯誤一樣退回舊的
    clock.t += 31e3;
    fetch.next = () => new TypeError('fetch failed');
    const s3 = await call(handler);
    assert.equal(s3.body.stale, true);
    assert.deepEqual(s3.body.items, good.body.items);
    assert.equal(fetch.calls.length, 3);
    // 上游恢復
    clock.t += 61e3;
    fetch.next = () => json({ items: [site('debut', '出場致詞')] });
    const ok = await call(handler);
    assert.equal(ok.body.stale, undefined);
    assert.deepEqual(slugs(ok), ['debut']);
    assert.equal(ok.headers['cache-control'], 'public, max-age=300');
  });

  it('還沒有任何一份時上游壞掉：502 + no-store，重試間隔內不重抓', async () => {
    const { clock, fetch, handler } = setup(() => json({}, 503));
    const r = await call(handler);
    assert.equal(r.statusCode, 502);
    assert.deepEqual(r.body, { error: 'upstream unavailable' });
    assert.equal(r.headers['cache-control'], 'no-store');
    clock.t += 10e3;
    assert.equal((await call(handler)).statusCode, 502);
    assert.equal(fetch.calls.length, 1);
    clock.t += 51e3;
    fetch.next = () => json(SITE);
    assert.equal((await call(handler)).statusCode, 200);
    assert.equal(fetch.calls.length, 2);
  });

  it('上游內容不合格（非 JSON、少 items、items 全無效、太大）：不覆蓋快取', async () => {
    const bad = [
      () => new Response('<html>oops</html>', { status: 200 }),
      () => json({}),
      () => json([site('celeb-kuo', '郭昱晴推薦')]),
      () => json({ items: 'nope' }),
      () => json({ items: [{ slug: 'x', title: '', preview: `${BASE}/x.mp4` }, { slug: 'y', title: 'Y', preview: 'javascript:alert(1)' }] }),
      () => new Response(JSON.stringify({ items: [site('big', 'x'.repeat(300 * 1024))] }), { status: 200 })
    ];
    for (const next of bad) {
      const fresh = setup(next);
      assert.equal((await call(fresh.handler)).statusCode, 502, String(next));
    }
    const { clock, fetch, handler } = setup(() => json(SITE));
    const good = await call(handler);
    for (const next of bad) {
      clock.t += 700e3;
      fetch.next = next;
      const r = await call(handler);
      assert.equal(r.statusCode, 200);
      assert.equal(r.body.stale, true);
      assert.deepEqual(r.body.items, good.body.items);
    }
  });

  it('逾時：上游不回就在 timeout 後放棄（有舊的回舊的，沒有回 502），不論上游理不理 abort', async () => {
    for (const hang of [hangAbortable, hangForever]) {
      const cold = setup(hang);
      const t0 = Date.now();
      const r = await call(cold.handler);
      const took = Date.now() - t0;
      assert.equal(r.statusCode, 502);
      assert.ok(took >= 70 && took < 1500, `took ${took}ms`);
      assert.equal(cold.fetch.calls[0].init.signal.aborted, true);

      const warm = setup(() => json(SITE));
      const good = await call(warm.handler);
      warm.clock.t += 601e3;
      warm.fetch.next = hang;
      const s = await call(warm.handler);
      assert.equal(s.statusCode, 200);
      assert.equal(s.body.stale, true);
      assert.deepEqual(s.body.items, good.body.items);
    }
  });

  it('只收 GET / HEAD', async () => {
    const { fetch, handler } = setup(() => json(SITE));
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await call(handler, m);
      assert.equal(r.statusCode, 405);
      assert.equal(r.headers.allow, 'GET, HEAD');
    }
    assert.equal(fetch.calls.length, 0);
    assert.equal((await call(handler, 'HEAD')).statusCode, 200);
  });
});

describe('sanitize()', () => {
  it('只留 slug/title/preview/poster/id/wide，丟掉不合格的條目', () => {
    const out = sanitize({
      items: [
        { ...site('celeb-kuo', '  郭昱晴推薦  '), provider: 'file', extra: '<b>' },
        { slug: 'no-title', preview: `${BASE}/a.mp4` },
        { slug: 'blank-title', title: '   ', preview: `${BASE}/a.mp4` },
        { slug: 'no-preview', title: 'A' },
        { slug: 'rel-preview', title: 'A', preview: '/videos/a.mp4' },
        { slug: 'js-preview', title: 'A', preview: 'javascript:alert(1)' },
        { slug: 'data-preview', title: 'A', preview: 'data:video/mp4;base64,AAAA' },
        { slug: 'Bad Slug', title: 'A', preview: `${BASE}/a.mp4` },
        { slug: '"><img src=x onerror=alert(1)>', title: 'A', preview: `${BASE}/a.mp4` },
        { title: 'no slug', preview: `${BASE}/a.mp4` },
        site('celeb-kuo', '重複的 slug'),
        null, 'str', 42,
        { slug: 'bad-extras', title: 'B', preview: `${BASE}/b-preview.mp4`, poster: 'ftp://x/y.jpg', id: 'dQw4w9WgXcQ', wide: { id: `${BASE}/w.mp4` } },
        { slug: 'long-title', title: '長'.repeat(500), preview: `${BASE}/c-preview.mp4` }
      ]
    });
    assert.deepEqual(out.map((v) => v.slug), ['celeb-kuo', 'bad-extras', 'long-title']);
    assert.deepEqual(out[0], site('celeb-kuo', '郭昱晴推薦'));
    assert.deepEqual(out[1], { slug: 'bad-extras', title: 'B', preview: `${BASE}/b-preview.mp4` });
    assert.equal(out[2].title.length, 120);
  });

  it('wide 兩個網址都合格才留', () => {
    const [v] = sanitize({ items: [SITE.items[3]] });
    assert.deepEqual(v.wide, SITE.items[3].wide);
  });

  it('最多 MAX_ITEMS 筆', () => {
    const many = Array.from({ length: MAX_ITEMS + 25 }, (_, i) => site('v-' + i, 'V' + i));
    const out = sanitize({ items: many });
    assert.equal(out.length, MAX_ITEMS);
    assert.equal(out[MAX_ITEMS - 1].slug, 'v-' + (MAX_ITEMS - 1));
  });

  it('格式不對或沒有可用條目回 null', () => {
    for (const p of [null, undefined, 'x', 1, [], {}, { items: null }, { items: {} }, { items: [] }, { items: [{ slug: 'a' }] }]) {
      assert.equal(sanitize(p), null, JSON.stringify(p));
    }
  });
});

// ───────── 透過 server.js 的路由（接本機假官網）─────────
describe('server.js 的 /api/videos 路由', () => {
  let upstream, server, port, hits = 0;
  const DB_ENV = /(KV|REDIS|UPSTASH)/;

  before(async () => {
    upstream = http.createServer((req, res) => {
      hits++;
      if (req.url !== '/videos.json') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SITE));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    process.env.SITE_VIDEOS_URL = `http://127.0.0.1:${upstream.address().port}/videos.json`;
    // server.js 會讀 .env（不覆蓋既有變數）：先把資料庫變數換成沒人聽的本機位址，這支測試不會用到資料庫
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
    const r = http.request({ host: '127.0.0.1', port, method, path: '/api/videos', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });

  it('GET 回官網清單，第二次走快取；HEAD 沒有內文', async () => {
    const r = await req('GET');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.deepEqual(JSON.parse(r.text), { items: sanitize(SITE) });
    assert.equal(hits, 1);
    assert.equal((await req('GET')).status, 200);
    assert.equal(hits, 1);
    const h = await req('HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.text, '');
    assert.equal((await req('POST')).status, 405);
  });
});

// ───────── 頁面的 mergeVideos() 與內嵌備援（直接從 index.html 擷取執行）─────────
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mergeSrc = /\/\/ <videos-merge>[^\n]*\n([\s\S]*?)\/\/ <\/videos-merge>/.exec(HTML);
const dataSrc = /<script>\s*(const DATA = [\s\S]*?)<\/script>/.exec(HTML);
const mergeVideos = new Function(mergeSrc[1] + '\nreturn mergeVideos;')();
const DATA = new Function(dataSrc[1] + '\nreturn DATA;')();

// 改版前 index.html 寫死的 18 支（v1–v18，id 換成官網 slug）再加上官網 10/27 已有的劉柏君推薦；
// 島的對照跟改版前一樣，只多了 10/28 依影片內容補掛的陳培瑜推薦（I03）、登記參選（I02、I07、I11）
const P = (f) => `${BASE}/${f}-preview.mp4`;
const ORIGINAL = [
  ['celeb-kuo', '郭昱晴推薦', 'endorse', P('celeb-kuo'), []],
  ['celeb-chen', '陳培瑜推薦', 'endorse', P('celeb-chen'), ['I03']],
  ['celeb-tsai', '蔡其昌推薦', 'endorse', P('celeb-tsai'), []],
  ['celeb-lin', '林楚茵推薦', 'endorse', P('celeb-lin'), []],
  ['celeb-shen', '沈伯洋推薦', 'endorse', P('celeb-shen'), []],
  ['celeb-liu', '劉柏君推薦', 'endorse', P('celeb-liu'), []],
  ['interview-toutou', '《投投告訴你》專訪', 'interview', P('interview-toutou'), []],
  ['interview-toutou-2', '《投投告訴你》專訪：草屯囝仔為何回家', 'interview', P('interview-toutou-2'), ['I03']],
  ['interview-toutou-3', '《投投告訴你》專訪：草鞋墩的由來', 'interview', P('interview-toutou-3'), ['I09']],
  ['interview-toutou-4', '《投投告訴你》專訪：發展觀光先解決交通痛點', 'interview', P('interview-toutou-4-v2'), ['I09', 'I12']],
  ['interview-mnews', '《宵夜鏡來講》專訪：重陽敬老金與深夜共乘', 'interview', P('interview-mnews'), ['I12']],
  ['interview-mnews-2', '《宵夜鏡來講》專訪：投票的感情與理智', 'interview', P('interview-mnews-2'), []],
  ['interview-henhenwen', '《政治狠狠問》專訪：站路口的三十秒政見', 'interview', P('interview-henhenwen'), ['I04']],
  ['debut', '出場致詞', 'trail', P('debut'), []],
  ['registration', '登記參選', 'trail', P('registration'), ['I02', 'I07', 'I11']],
  ['park', '酷比公園', 'trail', P('park'), ['I01']],
  ['breakfast', '南埔早餐', 'trail', P('breakfast'), ['I10']],
  ['mid-autumn', '中秋祝福', 'trail', P('mid-autumn'), []],
  ['pottery', '帶潘孟安去捏陶', 'trail', P('pottery-v2'), ['I09']]
].map(([id, title, kind, url, islands]) => ({ id, title, kind, url, islands }));

describe('mergeVideos()', () => {
  const merge = (items, map = DATA.videoIslands) => mergeVideos(items, map, DATA.videosFallback);

  it('官網連不上（null／空／壞資料）時用內嵌備援，片單跟改版前一樣（多了劉柏君推薦），島的對照照 videoIslands', () => {
    for (const items of [null, undefined, [], 'x', [{ slug: 'Bad', title: 'x', preview: `${BASE}/a.mp4` }]]) {
      assert.deepEqual(merge(items), ORIGINAL);
    }
  });

  it('官網清單：片名與順序跟官網走，新片自動出現、依 slug 分類，對照表的島照樣掛上', () => {
    const out = merge(sanitize(SITE));
    assert.deepEqual(out, [
      { id: 'celeb-kuo', title: '郭昱晴推薦', kind: 'endorse', url: P('celeb-kuo'), islands: [] },
      { id: 'celeb-liu', title: '劉柏君推薦', kind: 'endorse', url: P('celeb-liu'), islands: [] },
      { id: 'interview-toutou-4', title: '《投投告訴你》專訪：發展觀光先解決交通痛點', kind: 'interview', url: P('interview-toutou-4-v2'), islands: ['I09', 'I12'] },
      { id: 'interview-henhenwen', title: '《政治狠狠問》專訪：站路口的三十秒政見', kind: 'interview', url: P('interview-henhenwen'), islands: ['I04'] },
      { id: 'pottery', title: '帶潘孟安去捏陶', kind: 'trail', url: P('pottery-v2'), islands: ['I09'] }
    ]);
  });

  it('對照表可覆寫 kind；不合法的 kind 不理，改看 slug', () => {
    const map = { park: { islands: ['I01'], kind: 'interview' }, debut: { kind: 'constructor' }, 'celeb-kuo': { kind: 'trail' } };
    const out = merge([site('park', '酷比公園'), site('debut', '出場致詞'), site('celeb-kuo', '郭昱晴推薦'), site('other', '其他')], map);
    assert.deepEqual(out.map((v) => [v.id, v.kind, v.islands]), [
      ['park', 'interview', ['I01']], ['debut', 'trail', []], ['celeb-kuo', 'trail', []], ['other', 'trail', []]
    ]);
  });

  it('跳過不合格與重複的條目、不被 Object.prototype 的名字騙到，回傳的 islands 是複本', () => {
    const out = merge([
      site('constructor', '名字剛好是 constructor'),
      site('pottery', '帶潘孟安去捏陶', 'pottery-v2'),
      site('pottery', '重複'),
      { slug: 'no-preview', title: 'x' },
      { slug: 'js', title: 'x', preview: 'javascript:alert(1)' },
      { slug: 'UPPER', title: 'x', preview: `${BASE}/a.mp4` },
      null
    ]);
    assert.deepEqual(out.map((v) => v.id), ['constructor', 'pottery']);
    assert.deepEqual(out[0].islands, []);
    out[1].islands.push('I99');
    assert.deepEqual(DATA.videoIslands.pottery.islands, ['I09']);
  });

  it('對照表的 slug 合格、島的 id 都存在；DATA.videos 在載入前是空的（由 module 填）', () => {
    const ids = new Set(DATA.islands.map((d) => d.id));
    for (const [slug, m] of Object.entries(DATA.videoIslands)) {
      assert.match(slug, /^[a-z0-9][a-z0-9-]*$/);
      for (const id of m.islands || []) assert.ok(ids.has(id), `${slug} → ${id} 不存在`);
    }
    assert.deepEqual(DATA.videoIslands['food-tour'].islands, ['I08', 'I09']); // 備援沒有這支，靠官網清單帶進來
    assert.deepEqual(DATA.videos, []);
    assert.match(HTML, /DATA\.videos = mergeVideos\(await siteVideos, DATA\.videoIslands, DATA\.videosFallback\);\n\s*init\(\);/);
  });
});
