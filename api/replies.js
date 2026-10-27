// 留言瓶回覆（公開唯讀）：媛婷在 /reply 後台寫的回覆，島上打開瓶子時顯示
//   GET /api/replies   { replies: { 瓶子id: { text, t } } }，只回保留中（最新 200 則）瓶子的回覆
// 寫入走 /api/admin（需登入）。資料在 hash 542upup:replies（瓶子id → JSON）。
const { P, configured, redis } = require('./_redis');

const KEY = P + 'replies';
const BOTTLES = P + 'bottles';
const KEEP = 200; // 同 bottles.js 保留則數

// Upstash REST 的 HGETALL 回傳攤平陣列 [k1, v1, k2, v2, ...]
function parseReplies(flat) {
  const out = {};
  const a = Array.isArray(flat) ? flat : [];
  for (let i = 0; i + 1 < a.length; i += 2) {
    try {
      const r = JSON.parse(a[i + 1]);
      if (r && typeof r.text === 'string' && r.text) out[String(a[i])] = { text: r.text, t: Number(r.t) || 0 };
    } catch (e) { /* 壞資料略過 */ }
  }
  return out;
}
// LRANGE 結果 → 保留中瓶子的 id
function bottleIds(list) {
  const ids = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    try { const b = JSON.parse(s); if (b && typeof b.id === 'string') ids.add(b.id); } catch (e) { /* 壞資料略過 */ }
  }
  return ids;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(503).json({ error: 'not configured' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method not allowed' }); }
  try {
    const [list, flat] = await redis([['LRANGE', BOTTLES, 0, KEEP - 1], ['HGETALL', KEY]]);
    const ids = bottleIds(list), all = parseReplies(flat), replies = {};
    for (const id of Object.keys(all)) if (ids.has(id)) replies[id] = all[id];
    return res.status(200).json({ replies });
  } catch (e) {
    return res.status(502).json({ error: 'storage error' });
  }
};
module.exports.parseReplies = parseReplies;
module.exports.bottleIds = bottleIds;
