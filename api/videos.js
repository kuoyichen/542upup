// 影音紀錄：官網 542upup.tw 的影片清單，島上的「影音紀錄」以它為準（片名、順序、新片都跟官網走）
//   GET /api/videos   { items: [{ slug, title, preview, poster?, id?, wide? }], stale? }
// 官網 build 時由 app/content/zh.ts 產生 /videos.json；這裡在伺服器端抓（不需 CORS），記憶體快取約 10 分鐘。
// 抓失敗或逾時（5 秒）就回上一份好的（stale: true）；一份都沒有時回 502，頁面改用 index.html 內嵌的備援清單。
// 失敗後 1 分鐘內不再重抓，避免官網掛掉時每個訪客都卡 5 秒。網址可用環境變數 SITE_VIDEOS_URL 換掉。
// 每日判讀的島歸屬存在 Upstash hash 542upup:video-islands（slug → {islands, reason, t, by}）；
// 重抓官網清單時一併讀（同一輪快取），有合格的 islands 就掛到該片；沒設資料庫或讀失敗只是不掛，絕不影響清單。
const DEFAULT_URL = 'https://542upup.tw/videos.json';
const TTL = 10 * 60e3;
const TIMEOUT = 5e3;
const RETRY = 60e3;
const MAX_ITEMS = 60;
const MAX_BYTES = 256 * 1024;
const MAX_TITLE = 120;
const MAX_URL = 500;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISLAND_ID = /^I\d{2}$/;
const MAX_ISLANDS = 6;
const ISLANDS_KEY = '542upup:video-islands';

const httpUrl = (s) => {
  if (typeof s !== 'string' || !s || s.length > MAX_URL) return false;
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch (e) { return false; }
};

// 官網回來的 JSON → 乾淨的清單；格式不對回 null（不覆蓋快取）
// 沒有片名、沒有 http(s) 預覽檔、slug 不合格或重複的條目丟掉；最多 MAX_ITEMS 筆
function sanitize(payload) {
  const list = payload && typeof payload === 'object' && Array.isArray(payload.items) ? payload.items : null;
  if (!list) return null;
  const out = [];
  const seen = new Set();
  for (const v of list) {
    if (out.length >= MAX_ITEMS) break;
    if (!v || typeof v !== 'object') continue;
    const title = typeof v.title === 'string' ? v.title.trim().slice(0, MAX_TITLE) : '';
    const slug = typeof v.slug === 'string' ? v.slug : '';
    if (!title || !httpUrl(v.preview) || !SLUG.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const item = { slug, title, preview: v.preview };
    if (httpUrl(v.poster)) item.poster = v.poster;
    if (httpUrl(v.id)) item.id = v.id;
    if (v.wide && typeof v.wide === 'object' && httpUrl(v.wide.id) && httpUrl(v.wide.poster)) item.wide = { id: v.wide.id, poster: v.wide.poster };
    out.push(item);
  }
  return out.length ? out : null;
}

// Upstash HGETALL 的攤平陣列 [slug, json, ...] → { slug: ['I08', ...] }
// 只取 islands：JSON 壞掉、不是陣列、slug 不合格的整筆略過；島 id 只收 /^I\d{2}$/、去重、最多 MAX_ISLANDS 座。
// islands 為 [] 是「已判讀、沒有對應島」，照樣保留。reason / t / by 一律不外傳
function parseIslands(flat) {
  const out = {};
  const a = Array.isArray(flat) ? flat : [];
  for (let i = 0; i + 1 < a.length; i += 2) {
    const slug = a[i];
    if (typeof slug !== 'string' || !SLUG.test(slug)) continue;
    let r;
    try { r = JSON.parse(a[i + 1]); } catch (e) { continue; }
    if (!r || typeof r !== 'object' || !Array.isArray(r.islands)) continue;
    const ids = [];
    for (const id of r.islands) {
      if (ids.length >= MAX_ISLANDS) break;
      if (typeof id === 'string' && ISLAND_ID.test(id) && !ids.includes(id)) ids.push(id);
    }
    out[slug] = ids;
  }
  return out;
}

// 測試可注入 url / fetch / redis / now / ttl / timeout / retry / log；正式環境用預設值
function createHandler(opts = {}) {
  const urlOf = () => opts.url || process.env.SITE_VIDEOS_URL || DEFAULT_URL; // 每次抓時才讀，測試可先 require 再設環境變數
  const ttl = opts.ttl ?? TTL, timeout = opts.timeout ?? TIMEOUT, retry = opts.retry ?? RETRY;
  const now = opts.now || Date.now;
  const log = opts.log || ((msg) => console.error(msg));
  // 讀 video-islands：未設資料庫、逾時、出錯一律回 null（呼叫端當作沒有），不丟錯。opts.redis 供測試注入
  async function readIslands() {
    let timer;
    try {
      const rd = opts.redis ? { configured: () => true, redis: opts.redis } : require('./_redis');
      if (!rd.configured()) return null;
      const timeoutP = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeout / 2); }); // 比整體逾時短，Upstash 卡住也不拖垮官網清單
      const run = rd.redis([['HGETALL', ISLANDS_KEY]]);
      run.catch(() => {});
      const [flat] = await Promise.race([run, timeoutP]);
      return parseIslands(flat);
    } catch (e) {
      log('videos islands: ' + (e && e.message));
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  let cache = null;    // { items, at }：上一份好的清單
  let failedAt = -Infinity;
  let inflight = null; // 同時進來的請求共用同一次抓取

  async function fetchOnce() {
    const doFetch = opts.fetch || globalThis.fetch;
    const ctrl = new AbortController();
    let timer;
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, timeout);
    });
    const islandsP = readIslands(); // 與官網清單同時讀；永不 reject
    const run = (async () => {
      const r = await doFetch(urlOf(), {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': '542upup-island (+https://island.542upup.tw)' }
      });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const text = await r.text();
      if (text.length > MAX_BYTES) throw new Error('upstream too large');
      const items = sanitize(JSON.parse(text));
      if (!items) throw new Error('upstream invalid');
      const islands = await islandsP;
      if (islands) for (const it of items) if (Object.prototype.hasOwnProperty.call(islands, it.slug)) it.islands = islands[it.slug];
      return items;
    })();
    run.catch(() => {}); // 逾時後才失敗的那次不要變成 unhandled rejection
    try {
      return await Promise.race([run, timeoutP]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    const t = now();
    if (cache && t - cache.at < ttl) return { items: cache.items };
    if (t - failedAt < retry) return cache ? { items: cache.items, stale: true } : null;
    if (!inflight) {
      inflight = fetchOnce()
        .then((items) => { cache = { items, at: now() }; failedAt = -Infinity; })
        .catch((e) => { failedAt = now(); log('videos upstream: ' + (e && e.message)); })
        .finally(() => { inflight = null; });
    }
    const before = cache;
    await inflight;
    if (cache && cache !== before) return { items: cache.items };
    return cache ? { items: cache.items, stale: true } : null;
  }

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(405).json({ error: 'method not allowed' });
    }
    const out = await load();
    if (!out) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'upstream unavailable' });
    }
    res.setHeader('Cache-Control', out.stale ? 'no-store' : 'public, max-age=300');
    return res.status(200).json(out.stale ? { items: out.items, stale: true } : { items: out.items });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.sanitize = sanitize;
module.exports.parseIslands = parseIslands;
module.exports.MAX_ITEMS = MAX_ITEMS;
