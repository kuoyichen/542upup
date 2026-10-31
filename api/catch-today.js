// 捕捉媛婷：今天小媛婷躲在哪座島，以 LINE bot 為準（bot 規格見 yuanting-line 的 catch-share-api.md §1）
//   GET /api/catch-today   { active: false } 或 { active: true, date, island, claim_url, expires_at }
// 在伺服器端向 bot 的 GET /api/catch/today 查（瀏覽器不直接連 bot，也不需 CORS），網址可用環境變數 CATCH_TODAY_URL 換掉。
// 記憶體快取 60 秒；快取裡的 active 資料一到 expires_at 就不再使用，不管有沒有滿 60 秒。
// 上游只收：HTTP 200、JSON 合格（5 秒逾時、16 KB 上限）。active 不是 true 一律當今天沒有分身；
// active 為 true 時每個欄位都嚴格檢查，任何一項不合就整筆當失敗。claim_url 一個字元都不動，原樣傳給頁面。
// 重新查詢失敗時：上一份 active 資料還沒到 expires_at 就繼續用；已過期或從沒成功過就回 { active: false }。
// 失敗後 10 秒內不再重抓，避免 bot 掛掉時每個訪客都卡 5 秒。這支一律回 200，頁面只看 active。
const DEFAULT_URL = 'https://line.542upup.tw/api/catch/today';
const TTL = 60e3;
const TIMEOUT = 5e3;
const RETRY = 10e3;
const MAX_BYTES = 16 * 1024;
const MAX_URL = 2000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISLAND_ID = /^I(0[1-9]|1[0-2])$/;
const CLAIM_URL = /^https:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/; // \s 已含 U+2028 / U+2029

const INACTIVE = { active: false };

// bot 回來的 JSON → { active: false } 或乾淨的 active 資料（附 exp：expires_at 的毫秒值）；格式不對回 null
// now 是目前時間（毫秒）：expires_at 必須在它之後，否則整筆不收
function validate(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.active !== true) return { active: false };
  const { date, island, claim_url, expires_at } = payload;
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) return null;
  if (typeof island !== 'string' || !ISLAND_ID.test(island)) return null;
  if (typeof claim_url !== 'string' || claim_url.length > MAX_URL || !CLAIM_URL.test(claim_url)) return null;
  if (typeof expires_at !== 'string') return null;
  const exp = Date.parse(expires_at);
  if (Number.isNaN(exp) || exp <= now) return null;
  return { active: true, date, island, claim_url, expires_at, exp };
}

// 測試可注入 url / fetch / now / ttl / timeout / retry / log；正式環境用預設值
function createHandler(opts = {}) {
  const urlOf = () => opts.url || process.env.CATCH_TODAY_URL || DEFAULT_URL; // 每次抓時才讀，測試可先 require 再設環境變數
  const ttl = opts.ttl ?? TTL, timeout = opts.timeout ?? TIMEOUT, retry = opts.retry ?? RETRY;
  const now = opts.now || Date.now;
  const log = opts.log || ((msg) => console.error(msg));
  let cache = null;    // { data, at }：上一份成功的結果（data 是 { active: false } 或 active 資料）
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
      if (r.status !== 200) throw new Error('upstream ' + r.status);
      const text = await r.text();
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('upstream too large');
      let json;
      try { json = JSON.parse(text); } catch (e) { throw new Error('upstream bad json'); }
      const data = validate(json, now());
      if (!data) throw new Error('upstream invalid');
      return data;
    })();
    run.catch(() => {}); // 逾時後才失敗的那次不要變成 unhandled rejection
    try {
      return await Promise.race([run, timeoutP]);
    } finally {
      clearTimeout(timer);
    }
  }

  // 目前能給頁面的資料：永遠回 { active: false } 或完整的 active 資料，不丟錯
  const usable = (t) => (cache && (!cache.data.active || t < cache.data.exp) ? cache.data : INACTIVE);

  async function load() {
    const t = now();
    const live = cache && (!cache.data.active || t < cache.data.exp); // active 資料到 expires_at 就作廢
    if (live && t - cache.at < ttl) return cache.data;
    if (t - failedAt < retry) return usable(t);
    if (!inflight) {
      inflight = fetchOnce()
        .then((data) => { cache = { data, at: now() }; failedAt = -Infinity; })
        .catch((e) => { failedAt = now(); log('catch-today upstream: ' + (e && e.message)); })
        .finally(() => { inflight = null; });
    }
    await inflight;
    return usable(now());
  }

  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(405).json({ error: 'method not allowed' });
    }
    const d = await load();
    res.setHeader('Cache-Control', 'no-store');
    // 只送 bot 規格裡的欄位，內部用的 exp 不外傳
    return res.status(200).json(d.active
      ? { active: true, date: d.date, island: d.island, claim_url: d.claim_url, expires_at: d.expires_at }
      : { active: false });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.validate = validate;
