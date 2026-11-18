// 媛婷手機提詞頁：GET /api/ask-now → { now: [{ id, text, name, vil, origin, votes }] }
// 目前「已抽出、還沒處理」的題目（K.DRAWN）。內容本來就公開，不需登入。
// 讀法很輕（不走 readAll）；伺服器端快取 2 秒，快取失效時同時進來的請求共用同一次讀取。
// 註：假 Upstash 沒有 HMGET，所以用 pipeline 內逐筆 HGET，語意相同。
const { configured, redis } = require('./_redis');
const A = require('./_ask');

const NOW_CACHE_MS = 2000;
let cache = null, gen = 0, inflight = null;
const reset = () => { cache = null; gen++; inflight = null; };
A.onInvalidate(reset);

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

async function load(g) {
  const [drawn] = await redis([['SMEMBERS', A.K.DRAWN]]);
  const ids = Array.isArray(drawn) ? drawn : [];
  let now = [];
  if (ids.length) {
    const r = await redis([...ids.map((id) => ['HGET', A.K.Q, id]), ...ids.map((id) => ['HGET', A.K.VC, id]), ['SMEMBERS', A.K.HIDDEN]]);
    const hidden = new Set(r[ids.length * 2] || []);
    const rows = [];
    ids.forEach((id, i) => {
      const q = parse(r[i]);
      if (!q || typeof q !== 'object' || Array.isArray(q) || typeof q.text !== 'string' || hidden.has(id)) return;
      rows.push({ t: Number(q.t) || 0, item: {
        id, text: q.text, name: q.name || '匿名鎮民', vil: q.vil || '',
        origin: q.origin || 'ask', votes: Number(r[ids.length + i]) || 0,
      } });
    });
    now = rows.sort((a, b) => b.t - a.t).map((x) => x.item);
  }
  const v = { now };
  if (g === gen) cache = { at: Date.now(), v };
  return v;
}

async function read() {
  if (cache && Date.now() - cache.at < NOW_CACHE_MS) return cache.v;
  if (!inflight) {
    const p = load(gen).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
  }
  return inflight;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method not allowed' }); }
  try {
    return res.status(200).json(await read());
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
module.exports._resetNowCache = reset;
