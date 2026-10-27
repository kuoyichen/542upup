// 影音紀錄：官網 542upup.tw 的影片清單，島上的「影音紀錄」以它為準（片名、順序、新片都跟官網走）
//   GET /api/videos   { items: [{ slug, title, preview, poster?, id?, wide? }], stale? }
// 官網 build 時由 app/content/zh.ts 產生 /videos.json；這裡在伺服器端抓（不需 CORS），記憶體快取約 10 分鐘。
// 抓失敗或逾時（5 秒）就回上一份好的（stale: true）；一份都沒有時回 502，頁面改用 index.html 內嵌的備援清單。
// 失敗後 1 分鐘內不再重抓，避免官網掛掉時每個訪客都卡 5 秒。網址可用環境變數 SITE_VIDEOS_URL 換掉。
const DEFAULT_URL = 'https://542upup.tw/videos.json';
const TTL = 10 * 60e3;
const TIMEOUT = 5e3;
const RETRY = 60e3;
const MAX_ITEMS = 60;
const MAX_BYTES = 256 * 1024;
const MAX_TITLE = 120;
const MAX_URL = 500;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

// 測試可注入 url / fetch / now / ttl / timeout / retry / log；正式環境用預設值
function createHandler(opts = {}) {
  const urlOf = () => opts.url || process.env.SITE_VIDEOS_URL || DEFAULT_URL; // 每次抓時才讀，測試可先 require 再設環境變數
  const ttl = opts.ttl ?? TTL, timeout = opts.timeout ?? TIMEOUT, retry = opts.retry ?? RETRY;
  const now = opts.now || Date.now;
  const log = opts.log || ((msg) => console.error(msg));
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
module.exports.MAX_ITEMS = MAX_ITEMS;
